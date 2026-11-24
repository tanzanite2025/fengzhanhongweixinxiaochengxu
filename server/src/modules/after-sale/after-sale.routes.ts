import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError, CriticalError } from '../../lib/errors.js';
import { AuthService } from '../auth/auth.service.js';
import { verifyAndDecryptWechatCallback } from '../wechat-pay/wechat-callback.js';
import {
  WechatPayService,
  type WechatRefundSuccessPayload
} from '../wechat-pay/wechat-pay.service.js';

const createAfterSaleBody = z.object({
  orderId: z.number().int().positive(),
  type: z.enum(['REFUND_ONLY', 'RETURN_AND_REFUND']),
  reason: z.string().min(2).max(100),
  description: z.string().max(300).optional()
});

const rejectAfterSaleBody = z.object({
  rejectReason: z.string().min(2).max(200)
});

function generateNo(prefix: string): string {
  return `${prefix}${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

/**
 * Register buyer and admin after-sale refund routes and WeChat Pay refund callback.
 */
export function registerAfterSaleRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  authService: AuthService,
  wechatPay: WechatPayService
): void {
  // Buyer: apply for refund / return-and-refund
  app.post('/api/after-sales', { preHandler: authService.requireUserAuth }, async (request, reply) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const body = createAfterSaleBody.parse(request.body);

    const order = await prisma.order.findFirst({
      where: { id: body.orderId, userId: request.authUserId }
    });
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }
    if (!['PENDING_SHIPMENT', 'SHIPPED', 'COMPLETED'].includes(order.status)) {
      throw new AppError(400, 'CANNOT_APPLY_AFTER_SALE', '当前订单状态不支持申请售后');
    }
    if (order.status === 'PENDING_SHIPMENT' && body.type !== 'REFUND_ONLY') {
      throw new AppError(400, 'INVALID_AFTER_SALE_TYPE', '未发货订单仅支持申请仅退款');
    }

    const activeExisting = await prisma.afterSaleOrder.findFirst({
      where: {
        orderId: order.id,
        status: { in: ['PENDING_REVIEW', 'APPROVED_REFUNDING', 'REFUNDED'] }
      }
    });
    if (activeExisting) {
      throw new AppError(409, 'AFTER_SALE_EXISTS', '该订单已有进行中或已完成的售后单');
    }

    const created = await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'REFUND_REQUESTED' }
      });

      return tx.afterSaleOrder.create({
        data: {
          afterSaleNo: generateNo('AS'),
          outRefundNo: generateNo('RF'),
          orderId: order.id,
          userId: request.authUserId!,
          type: body.type,
          status: 'PENDING_REVIEW',
          reason: body.reason,
          description: body.description ?? null,
          refundAmountCents: order.totalAmountCents
        }
      });
    });

    return reply.status(201).send(created);
  });

  // Admin: list after-sale orders
  app.get(
    '/api/admin/after-sales',
    { preHandler: authService.requireAdminPermission('after_sales:manage') },
    async (request) => {
      const query = z.object({ status: z.string().optional() }).parse(request.query);
      return prisma.afterSaleOrder.findMany({
        where: query.status && query.status !== 'ALL' ? { status: query.status } : {},
        include: {
          order: { include: { items: true } },
          user: { select: { id: true, nickname: true } }
        },
        orderBy: { id: 'desc' }
      });
    }
  );

  // Admin: approve and execute WeChat Pay V3 refund
  app.post(
    '/api/admin/after-sales/:id/approve',
    { preHandler: authService.requireAdminPermission('after_sales:manage') },
    async (request) => {
      if (!request.authAdmin) throw new CriticalError('authAdmin missing');
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);

      const afterSale = await prisma.afterSaleOrder.findUnique({
        where: { id: params.id },
        include: { order: { include: { items: true } } }
      });
      if (!afterSale) {
        throw new AppError(404, 'AFTER_SALE_NOT_FOUND', '售后单不存在');
      }
      if (afterSale.status !== 'PENDING_REVIEW') {
        throw new AppError(400, 'INVALID_AFTER_SALE_STATUS', '当前售后单状态不可审核通过');
      }

      // Atomically claim approval lock before calling external WeChat refund API
      const lock = await prisma.afterSaleOrder.updateMany({
        where: { id: afterSale.id, status: 'PENDING_REVIEW' },
        data: {
          status: 'APPROVED_REFUNDING',
          reviewedBy: request.authAdmin!.username,
          reviewedAt: new Date()
        }
      });
      if (lock.count !== 1) {
        throw new AppError(409, 'AFTER_SALE_CONFLICT', '该售后单正在被其他管理员处理或状态已变更');
      }

      let refundRes: { refundId: string; status: string };
      try {
        refundRes = await wechatPay.createRefund({
          outTradeNo: afterSale.order.orderNo,
          outRefundNo: afterSale.outRefundNo,
          refundAmountCents: afterSale.refundAmountCents,
          totalAmountCents: afterSale.order.totalAmountCents,
          reason: afterSale.reason
        });
      } catch (err) {
        // Release lock back to PENDING_REVIEW if external refund call fails
        await prisma.afterSaleOrder.updateMany({
          where: { id: afterSale.id, status: 'APPROVED_REFUNDING' },
          data: {
            status: 'PENDING_REVIEW',
            reviewedBy: null,
            reviewedAt: null
          }
        });
        throw err;
      }

      const immediateSuccess = refundRes.status === 'SUCCESS';

      return prisma.$transaction(async (tx) => {
        const updatedAfterSale = await tx.afterSaleOrder.update({
          where: { id: afterSale.id },
          data: {
            status: immediateSuccess ? 'REFUNDED' : 'APPROVED_REFUNDING',
            wechatRefundId: refundRes.refundId,
            ...(immediateSuccess ? { refundedAt: new Date() } : {})
          }
        });

        if (immediateSuccess) {
          await finalizeOrderRefundInTx(tx, afterSale.order.id);
        }

        return updatedAfterSale;
      });
    }
  );

  // Admin: reject after-sale and restore previous order state
  app.post(
    '/api/admin/after-sales/:id/reject',
    { preHandler: authService.requireAdminPermission('after_sales:manage') },
    async (request) => {
      if (!request.authAdmin) throw new CriticalError('authAdmin missing');
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const body = rejectAfterSaleBody.parse(request.body);

      const afterSale = await prisma.afterSaleOrder.findUnique({
        where: { id: params.id },
        include: { order: true }
      });
      if (!afterSale) {
        throw new AppError(404, 'AFTER_SALE_NOT_FOUND', '售后单不存在');
      }
      if (afterSale.status !== 'PENDING_REVIEW') {
        throw new AppError(400, 'INVALID_AFTER_SALE_STATUS', '当前售后单状态不可驳回');
      }

      const restoredOrderStatus = afterSale.order.completedAt
        ? 'COMPLETED'
        : afterSale.order.shippedAt
          ? 'SHIPPED'
          : 'PENDING_SHIPMENT';

      return prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: afterSale.order.id },
          data: { status: restoredOrderStatus }
        });

        return tx.afterSaleOrder.update({
          where: { id: afterSale.id },
          data: {
            status: 'REJECTED',
            rejectReason: body.rejectReason,
            reviewedBy: request.authAdmin!.username,
            reviewedAt: new Date()
          }
        });
      });
    }
  );

  // WeChat Pay V3 refund notification callback
  app.post('/api/wechat/refund-notify', async (request, reply) => {
    const { payload } = verifyAndDecryptWechatCallback<WechatRefundSuccessPayload>(
      request,
      wechatPay,
      'REFUND.SUCCESS'
    );

    if (payload) {
      const afterSale = await prisma.afterSaleOrder.findUnique({
        where: { outRefundNo: payload.out_refund_no }
      });
      if (!afterSale) {
        throw new CriticalError(`WeChat refund callback for unknown outRefundNo: ${payload.out_refund_no}`);
      }
      if (afterSale.status !== 'REFUNDED') {
        await prisma.$transaction(async (tx) => {
          await tx.afterSaleOrder.update({
            where: { id: afterSale.id },
            data: {
              status: 'REFUNDED',
              wechatRefundId: payload.refund_id,
              refundedAt: new Date()
            }
          });
          await finalizeOrderRefundInTx(tx, afterSale.orderId);
        });
      }
    }

    return reply.status(200).send({ code: 'SUCCESS', message: '成功' });
  });
}

async function finalizeOrderRefundInTx(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  orderId: number
): Promise<void> {
  const updated = await tx.order.updateMany({
    where: { id: orderId, status: { not: 'REFUNDED' } },
    data: { status: 'REFUNDED' }
  });
  if (updated.count === 0) {
    return;
  }

  const orderItems = await tx.orderItem.findMany({ where: { orderId } });
  for (const item of orderItems) {
    await tx.productSku.update({
      where: { id: item.skuId },
      data: { stock: { increment: item.quantity } }
    });
    const product = await tx.product.findUnique({ where: { id: item.productId } });
    if (product) {
      await tx.product.update({
        where: { id: item.productId },
        data: { salesCount: Math.max(0, product.salesCount - item.quantity) }
      });
    }
  }
}
