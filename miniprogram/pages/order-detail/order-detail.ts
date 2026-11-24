import { AFTER_SALE_STATUS_LABEL, formatPrice, ORDER_STATUS_LABEL } from '../../utils/format';
import { executeOrderPayment } from '../../utils/payment';
import { apiRequest } from '../../utils/request';
import type { OrderDto } from '../../utils/types';

Page({
  data: {
    orderId: 0,
    order: null as (OrderDto & {
      statusLabel: string;
      itemsAmountText: string;
      shippingFeeText: string;
      totalAmountText: string;
      formattedItems: Array<OrderDto['items'][number] & { unitPriceText: string }>;
      latestAfterSale: {
        afterSaleNo: string;
        statusLabel: string;
        reason: string;
        rejectReason: string | null;
      } | null;
    }) | null,
    showRefundModal: false,
    refundReason: ''
  },

  onLoad(options: { id?: string }) {
    const id = Number(options.id ?? 0);
    if (!id) {
      wx.showToast({ title: '订单参数错误', icon: 'none' });
      return;
    }
    this.setData({ orderId: id });
    this.loadDetail(id);
  },

  async loadDetail(id: number) {
    try {
      const order = await apiRequest<OrderDto>({ url: `/api/orders/${id}` });
      const latestAs = order.afterSales && order.afterSales.length > 0 ? order.afterSales[0] : null;
      this.setData({
        order: {
          ...order,
          statusLabel: ORDER_STATUS_LABEL[order.status] ?? order.status,
          itemsAmountText: formatPrice(order.itemsAmountCents),
          shippingFeeText: formatPrice(order.shippingFeeCents),
          totalAmountText: formatPrice(order.totalAmountCents),
          formattedItems: order.items.map((item) => ({
            ...item,
            unitPriceText: formatPrice(item.unitPriceCents)
          })),
          latestAfterSale: latestAs
            ? {
                afterSaleNo: latestAs.afterSaleNo,
                statusLabel: AFTER_SALE_STATUS_LABEL[latestAs.status] ?? latestAs.status,
                reason: latestAs.reason,
                rejectReason: latestAs.rejectReason
              }
            : null
        }
      });
    } catch (err: unknown) {
      wx.showToast({
        title: err instanceof Error ? err.message : '加载订单详情失败',
        icon: 'none'
      });
    }
  },

  onCopyTracking() {
    const tracking = this.data.order?.trackingNumber;
    if (!tracking) return;
    wx.setClipboardData({ data: tracking });
  },

  async onPayNow() {
    const order = this.data.order;
    if (!order) return;
    try {
      const result = await executeOrderPayment(order.id, { promptInMock: false });
      if (result === 'PAID') {
        wx.showToast({ title: '支付成功', icon: 'success' });
      } else {
        wx.showToast({ title: '您已取消支付', icon: 'none' });
      }
      await this.loadDetail(order.id);
    } catch (err: unknown) {
      wx.showToast({ title: err instanceof Error ? err.message : '支付失败', icon: 'none' });
    }
  },

  async onCancelOrder() {
    const order = this.data.order;
    if (!order) return;
    try {
      await apiRequest({ url: `/api/orders/${order.id}/cancel`, method: 'POST' });
      wx.showToast({ title: '订单已取消', icon: 'success' });
      await this.loadDetail(order.id);
    } catch (err: unknown) {
      wx.showToast({ title: err instanceof Error ? err.message : '取消失败', icon: 'none' });
    }
  },

  async onConfirmReceipt() {
    const order = this.data.order;
    if (!order) return;
    try {
      const txId = order.wechatTransactionId;
      if (txId && !txId.startsWith('MOCK_TX_') && typeof wx.openBusinessView === 'function') {
        await new Promise<void>((resolve, reject) => {
          wx.openBusinessView({
            businessType: 'weappOrderConfirm',
            extraData: { transaction_id: txId },
            success: (res) => {
              const status = (res as { extraData?: { status?: string } }).extraData?.status;
              if (status === 'success' || status === undefined) {
                resolve();
              } else {
                reject(new Error('您取消了确认收货'));
              }
            },
            fail: (err) => reject(new Error(`微信确认收货组件调用失败: ${err.errMsg}`))
          });
        });
      }

      await apiRequest({ url: `/api/orders/${order.id}/confirm-receipt`, method: 'POST' });
      wx.showToast({ title: '已确认收货', icon: 'success' });
      await this.loadDetail(order.id);
    } catch (err: unknown) {
      wx.showToast({ title: err instanceof Error ? err.message : '操作失败', icon: 'none' });
    }
  },

  openRefundModal() {
    this.setData({ showRefundModal: true, refundReason: '' });
  },

  closeRefundModal() {
    this.setData({ showRefundModal: false });
  },

  onReasonInput(e: WechatMiniprogram.Input) {
    this.setData({ refundReason: e.detail.value });
  },

  async onSubmitRefund() {
    const order = this.data.order;
    if (!order) return;
    if (this.data.refundReason.trim().length < 2) {
      wx.showToast({ title: '请填写至少2个字的售后原因', icon: 'none' });
      return;
    }

    const type = order.status === 'PENDING_SHIPMENT' ? 'REFUND_ONLY' : 'RETURN_AND_REFUND';
    try {
      await apiRequest({
        url: '/api/after-sales',
        method: 'POST',
        data: {
          orderId: order.id,
          type,
          reason: this.data.refundReason.trim()
        }
      });
      this.setData({ showRefundModal: false });
      wx.showToast({ title: '售后申请已提交', icon: 'success' });
      await this.loadDetail(order.id);
    } catch (err: unknown) {
      wx.showToast({ title: err instanceof Error ? err.message : '提交失败', icon: 'none' });
    }
  }
});
