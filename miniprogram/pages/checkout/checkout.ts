import { formatPrice } from '../../utils/format';
import { executeOrderPayment } from '../../utils/payment';
import { apiRequest } from '../../utils/request';
import type { AddressDto } from '../../utils/types';

interface CheckoutLine {
  skuId: number;
  quantity: number;
}

interface PreviewResponse {
  address: AddressDto;
  items: Array<{
    productId: number;
    skuId: number;
    productTitle: string;
    skuSpecName: string;
    skuImageUrl: string;
    unitPriceCents: number;
    quantity: number;
    subtotalCents: number;
  }>;
  itemsAmountCents: number;
  shippingFeeCents: number;
  totalAmountCents: number;
}

Page({
  data: {
    items: [] as CheckoutLine[],
    fromCart: false,
    address: null as AddressDto | null,
    previewItems: [] as Array<PreviewResponse['items'][number] & { unitPriceText: string }>,
    itemsAmountText: '0.00',
    shippingFeeText: '0.00',
    totalAmountText: '0.00',
    previewError: '',
    buyerRemark: '',
    submitting: false
  },

  onLoad(options: { items?: string; fromCart?: string }) {
    if (!options.items) {
      wx.showToast({ title: '结算商品参数缺失', icon: 'none' });
      return;
    }
    const items = JSON.parse(decodeURIComponent(options.items)) as CheckoutLine[];
    this.setData({
      items,
      fromCart: options.fromCart === '1'
    });
  },

  onShow() {
    this.loadAddressAndPreview();
  },

  async loadAddressAndPreview() {
    try {
      const picked = wx.getStorageSync('selected_checkout_address') as AddressDto | undefined;
      if (picked) {
        wx.removeStorageSync('selected_checkout_address');
      }

      let address: AddressDto | null = picked ?? this.data.address;
      if (!address) {
        const list = await apiRequest<AddressDto[]>({ url: '/api/addresses' });
        address = list.find((a) => a.isDefault) ?? (list.length > 0 ? list[0] : null);
      } else if (!picked) {
        // Re-verify persisted address still exists in backend
        const list = await apiRequest<AddressDto[]>({ url: '/api/addresses' });
        address =
          list.find((a) => a.id === address!.id) ??
          list.find((a) => a.isDefault) ??
          (list.length > 0 ? list[0] : null);
      }

      this.setData({ address, previewError: '' });

      if (!address) {
        return;
      }

      const preview = await apiRequest<PreviewResponse>({
        url: '/api/orders/preview',
        method: 'POST',
        data: {
          addressId: address.id,
          items: this.data.items
        }
      });

      this.setData({
        previewItems: preview.items.map((item) => ({
          ...item,
          unitPriceText: formatPrice(item.unitPriceCents)
        })),
        itemsAmountText: formatPrice(preview.itemsAmountCents),
        shippingFeeText: formatPrice(preview.shippingFeeCents),
        totalAmountText: formatPrice(preview.totalAmountCents),
        previewError: ''
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '订单试算失败';
      this.setData({
        previewError: msg,
        previewItems: [],
        itemsAmountText: '0.00',
        shippingFeeText: '0.00',
        totalAmountText: '0.00'
      });
      wx.showToast({ title: msg, icon: 'none' });
    }
  },

  onRemarkInput(e: WechatMiniprogram.Input) {
    this.setData({ buyerRemark: e.detail.value });
  },

  goSelectAddress() {
    wx.navigateTo({ url: '/pages/address/address?select=1' });
  },

  async onSubmitOrder() {
    if (this.data.submitting) return;
    if (!this.data.address) {
      wx.showToast({ title: '请先添加收货地址', icon: 'none' });
      return;
    }
    if (this.data.previewError) {
      wx.showToast({ title: this.data.previewError, icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    let createdOrderId: number | null = null;

    try {
      const created = await apiRequest<{ id: number; orderNo: string }>({
        url: '/api/orders',
        method: 'POST',
        data: {
          addressId: this.data.address.id,
          items: this.data.items,
          fromCart: this.data.fromCart,
          ...(this.data.buyerRemark.trim() ? { buyerRemark: this.data.buyerRemark.trim() } : {})
        }
      });
      createdOrderId = created.id;

      const payResult = await executeOrderPayment(created.id, { promptInMock: true });
      wx.showToast({
        title: payResult === 'PAID' ? '支付成功' : '已生成待付款订单',
        icon: payResult === 'PAID' ? 'success' : 'none'
      });
      wx.redirectTo({ url: `/pages/order-detail/order-detail?id=${created.id}` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '下单失败';
      wx.showToast({ title: msg, icon: 'none' });
      if (createdOrderId !== null) {
        // Order was already committed in DB: navigate to detail so buyer never double-orders
        wx.redirectTo({ url: `/pages/order-detail/order-detail?id=${createdOrderId}` });
      }
    } finally {
      this.setData({ submitting: false });
    }
  }
});
