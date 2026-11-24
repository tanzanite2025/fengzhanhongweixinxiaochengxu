import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import { AppError, CriticalError } from '../../lib/errors.js';
import { AuthService } from '../auth/auth.service.js';
import { verifyAndDecryptWechatCallback } from '../wechat-pay/wechat-callback.js';
import {
  WechatPayService,
  type WechatPaySuccessPayload
} from '../wechat-pay/wechat-pay.service.js';
import { EXPRESS_COMPANIES } from '../wechat-shipping/wechat-shipping.service.js';
import { OrderService } from './order.service.js';

const lineItemSchema = z.object({
  skuId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(99)
});

const previewBody = z.object({
  addressId: z.number().int().positive(),
  items: z.array(lineItemSchema).min(1)
});

const createOrderBody = z.object({
  addressId: z.number().int().positive(),
  items: z.array(lineItemSchema).min(1),
  fromCart: z.boolean().default(false),
  buyerRemark: z.string().max(200).optional()
});

const shipOrderBody = z.object({
  expressCompanyCode: z.string().trim().min(1, '请选择快递公司'),
  trackingNumber: z
    .string()
    .trim()
    .min(5, '快递单号至少5位')
    .max(64, '快递单号过长')
    .refine((val) => !/\s/.test(val), '快递单号不能包含空格或换行')
});

/**
 * Register buyer and admin order routes, WeChat Pay V3 callback, and express dictionary.
 */
export function registerOrderRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  config: AppConfig,
  authService: AuthService,
  orderService: OrderService,
  wechatPay: WechatPayService
): void {
  // Storefront: preview order & shipping fee
  app.post('/api/orders/preview', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const body = previewBody.parse(request.body);
    return orderService.previewOrder(request.authUserId, body.addressId, body.items);
  });

  // Storefront: create order (atomic stock lock)
  app.post('/api/orders', { preHandler: authService.requireUserAuth }, async (request, reply) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const body = createOrderBody.parse(request.body);
    const created = await orderService.createOrder({
      userId: request.authUserId,
      addressId: body.addressId,
      items: body.items,
      fromCart: body.fromCart,
      buyerRemark: body.buyerRemark
    });
    return reply.status(201).send(created);
  });

  // Storefront: initiate WeChat JSAPI pay
  app.post('/api/orders/:id/pay', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    return orderService.initiatePayment(params.id, request.authUserId);
  });

  // Storefront: query order status (with active WeChat Pay query compensation in live mode)
  app.post(
    '/api/orders/:id/sync-pay',
    { preHandler: authService.requireUserAuth },
    async (request) => {
      if (!request.authUserId) throw new CriticalError('authUserId missing');
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const order = await prisma.order.findFirst({
        where: { id: params.id, userId: request.authUserId },
        include: { items: true }
      });
      if (!order) {
        throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
      }
      if (order.status === 'PENDING_PAYMENT' && config.wechatMode === 'live') {
        const payRes = await wechatPay.queryOrderByOutTradeNo(order.orderNo);
        if (payRes && payRes.trade_state === 'SUCCESS') {
          return orderService.markOrderPaid(
            payRes.out_trade_no,
            payRes.transaction_id,
            payRes.amount.total,
            JSON.stringify(payRes)
          );
        }
      }
      return order;
    }
  );

  // Storefront: list buyer orders (paginated)
  app.get('/api/orders', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const query = z
      .object({
        status: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20)
      })
      .parse(request.query);

    const where = {
      userId: request.authUserId,
      ...(query.status && query.status !== 'ALL' ? { status: query.status } : {})
    };

    const [total, items] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        include: {
          items: true,
          afterSales: { orderBy: { id: 'desc' }, take: 1 }
        },
        orderBy: { id: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      })
    ]);

    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items
    };
  });

  // Storefront: order detail
  app.get('/api/orders/:id', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const order = await prisma.order.findFirst({
      where: { id: params.id, userId: request.authUserId },
      include: {
        items: true,
        afterSales: { orderBy: { id: 'desc' } }
      }
    });
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }
    return order;
  });

  // Storefront: cancel unpaid order
  app.post(
    '/api/orders/:id/cancel',
    { preHandler: authService.requireUserAuth },
    async (request) => {
      if (!request.authUserId) throw new CriticalError('authUserId missing');
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      return orderService.cancelOrderAndRestoreStock(params.id, '买家主动取消', request.authUserId);
    }
  );

  // Storefront: confirm receipt
  app.post(
    '/api/orders/:id/confirm-receipt',
    { preHandler: authService.requireUserAuth },
    async (request) => {
      if (!request.authUserId) throw new CriticalError('authUserId missing');
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      return orderService.confirmReceipt(params.id, request.authUserId);
    }
  );

  // WeChat Pay V3 asynchronous payment notification callback
  app.post('/api/wechat/pay-notify', async (request, reply) => {
    const { payload } = verifyAndDecryptWechatCallback<WechatPaySuccessPayload>(
      request,
      wechatPay,
      'TRANSACTION.SUCCESS'
    );

    if (payload && payload.trade_state === 'SUCCESS') {
      await orderService.markOrderPaid(
        payload.out_trade_no,
        payload.transaction_id,
        payload.amount.total,
        JSON.stringify(payload)
      );
    }

    return reply.status(200).send({ code: 'SUCCESS', message: '成功' });
  });

  // Sandbox-only mock payment completion endpoint (explicitly disabled in live/production mode)
  app.post(
    '/api/dev/mock-pay-notify',
    { preHandler: authService.requireUserAuth },
    async (request) => {
      if (config.nodeEnv === 'production' || config.wechatMode !== 'sandbox_mock') {
        throw new CriticalError('Mock payment endpoint is strictly forbidden outside sandbox_mock');
      }
      const body = z.object({ orderNo: z.string().min(1) }).parse(request.body);
      const order = await prisma.order.findFirst({
        where: { orderNo: body.orderNo, userId: request.authUserId }
      });
      if (!order) {
        throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
      }
      return orderService.markOrderPaid(
        order.orderNo,
        `MOCK_TX_${order.orderNo}`,
        order.totalAmountCents,
        JSON.stringify({ mock: true, out_trade_no: order.orderNo })
      );
    }
  );

  // Admin: express company options
  app.get(
    '/api/admin/express-companies',
    { preHandler: authService.requireAdminPermission('orders:manage') },
    async () => EXPRESS_COMPANIES
  );

  // Admin: list all orders (paginated)
  app.get(
    '/api/admin/orders',
    { preHandler: authService.requireAdminPermission('orders:manage') },
    async (request) => {
      const query = z
        .object({
          status: z.string().optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(50).default(20)
        })
        .parse(request.query);

      const where = query.status && query.status !== 'ALL' ? { status: query.status } : {};

      const [total, items] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
          where,
          include: {
            items: true,
            user: { select: { id: true, nickname: true, openId: true } },
            afterSales: { orderBy: { id: 'desc' }, take: 1 }
          },
          orderBy: { id: 'desc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize
        })
      ]);

      return {
        total,
        page: query.page,
        pageSize: query.pageSize,
        items
      };
    }
  );

  // Admin: ship order & upload shipping info to WeChat
  app.post(
    '/api/admin/orders/:id/ship',
    { preHandler: authService.requireAdminPermission('orders:manage') },
    async (request) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const body = shipOrderBody.parse(request.body);
      return orderService.shipOrder(params.id, body.expressCompanyCode, body.trackingNumber);
    }
  );

  // Admin: update shipping tracking info for SHIPPED order & re-upload to WeChat
  app.post(
    '/api/admin/orders/:id/update-shipping',
    { preHandler: authService.requireAdminPermission('orders:manage') },
    async (request) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const body = shipOrderBody.parse(request.body);
      return orderService.updateOrderShipping(params.id, body.expressCompanyCode, body.trackingNumber);
    }
  );

  // Admin: retry WeChat shipping sync
  app.post(
    '/api/admin/orders/:id/retry-wechat-shipping',
    { preHandler: authService.requireAdminPermission('orders:manage') },
    async (request) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      return orderService.syncWechatShippingForOrder(params.id);
    }
  );

  // Admin: retry refund for CANCELLED order with MANUAL_REFUND_REQUIRED
  app.post(
    '/api/admin/orders/:id/retry-abnormal-refund',
    { preHandler: authService.requireAdminPermission('orders:manage') },
    async (request) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      return orderService.retryAbnormalRefund(params.id);
    }
  );

  // Admin: dashboard summary metrics
  app.get(
    '/api/admin/dashboard',
    { preHandler: authService.requireAdminPermission('dashboard:view') },
    async () => {
      const [
        totalOrders,
        pendingShipmentCount,
        pendingAfterSalesCount,
        shippingSyncFailedCount,
        abnormalPaidOrdersCount,
        manualRefundRequiredCount,
        paidOrders
      ] = await Promise.all([
        prisma.order.count(),
        prisma.order.count({ where: { status: 'PENDING_SHIPMENT' } }),
        prisma.afterSaleOrder.count({ where: { status: 'PENDING_REVIEW' } }),
        prisma.order.count({ where: { wechatShippingSyncStatus: 'FAILED' } }),
        prisma.order.count({ where: { abnormalPayStatus: { not: 'NONE' } } }),
        prisma.order.count({ where: { abnormalPayStatus: 'MANUAL_REFUND_REQUIRED' } }),
        prisma.order.aggregate({
          where: {
            status: { in: ['PENDING_SHIPMENT', 'SHIPPED', 'COMPLETED'] }
          },
          _sum: { totalAmountCents: true }
        })
      ]);

      return {
        totalOrders,
        pendingShipmentCount,
        pendingAfterSalesCount,
        shippingSyncFailedCount,
        abnormalPaidOrdersCount,
        manualRefundRequiredCount,
        gmvCents: paidOrders._sum.totalAmountCents ?? 0
      };
    }
  );
}
