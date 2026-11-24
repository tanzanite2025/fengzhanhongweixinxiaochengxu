import { formatPrice } from '../../utils/format';
import { apiRequest } from '../../utils/request';
import type { CartItemDto } from '../../utils/types';

interface DisplayCartItem extends CartItemDto {
  priceText: string;
}

Page({
  data: {
    items: [] as DisplayCartItem[],
    selectedCount: 0,
    totalAmountText: '0.00',
    loading: true
  },

  onShow() {
    this.loadCart();
  },

  async loadCart() {
    this.setData({ loading: true });
    try {
      const list = await apiRequest<CartItemDto[]>({ url: '/api/cart' });
      let totalCents = 0;
      let selectedCount = 0;
      const items: DisplayCartItem[] = list.map((item) => {
        if (item.selected && item.available) {
          totalCents += item.sku.priceCents * item.quantity;
          selectedCount += 1;
        }
        return {
          ...item,
          priceText: formatPrice(item.sku.priceCents)
        };
      });
      this.setData({
        items,
        selectedCount,
        totalAmountText: formatPrice(totalCents),
        loading: false
      });
    } catch (err: unknown) {
      this.setData({ loading: false });
      wx.showToast({
        title: err instanceof Error ? err.message : '加载购物车失败',
        icon: 'none'
      });
    }
  },

  async onToggleSelect(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    const item = this.data.items.find((i) => i.id === id);
    if (!item || !item.available) return;
    try {
      await apiRequest({
        url: `/api/cart/${id}`,
        method: 'PUT',
        data: { selected: !item.selected }
      });
      await this.loadCart();
    } catch (err: unknown) {
      wx.showToast({
        title: err instanceof Error ? err.message : '更新选中状态失败',
        icon: 'none'
      });
    }
  },

  async onChangeQty(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    const delta = Number(e.currentTarget.dataset.delta);
    const item = this.data.items.find((i) => i.id === id);
    if (!item) return;
    const nextQty = item.quantity + delta;
    if (nextQty < 1) return;

    try {
      await apiRequest({
        url: `/api/cart/${id}`,
        method: 'PUT',
        data: { quantity: nextQty }
      });
      await this.loadCart();
    } catch (err: unknown) {
      wx.showToast({
        title: err instanceof Error ? err.message : '修改数量失败',
        icon: 'none'
      });
    }
  },

  async onDeleteItem(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    try {
      await apiRequest({ url: `/api/cart/${id}`, method: 'DELETE' });
      await this.loadCart();
    } catch (err: unknown) {
      wx.showToast({
        title: err instanceof Error ? err.message : '删除失败',
        icon: 'none'
      });
    }
  },

  onCheckout() {
    const selectedItems = this.data.items
      .filter((i) => i.selected && i.available)
      .map((i) => ({ skuId: i.skuId, quantity: i.quantity }));
    if (selectedItems.length === 0) {
      wx.showToast({ title: '请先勾选可购买的商品', icon: 'none' });
      return;
    }
    const encoded = encodeURIComponent(JSON.stringify(selectedItems));
    wx.navigateTo({ url: `/pages/checkout/checkout?items=${encoded}&fromCart=1` });
  }
});
