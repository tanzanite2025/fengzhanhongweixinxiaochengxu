import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env.js';
import { AppError, CriticalError } from '../../lib/errors.js';
import { calculateShippingFee } from '../shipping/shipping.service.js';
import { type JsapiPayClientParams, WechatPayService } from '../wechat-pay/wechat-pay.service.js';
import { WechatShippingService } from '../wechat-shipping/wechat-shipping.service.js';

export interface OrderLineInput {
  skuId: number;
  quantity: number;
}

export interface CreateOrderInput {
  userId: number;
  addressId: number;
  items: OrderLineInput[];
  fromCart: boolean;
  buyerRemark?: string;
}

function generateOrderNo(prefix: string): string {
  const now = new Date();
  const y = now.getFullYear().toString();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}${y}${m}${d}${h}${min}${s}${rand}`;
}

/**
 * Core physical-goods order engine: atomic stock locking, shipping fee calculation,
 * payment reconciliation, expiry cancellation, shipping sync, and refund state machine.
 */
export class OrderService {
  private readonly inFlightPrepayByOrderId = new Map<
    number,
    Promise<{ prepayId: string; payParams: JsapiPayClientParams }>
  >();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
    private readonly wechatPay: WechatPayService,
    private readonly wechatShipping: WechatShippingService
  ) {}

  /**
   * Preview order totals and shipping fees before creating an order.
   */
  public async previewOrder(userId: number, addressId: number, items: OrderLineInput[]) {
    if (items.length === 0) {
      throw new AppError(400, 'EMPTY_ITEMS', '请选择要购买的商品');
    }

    const address = await this.prisma.userAddress.findFirst({
      where: { id: addressId, userId }
    });
    if (!address) {
      throw new AppError(404, 'ADDRESS_NOT_FOUND', '收货地址不存在');
    }

    const skuIds = [...new Set(items.map((i) => i.skuId))];
    const skus = await this.prisma.productSku.findMany({
      where: { id: { in: skuIds } },
      include: {
        product: {
          include: { shippingRule: true }
        }
      }
    });
    const skuMap = new Map(skus.map((s) => [s.id, s]));

    let itemsAmountCents = 0;
    const shippableLines = [];
    const resolvedLines = [];

    for (const line of items) {
      if (line.quantity <= 0) {
        throw new AppError(400, 'INVALID_QUANTITY', '购买数量必须大于 0');
      }
      const sku = skuMap.get(line.skuId);
      if (!sku || !sku.isActive || sku.product.status !== 'ON_SALE') {
        throw new AppError(400, 'SKU_UNAVAILABLE', `商品规格 #${line.skuId} 已下架或不存在`);
      }
      if (sku.stock < line.quantity) {
        throw new AppError(
          400,
          'INSUFFICIENT_STOCK',
          `「${sku.product.title} - ${sku.specName}」库存不足，仅剩 ${sku.stock} 件`
        );
      }
      const subtotalCents = sku.priceCents * line.quantity;
      itemsAmountCents += subtotalCents;
      shippableLines.push({
        productId: sku.product.id,
        productTitle: sku.product.title,
        quantity: line.quantity,
        subtotalCents,
        shippingRule: sku.product.shippingRule
      });
      resolvedLines.push({
        productId: sku.product.id,
        skuId: sku.id,
        productTitle: sku.product.title,
        skuSpecName: sku.specName,
        skuImageUrl: sku.specImageUrl ?? sku.product.coverUrl,
        unitPriceCents: sku.priceCents,
        quantity: line.quantity,
        subtotalCents
      });
    }

    const shippingResult = calculateShippingFee(shippableLines, address.province);
    return {
      address,
      items: resolvedLines,
      itemsAmountCents,
      shippingFeeCents: shippingResult.shippingFeeCents,
      shippingBreakdown: shippingResult.breakdown,
      totalAmountCents: itemsAmountCents + shippingResult.shippingFeeCents
    };
  }

  /**
   * Create an order inside a database transaction with atomic conditional stock decrement.
   */
  public async createOrder(input: CreateOrderInput) {
    const preview = await this.previewOrder(input.userId, input.addressId, input.items);
    const orderNo = generateOrderNo('ORD');
    const expireAt = new Date(Date.now() + this.config.orderExpireMinutes * 60_000);

    // Aggregate quantities per skuId in case duplicate lines were supplied
    const qtyBySku = new Map<number, number>();
    for (const item of input.items) {
      qtyBySku.set(item.skuId, (qtyBySku.get(item.skuId) ?? 0) + item.quantity);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      for (const [skuId, qty] of qtyBySku.entries()) {
        const decremented = await tx.productSku.updateMany({
          where: {
            id: skuId,
            isActive: true,
            stock: { gte: qty }
          },
          data: {
            stock: { decrement: qty }
          }
        });

        if (decremented.count !== 1) {
          throw new AppError(409, 'OUT_OF_STOCK', '部分商品库存刚刚被抢光，请返回重试');
        }
      }

      const order = await tx.order.create({
        data: {
          orderNo,
          userId: input.userId,
          status: 'PENDING_PAYMENT',
          itemsAmountCents: preview.itemsAmountCents,
          shippingFeeCents: preview.shippingFeeCents,
          totalAmountCents: preview.totalAmountCents,
          receiverName: preview.address.receiverName,
          receiverPhone: preview.address.receiverPhone,
          receiverProvince: preview.address.province,
          receiverCity: preview.address.city,
          receiverDistrict: preview.address.district,
          receiverDetail: preview.address.detailAddress,
          buyerRemark: input.buyerRemark ?? null,
          expireAt,
          items: {
            create: preview.items
          },
          paymentRecords: {
            create: {
              outTradeNo: orderNo,
              amountCents: preview.totalAmountCents,
              status: 'INIT'
            }
          }
        },
        include: { items: true }
      });

      if (input.fromCart) {
        await tx.cartItem.deleteMany({
          where: {
            userId: input.userId,
            skuId: { in: [...qtyBySku.keys()] }
          }
        });
      }

      return order;
    });

    return created;
  }

  /**
   * Prepare WeChat Pay JSAPI parameters for a PENDING_PAYMENT order.
   */
  public async initiatePayment(orderId: number, userId: number) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { user: true, items: true }
    });
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }
    if (order.status !== 'PENDING_PAYMENT') {
      throw new AppError(400, 'INVALID_ORDER_STATUS', '当前订单状态不可支付');
    }
    if (order.expireAt.getTime() <= Date.now()) {
      await this.cancelOrderAndRestoreStock(order.id, '支付超时自动取消');
      throw new AppError(400, 'ORDER_EXPIRED', '订单已超时关闭，请重新下单');
    }

    if (order.wechatPrepayId) {
      return {
        orderNo: order.orderNo,
        totalAmountCents: order.totalAmountCents,
        payParams: this.wechatPay.buildMiniProgramPayParams(order.wechatPrepayId)
      };
    }

    const firstTitle = order.items[0]?.productTitle ?? '商品订单';
    const description =
      order.items.length > 1 ? `${firstTitle} 等 ${order.items.length} 件商品` : firstTitle;

    // Coalesce concurrent prepay calls for the same order so differing second-level time_expire values never collide
    let prepayPromise = this.inFlightPrepayByOrderId.get(order.id);
    if (!prepayPromise) {
      // WeChat Pay V3 requires time_expire to be at least ~1 minute in the future
      const minExpireMs = Date.now() + 90_000;
      const effectiveExpire = new Date(Math.max(order.expireAt.getTime(), minExpireMs));

      prepayPromise = this.wechatPay
        .createJsapiPrepay({
          outTradeNo: order.orderNo,
          description,
          totalAmountCents: order.totalAmountCents,
          openId: order.user.openId,
          timeExpire: effectiveExpire
        })
        .then(async (prepay) => {
          await this.prisma.order.update({
            where: { id: order.id },
            data: { wechatPrepayId: prepay.prepayId }
          });
          return prepay;
        })
        .finally(() => {
          this.inFlightPrepayByOrderId.delete(order.id);
        });

      this.inFlightPrepayByOrderId.set(order.id, prepayPromise);
    }

    const prepay = await prepayPromise;
    return {
      orderNo: order.orderNo,
      totalAmountCents: order.totalAmountCents,
      payParams: prepay.payParams
    };
  }

  /**
   * Idempotently mark an order as paid after verifying amount and payment transaction.
   */
  public async markOrderPaid(
    outTradeNo: string,
    transactionId: string,
    paidAmountCents: number,
    rawCallbackJson: string
  ) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo: outTradeNo },
      include: { items: true }
    });
    if (!order) {
      throw new CriticalError(`WeChat payment callback for unknown orderNo: ${outTradeNo}`);
    }
    if (paidAmountCents !== order.totalAmountCents) {
      throw new CriticalError(
        `Payment amount mismatch for order ${outTradeNo}: expected ${order.totalAmountCents}, got ${paidAmountCents}`
      );
    }

    if (order.status !== 'PENDING_PAYMENT') {
      if (order.status === 'CANCELLED') {
        return this.handlePaidAfterCancel(order.id, order.orderNo, order.totalAmountCents, order.abnormalPayStatus, transactionId, paidAmountCents, rawCallbackJson);
      }
      // Already processed idempotently
      return order;
    }

    const now = new Date();
    const txOutcome = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: order.id, status: 'PENDING_PAYMENT' },
        data: {
          status: 'PENDING_SHIPMENT',
          wechatTransactionId: transactionId,
          paidAt: now
        }
      });

      if (updated.count === 0) {
        const latest = await tx.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { items: true }
        });
        return { kind: 'RACE' as const, latest };
      }

      await tx.paymentRecord.update({
        where: { outTradeNo },
        data: {
          transactionId,
          status: 'SUCCESS',
          rawCallback: rawCallbackJson,
          paidAt: now
        }
      });

      for (const item of order.items) {
        await tx.product.update({
          where: { id: item.productId },
          data: { salesCount: { increment: item.quantity } }
        });
      }

      const settled = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true }
      });
      return { kind: 'PAID' as const, order: settled };
    });

    if (txOutcome.kind === 'RACE') {
      if (txOutcome.latest.status === 'CANCELLED') {
        return this.handlePaidAfterCancel(
          txOutcome.latest.id,
          txOutcome.latest.orderNo,
          txOutcome.latest.totalAmountCents,
          txOutcome.latest.abnormalPayStatus,
          transactionId,
          paidAmountCents,
          rawCallbackJson
        );
      }
      return txOutcome.latest;
    }

    return txOutcome.order;
  }

  /**
   * Reconcile the rare race condition where a buyer completes payment right as an expired order is closed.
   * Uses an atomic claim lock on abnormalPayStatus so concurrent callbacks cannot trigger duplicate refunds.
   */
  private async handlePaidAfterCancel(
    orderId: number,
    orderNo: string,
    totalAmountCents: number,
    currentAbnormalStatus: string,
    transactionId: string,
    paidAmountCents: number,
    rawCallbackJson: string
  ) {
    if (currentAbnormalStatus !== 'NONE') {
      return this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    }

    const claim = await this.prisma.order.updateMany({
      where: { id: orderId, status: 'CANCELLED', abnormalPayStatus: 'NONE' },
      data: { abnormalPayStatus: 'AUTO_REFUNDING' }
    });
    if (claim.count !== 1) {
      return this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    }

    await this.prisma.paymentRecord.update({
      where: { outTradeNo: orderNo },
      data: {
        transactionId,
        status: 'PAID_AFTER_CANCEL',
        rawCallback: rawCallbackJson,
        paidAt: new Date()
      }
    });

    try {
      const refundRes = await this.wechatPay.createRefund({
        outTradeNo: orderNo,
        outRefundNo: `RF_ABN_${orderNo}`,
        refundAmountCents: paidAmountCents,
        totalAmountCents,
        reason: '订单超时关闭后付款自动退回'
      });

      return this.prisma.order.update({
        where: { id: orderId },
        data: {
          abnormalPayStatus: 'AUTO_REFUNDED',
          abnormalPayNote: `关单后收到支付通知(${transactionId})，已自动原路退款(${refundRes.refundId})`
        },
        include: { items: true }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.prisma.order.update({
        where: { id: orderId },
        data: {
          abnormalPayStatus: 'MANUAL_REFUND_REQUIRED',
          abnormalPayNote: `关单后收到支付通知(${transactionId})，自动退款失败需人工处理: ${msg}`
        },
        include: { items: true }
      });
    }
  }

  /**
   * Admin manual retry for orders stuck in MANUAL_REFUND_REQUIRED after paid-after-cancel failure.
   */
  public async retryAbnormalRefund(orderId: number) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true }
    });
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }
    if (order.status !== 'CANCELLED' || order.abnormalPayStatus !== 'MANUAL_REFUND_REQUIRED') {
      throw new AppError(400, 'INVALID_ORDER_STATUS', '当前订单无需重试异常退款');
    }

    const claim = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        status: 'CANCELLED',
        abnormalPayStatus: 'MANUAL_REFUND_REQUIRED'
      },
      data: { abnormalPayStatus: 'AUTO_REFUNDING' }
    });
    if (claim.count !== 1) {
      throw new AppError(409, 'ORDER_STATUS_CHANGED', '异常退款正在处理中或状态已变更');
    }

    const outRefundNo = `RF_ABN_${order.orderNo}_${Date.now().toString(36).toUpperCase()}`;
    try {
      const refundRes = await this.wechatPay.createRefund({
        outTradeNo: order.orderNo,
        outRefundNo,
        refundAmountCents: order.totalAmountCents,
        totalAmountCents: order.totalAmountCents,
        reason: '关单后付款人工重试原路退回'
      });

      return this.prisma.order.update({
        where: { id: order.id },
        data: {
          abnormalPayStatus: 'AUTO_REFUNDED',
          abnormalPayNote: `重试异常退款成功(${outRefundNo} / ${refundRes.refundId})`
        },
        include: { items: true }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          abnormalPayStatus: 'MANUAL_REFUND_REQUIRED',
          abnormalPayNote: `重试异常退款失败(${outRefundNo}): ${msg}`
        }
      });
      throw err;
    }
  }

  /**
   * Cancel a PENDING_PAYMENT order and atomically restore all locked SKU stock.
   */
  public async cancelOrderAndRestoreStock(
    orderId: number,
    reason: string,
    expectedUserId?: number,
    options?: { skipWechatQuery?: boolean }
  ) {
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        ...(expectedUserId !== undefined ? { userId: expectedUserId } : {})
      },
      include: { items: true }
    });
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }
    if (order.status !== 'PENDING_PAYMENT') {
      throw new AppError(400, 'CANNOT_CANCEL_ORDER', '仅待付款订单支持取消');
    }

    if (this.config.wechatMode === 'live' && order.wechatPrepayId) {
      if (!options?.skipWechatQuery) {
        const payRes = await this.wechatPay.queryOrderByOutTradeNo(order.orderNo);
        if (payRes && payRes.trade_state === 'SUCCESS') {
          await this.markOrderPaid(
            payRes.out_trade_no,
            payRes.transaction_id,
            payRes.amount.total,
            JSON.stringify(payRes)
          );
          throw new AppError(409, 'ORDER_ALREADY_PAID', '该订单已完成微信支付，无法取消，请刷新后申请退款');
        }
      }
      await this.wechatPay.closeOrder(order.orderNo);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: order.id, status: 'PENDING_PAYMENT' },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: reason
        }
      });

      if (updated.count === 0) {
        throw new AppError(409, 'ORDER_STATUS_CHANGED', '订单状态已变更，无法取消');
      }

      for (const item of order.items) {
        await tx.productSku.update({
          where: { id: item.skuId },
          data: { stock: { increment: item.quantity } }
        });
      }

      await tx.paymentRecord.updateMany({
        where: { orderId: order.id, status: 'INIT' },
        data: { status: 'CLOSED' }
      });

      return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    });
  }

  /**
   * Scan and cancel all expired unpaid orders, querying WeChat Pay first in live mode to avoid false closure.
   */
  public async cancelExpiredOrders(now: Date = new Date()): Promise<number> {
    const expired = await this.prisma.order.findMany({
      where: {
        status: 'PENDING_PAYMENT',
        expireAt: { lte: now }
      },
      select: { id: true, orderNo: true, wechatPrepayId: true }
    });

    let cancelledCount = 0;
    for (const item of expired) {
      try {
        if (this.config.wechatMode === 'live' && item.wechatPrepayId) {
          const payRes = await this.wechatPay.queryOrderByOutTradeNo(item.orderNo);
          if (payRes && payRes.trade_state === 'SUCCESS') {
            await this.markOrderPaid(
              payRes.out_trade_no,
              payRes.transaction_id,
              payRes.amount.total,
              JSON.stringify(payRes)
            );
            continue;
          }
          if (payRes && payRes.trade_state === 'USERPAYING') {
            continue;
          }
        }

        await this.cancelOrderAndRestoreStock(item.id, '超时未支付自动关闭', undefined, {
          skipWechatQuery: true
        });
        cancelledCount += 1;
      } catch (err) {
        // Ignore only race condition where user paid or cancelled concurrently
        if (err instanceof AppError && err.code === 'ORDER_STATUS_CHANGED') {
          continue;
        }
        // Isolate single-order failures so remaining expired orders still release stock
        console.error(`[CRITICAL] Failed to cancel expired order ${item.orderNo}:`, err);
      }
    }
    return cancelledCount;
  }

  private validateShippingInput(expressCompanyCode: string, trackingNumber: string) {
    const code = expressCompanyCode.trim();
    const expressCompanyName = this.wechatShipping.resolveExpressName(code);
    const trimmedTracking = trackingNumber.trim();
    if (trimmedTracking.length < 5 || trimmedTracking.length > 64 || /\s/.test(trimmedTracking)) {
      throw new AppError(400, 'INVALID_TRACKING_NUMBER', '请输入5-64位有效快递单号（不能包含空格）');
    }
    return {
      expressCompanyCode: code,
      expressCompanyName,
      trackingNumber: trimmedTracking
    };
  }

  /**
   * Ship a PENDING_SHIPMENT order atomically and push logistics to WeChat Shipping Management API.
   */
  public async shipOrder(orderId: number, expressCompanyCode: string, trackingNumber: string) {
    const shipping = this.validateShippingInput(expressCompanyCode, trackingNumber);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true }
    });
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }
    if (order.status !== 'PENDING_SHIPMENT') {
      throw new AppError(400, 'INVALID_ORDER_STATUS', '仅待发货订单可执行发货');
    }

    const updated = await this.prisma.order.updateMany({
      where: { id: order.id, status: 'PENDING_SHIPMENT' },
      data: {
        status: 'SHIPPED',
        expressCompanyCode: shipping.expressCompanyCode,
        expressCompanyName: shipping.expressCompanyName,
        trackingNumber: shipping.trackingNumber,
        shippedAt: new Date(),
        wechatShippingSyncStatus: 'PENDING',
        wechatShippingSyncError: null
      }
    });
    if (updated.count !== 1) {
      throw new AppError(409, 'ORDER_STATUS_CHANGED', '订单状态已变更（可能买家已申请退款），无法发货');
    }

    return this.syncWechatShippingForOrder(order.id);
  }

  /**
   * Update express company or tracking number for a SHIPPED order and re-sync WeChat Shipping API.
   */
  public async updateOrderShipping(
    orderId: number,
    expressCompanyCode: string,
    trackingNumber: string
  ) {
    const shipping = this.validateShippingInput(expressCompanyCode, trackingNumber);

    const updated = await this.prisma.order.updateMany({
      where: { id: orderId, status: 'SHIPPED' },
      data: {
        expressCompanyCode: shipping.expressCompanyCode,
        expressCompanyName: shipping.expressCompanyName,
        trackingNumber: shipping.trackingNumber,
        wechatShippingSyncStatus: 'PENDING',
        wechatShippingSyncError: null
      }
    });

    if (updated.count === 0) {
      const exists = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true }
      });
      if (!exists) {
        throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
      }
      throw new AppError(400, 'INVALID_ORDER_STATUS', '仅已发货订单支持修改物流单号');
    }

    return this.syncWechatShippingForOrder(orderId);
  }

  /**
   * Sync or retry uploading shipping logistics to WeChat Mini Program Shipping Service.
   */
  public async syncWechatShippingForOrder(orderId: number) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, items: true }
    });
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }
    if (!order.expressCompanyCode || !order.trackingNumber) {
      throw new AppError(400, 'NO_SHIPPING_INFO', '该订单尚未录入物流信息');
    }

    const firstTitle = order.items[0]?.productTitle ?? '商品';
    const itemDesc =
      order.items.length > 1 ? `${firstTitle}等${order.items.length}件` : firstTitle;

    try {
      await this.wechatShipping.uploadShippingInfo({
        outTradeNo: order.orderNo,
        transactionId: order.wechatTransactionId,
        openId: order.user.openId,
        receiverPhone: order.receiverPhone,
        expressCompanyCode: order.expressCompanyCode,
        trackingNumber: order.trackingNumber,
        itemDesc
      });

      return this.prisma.order.update({
        where: { id: order.id },
        data: {
          wechatShippingSyncStatus: 'SYNCED',
          wechatShippingSyncError: null,
          wechatShippingSyncedAt: new Date()
        },
        include: { items: true }
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const updated = await this.prisma.order.update({
        where: { id: order.id },
        data: {
          wechatShippingSyncStatus: 'FAILED',
          wechatShippingSyncError: errorMessage
        },
        include: { items: true }
      });
      return updated;
    }
  }

  /**
   * Buyer confirms receipt of a SHIPPED order.
   */
  public async confirmReceipt(orderId: number, userId: number) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId }
    });
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }
    if (order.status !== 'SHIPPED') {
      throw new AppError(400, 'INVALID_ORDER_STATUS', '仅已发货订单可确认收货');
    }

    return this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date()
      },
      include: { items: true }
    });
  }
}
