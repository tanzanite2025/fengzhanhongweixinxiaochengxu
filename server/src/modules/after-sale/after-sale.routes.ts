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

const approveAfterSaleBody = z
  .object({
    refundAmountCents: z.number().int().positive().optional()
  })
  .optional();

const rejectAfterSaleBody = z.object({
  rejectReason: z.string().min(2).max(200)
});

function generateNo(prefix: string): string {
  return `${prefix}${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function computeRestoredOrderStatus(order: { completedAt: Date | null; shippedAt: Date | null }): string {
  if (order.completedAt) return 'COMPLETED';
  if (order.shippedAt) return 'SHIPPED';
  return 'PENDING_SHIPMENT';
}

type PrismaTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Shared atomic refund execution handler for both initial approval (PENDING_REVIEW)
 * and failed-refund retry (REFUND_FAILED with a fresh outRefundNo).
 */
async function executeAfterSaleRefund(options: {
  prisma: PrismaClient;
  wechatPay: WechatPayService;
  afterSaleId: number;
  expectedFromStatus: 'PENDING_REVIEW' | 'REFUND_FAILED';
  requestedRefundCents: number | undefined;
  adminUsername: string;
  rotateOutRefundNo: boolean;
}) {
  const {
    prisma,
    wechatPay,
    afterSaleId,
    expectedFromStatus,
    requestedRefundCents,
    adminUsername,
    rotateOutRefundNo
  } = options;

  const afterSale = await prisma.afterSaleOrder.findUnique({
    where: { id: afterSaleId },
    include: { order: { include: { items: true } } }
  });
  if (!afterSale) {
    throw new AppError(404, 'AFTER_SALE_NOT_FOUND', '售后单不存在');
  }
  if (afterSale.status !== expectedFromStatus) {
    throw new AppError(400, 'INVALID_AFTER_SALE_STATUS', '当前售后单状态不可执行该退款操作');
  }

  const finalRefundCents = requestedRefundCents ?? afterSale.refundAmountCents;
  if (finalRefundCents <= 0 || finalRefundCents > afterSale.order.totalAmountCents) {
    throw new AppError(
      400,
      'INVALID_REFUND_AMOUNT',
      `实退金额必须在 0.01 元至订单总额 ¥${(afterSale.order.totalAmountCents / 100).toFixed(2)} 之间`
    );
  }

  const nextOutRefundNo = rotateOutRefundNo ? generateNo('RF') : afterSale.outRefundNo;

  const lock = await prisma.afterSaleOrder.updateMany({
    where: { id: afterSale.id, status: expectedFromStatus },
    data: {
      status: 'APPROVED_REFUNDING',
      outRefundNo: nextOutRefundNo,
      refundAmountCents: finalRefundCents,
      rejectReason: null,
      reviewedBy: adminUsername,
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
      outRefundNo: nextOutRefundNo,
      refundAmountCents: finalRefundCents,
      totalAmountCents: afterSale.order.totalAmountCents,
      reason: afterSale.reason
    });
  } catch (err) {
    // Release lock cleanly on synchronous refund rejection/error
    await prisma.afterSaleOrder.updateMany({
      where: { id: afterSale.id, status: 'APPROVED_REFUNDING' },
      data: {
        status: expectedFromStatus,
        outRefundNo: afterSale.outRefundNo,
        refundAmountCents: afterSale.refundAmountCents,
        reviewedBy: expectedFromStatus === 'PENDING_REVIEW' ? null : afterSale.reviewedBy,
        reviewedAt: expectedFromStatus === 'PENDING_REVIEW' ? null : afterSale.reviewedAt
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
      await finalizeOrderRefundInTx(tx, afterSale.order.id, {
        type: afterSale.type,
        refundAmountCents: finalRefundCents
      });
    }

    return updatedAfterSale;
  });
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
  // Buyer: apply for refund / return-and-refund (atomic inside tx to prevent concurrent duplicates or ship races)
  app.post('/api/after-sales', { preHandler: authService.requireUserAuth }, async (request, reply) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const body = createAfterSaleBody.parse(request.body);

    const created = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: body.orderId, userId: request.authUserId! }
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

      const activeExisting = await tx.afterSaleOrder.findFirst({
        where: {
          orderId: order.id,
          status: { in: ['PENDING_REVIEW', 'APPROVED_REFUNDING', 'REFUNDED', 'REFUND_FAILED'] }
        }
      });
      if (activeExisting) {
        throw new AppError(409, 'AFTER_SALE_EXISTS', '该订单已有进行中或已完成的售后单');
      }

      const claimed = await tx.order.updateMany({
        where: {
          id: order.id,
          userId: request.authUserId!,
          status: { in: ['PENDING_SHIPMENT', 'SHIPPED', 'COMPLETED'] }
        },
        data: { status: 'REFUND_REQUESTED' }
      });
      if (claimed.count !== 1) {
        throw new AppError(409, 'ORDER_STATUS_CHANGED', '订单状态已变更，请刷新后重试');
      }

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

  // Buyer: withdraw a PENDING_REVIEW after-sale application and restore previous order state
  app.post(
    '/api/after-sales/:id/cancel',
    { preHandler: authService.requireUserAuth },
    async (request) => {
      if (!request.authUserId) throw new CriticalError('authUserId missing');
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);

      const afterSale = await prisma.afterSaleOrder.findFirst({
        where: { id: params.id, userId: request.authUserId },
        include: { order: true }
      });
      if (!afterSale) {
        throw new AppError(404, 'AFTER_SALE_NOT_FOUND', '售后单不存在');
      }
      if (afterSale.status !== 'PENDING_REVIEW') {
        throw new AppError(400, 'INVALID_AFTER_SALE_STATUS', '仅待审核状态的售后单可撤销申请');
      }

      const restoredOrderStatus = computeRestoredOrderStatus(afterSale.order);
      return prisma.$transaction(async (tx) => {
        const claimed = await tx.afterSaleOrder.updateMany({
          where: { id: afterSale.id, userId: request.authUserId!, status: 'PENDING_REVIEW' },
          data: { status: 'CANCELLED' }
        });
        if (claimed.count !== 1) {
          throw new AppError(409, 'INVALID_AFTER_SALE_STATUS', '售后单状态已变更，无法撤销');
        }

        await tx.order.updateMany({
          where: { id: afterSale.orderId, status: 'REFUND_REQUESTED' },
          data: { status: restoredOrderStatus }
        });

        return tx.afterSaleOrder.findUniqueOrThrow({ where: { id: afterSale.id } });
      });
    }
  );

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

  // Admin: approve PENDING_REVIEW after-sale and execute WeChat Pay V3 refund
  app.post(
    '/api/admin/after-sales/:id/approve',
    { preHandler: authService.requireAdminPermission('after_sales:manage') },
    async (request) => {
      if (!request.authAdmin) throw new CriticalError('authAdmin missing');
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const body = approveAfterSaleBody.parse(request.body);

      return executeAfterSaleRefund({
        prisma,
        wechatPay,
        afterSaleId: params.id,
        expectedFromStatus: 'PENDING_REVIEW',
        requestedRefundCents: body?.refundAmountCents,
        adminUsername: request.authAdmin.username,
        rotateOutRefundNo: false
      });
    }
  );

  // Admin: retry a REFUND_FAILED after-sale with a fresh outRefundNo
  app.post(
    '/api/admin/after-sales/:id/retry-refund',
    { preHandler: authService.requireAdminPermission('after_sales:manage') },
    async (request) => {
      if (!request.authAdmin) throw new CriticalError('authAdmin missing');
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const body = approveAfterSaleBody.parse(request.body);

      return executeAfterSaleRefund({
        prisma,
        wechatPay,
        afterSaleId: params.id,
        expectedFromStatus: 'REFUND_FAILED',
        requestedRefundCents: body?.refundAmountCents,
        adminUsername: request.authAdmin.username,
        rotateOutRefundNo: true
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

      const restoredOrderStatus = computeRestoredOrderStatus(afterSale.order);

      return prisma.$transaction(async (tx) => {
        const claimed = await tx.afterSaleOrder.updateMany({
          where: { id: afterSale.id, status: 'PENDING_REVIEW' },
          data: {
            status: 'REJECTED',
            rejectReason: body.rejectReason,
            reviewedBy: request.authAdmin!.username,
            reviewedAt: new Date()
          }
        });
        if (claimed.count !== 1) {
          throw new AppError(409, 'AFTER_SALE_CONFLICT', '售后单状态已变更，无法驳回');
        }

        await tx.order.updateMany({
          where: { id: afterSale.order.id, status: 'REFUND_REQUESTED' },
          data: { status: restoredOrderStatus }
        });

        return tx.afterSaleOrder.findUniqueOrThrow({ where: { id: afterSale.id } });
      });
    }
  );

  // Admin: actively sync refund status from WeChat Pay V3 (compensation for missed async callback)
  app.post(
    '/api/admin/after-sales/:id/sync-refund',
    { preHandler: authService.requireAdminPermission('after_sales:manage') },
    async (request) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const afterSale = await prisma.afterSaleOrder.findUnique({ where: { id: params.id } });
      if (!afterSale) {
        throw new AppError(404, 'AFTER_SALE_NOT_FOUND', '售后单不存在');
      }
      if (afterSale.status === 'REFUNDED') {
        return afterSale;
      }
      if (afterSale.status !== 'APPROVED_REFUNDING' && afterSale.status !== 'REFUND_FAILED') {
        throw new AppError(400, 'INVALID_AFTER_SALE_STATUS', '当前售后单状态无需同步退款进度');
      }

      const res = await wechatPay.queryRefundByOutRefundNo(afterSale.outRefundNo);
      if (res.status === 'SUCCESS') {
        return prisma.$transaction(async (tx) => {
          const updated = await tx.afterSaleOrder.update({
            where: { id: afterSale.id },
            data: {
              status: 'REFUNDED',
              wechatRefundId: res.refundId,
              refundedAt: new Date()
            }
          });
          await finalizeOrderRefundInTx(tx, afterSale.orderId, {
            type: afterSale.type,
            refundAmountCents: afterSale.refundAmountCents
          });
          return updated;
        });
      }

      if (res.status === 'ABNORMAL' || res.status === 'CLOSED') {
        return prisma.afterSaleOrder.update({
          where: { id: afterSale.id },
          data: {
            status: 'REFUND_FAILED',
            wechatRefundId: res.refundId,
            rejectReason: `微信退款异常(${res.status})，请核查买家账户或商户余额`
          }
        });
      }

      return afterSale;
    }
  );

  // WeChat Pay V3 refund notification callback
  app.post('/api/wechat/refund-notify', async (request, reply) => {
    const { eventType, payload } = verifyAndDecryptWechatCallback<WechatRefundSuccessPayload>(
      request,
      wechatPay,
      ['REFUND.SUCCESS', 'REFUND.ABNORMAL', 'REFUND.CLOSED']
    );

    if (payload) {
      const afterSale = await prisma.afterSaleOrder.findUnique({
        where: { outRefundNo: payload.out_refund_no }
      });
      if (!afterSale) {
        throw new CriticalError(`WeChat refund callback for unknown outRefundNo: ${payload.out_refund_no}`);
      }

      if (eventType === 'REFUND.SUCCESS' && afterSale.status !== 'REFUNDED') {
        await prisma.$transaction(async (tx) => {
          await tx.afterSaleOrder.update({
            where: { id: afterSale.id },
            data: {
              status: 'REFUNDED',
              wechatRefundId: payload.refund_id,
              refundedAt: new Date()
            }
          });
          await finalizeOrderRefundInTx(tx, afterSale.orderId, {
            type: afterSale.type,
            refundAmountCents: afterSale.refundAmountCents
          });
        });
      } else if (
        (eventType === 'REFUND.ABNORMAL' || eventType === 'REFUND.CLOSED') &&
        afterSale.status !== 'REFUNDED'
      ) {
        await prisma.afterSaleOrder.update({
          where: { id: afterSale.id },
          data: {
            status: 'REFUND_FAILED',
            wechatRefundId: payload.refund_id,
            rejectReason: `微信退款异常(${eventType}:${payload.refund_status})`
          }
        });
      }
    }

    return reply.status(200).send({ code: 'SUCCESS', message: '成功' });
  });
}

async function finalizeOrderRefundInTx(
  tx: PrismaTx,
  orderId: number,
  afterSaleInfo: { type: string; refundAmountCents: number }
): Promise<void> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { totalAmountCents: true, shippedAt: true }
  });
  if (!order) {
    return;
  }

  const updated = await tx.order.updateMany({
    where: { id: orderId, status: { not: 'REFUNDED' } },
    data: { status: 'REFUNDED' }
  });
  if (updated.count === 0) {
    return;
  }

  // Only restore inventory and salesCount when goods return to warehouse (RETURN_AND_REFUND / unshipped / full refund).
  // Partial REFUND_ONLY compensation on already-shipped orders keeps goods with buyer and must not inflate stock.
  const shouldRestoreStock =
    afterSaleInfo.refundAmountCents === order.totalAmountCents ||
    afterSaleInfo.type === 'RETURN_AND_REFUND' ||
    order.shippedAt === null;

  if (!shouldRestoreStock) {
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
