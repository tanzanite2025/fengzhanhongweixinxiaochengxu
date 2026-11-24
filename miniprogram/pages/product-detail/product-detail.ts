import { formatPrice } from '../../utils/format';
import { apiRequest } from '../../utils/request';
import type { ProductDto, ProductSkuDto } from '../../utils/types';

Page({
  data: {
    productId: 0,
    product: null as ProductDto | null,
    bannerImages: [] as string[],
    selectedSku: null as ProductSkuDto | null,
    selectedPriceText: '0.00',
    shippingHint: '',
    quantity: 1,
    showSkuModal: false,
    modalAction: 'cart' as 'cart' | 'buy',
    loading: true
  },

  onLoad(options: { id?: string }) {
    const id = Number(options.id ?? 0);
    if (!id) {
      wx.showToast({ title: '商品参数错误', icon: 'none' });
      return;
    }
    this.setData({ productId: id });
    this.loadDetail(id);
  },

  async loadDetail(id: number) {
    this.setData({ loading: true });
    try {
      const product = await apiRequest<ProductDto>({
        url: `/api/products/${id}`,
        requireAuth: false
      });

      const defaultSku =
        product.skus.find((s) => s.stock > 0) ?? (product.skus.length > 0 ? product.skus[0] : null);

      let shippingHint = '包邮配送';
      if (product.shippingRule) {
        const base = formatPrice(product.shippingRule.baseFeeCents);
        const free =
          product.shippingRule.freeThresholdCents !== null
            ? `，满 ¥${formatPrice(product.shippingRule.freeThresholdCents)} 包邮`
            : '';
        const excluded =
          product.shippingRule.excludedProvinces.length > 0
            ? `（不支持：${product.shippingRule.excludedProvinces.join('、')}）`
            : '';
        shippingHint = `基础运费 ¥${base}${free}${excluded}`;
      }

      const bannerImages =
        product.galleryUrls.length > 0 ? product.galleryUrls : [product.coverUrl];

      this.setData({
        product,
        bannerImages,
        selectedSku: defaultSku,
        selectedPriceText: defaultSku ? formatPrice(defaultSku.priceCents) : '0.00',
        shippingHint,
        loading: false
      });
    } catch (err: unknown) {
      this.setData({ loading: false });
      wx.showToast({
        title: err instanceof Error ? err.message : '加载商品失败',
        icon: 'none'
      });
    }
  },

  openSkuModal(e: WechatMiniprogram.TouchEvent) {
    const action = (e.currentTarget.dataset.action as 'cart' | 'buy') ?? 'cart';
    this.setData({ showSkuModal: true, modalAction: action });
  },

  closeSkuModal() {
    this.setData({ showSkuModal: false });
  },

  onSelectSku(e: WechatMiniprogram.TouchEvent) {
    const skuId = e.currentTarget.dataset.id as number;
    const product = this.data.product;
    if (!product) return;
    const sku = product.skus.find((s) => s.id === skuId) ?? null;
    if (!sku) return;
    this.setData({
      selectedSku: sku,
      selectedPriceText: formatPrice(sku.priceCents),
      quantity: Math.min(this.data.quantity, Math.max(1, sku.stock))
    });
  },

  onChangeQty(e: WechatMiniprogram.TouchEvent) {
    const delta = Number(e.currentTarget.dataset.delta);
    const maxStock = this.data.selectedSku?.stock ?? 1;
    const next = Math.max(1, Math.min(maxStock, this.data.quantity + delta));
    this.setData({ quantity: next });
  },

  async onConfirmSkuAction() {
    const sku = this.data.selectedSku;
    if (!sku) {
      wx.showToast({ title: '请选择商品规格', icon: 'none' });
      return;
    }
    if (sku.stock < this.data.quantity) {
      wx.showToast({ title: '所选规格库存不足', icon: 'none' });
      return;
    }

    if (this.data.modalAction === 'cart') {
      try {
        await apiRequest({
          url: '/api/cart',
          method: 'POST',
          data: { skuId: sku.id, quantity: this.data.quantity }
        });
        this.setData({ showSkuModal: false });
        wx.showToast({ title: '已加入购物车', icon: 'success' });
      } catch (err: unknown) {
        wx.showToast({
          title: err instanceof Error ? err.message : '加入购物车失败',
          icon: 'none'
        });
      }
      return;
    }

    this.setData({ showSkuModal: false });
    const items = encodeURIComponent(JSON.stringify([{ skuId: sku.id, quantity: this.data.quantity }]));
    wx.navigateTo({ url: `/pages/checkout/checkout?items=${items}&fromCart=0` });
  },

  goCart() {
    wx.switchTab({ url: '/pages/cart/cart' });
  }
});
