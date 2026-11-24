import { formatPrice } from '../../utils/format';
import { apiRequest } from '../../utils/request';
import type { CategoryDto, ProductDto } from '../../utils/types';

interface CategoryProduct extends ProductDto {
  minPriceText: string;
}

Page({
  data: {
    categories: [] as CategoryDto[],
    activeCategoryId: 0,
    products: [] as CategoryProduct[],
    loading: true
  },

  onLoad() {
    this.initData();
  },

  async initData() {
    this.setData({ loading: true });
    try {
      const categories = await apiRequest<CategoryDto[]>({
        url: '/api/categories',
        requireAuth: false
      });
      const firstId = categories.length > 0 ? categories[0].id : 0;
      this.setData({ categories, activeCategoryId: firstId });
      if (firstId > 0) {
        await this.loadProductsByCategory(firstId);
      } else {
        this.setData({ loading: false });
      }
    } catch (err: unknown) {
      this.setData({ loading: false });
      wx.showToast({
        title: err instanceof Error ? err.message : '加载分类失败',
        icon: 'none'
      });
    }
  },

  async onSelectCategory(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    this.setData({ activeCategoryId: id });
    await this.loadProductsByCategory(id);
  },

  async loadProductsByCategory(categoryId: number) {
    this.setData({ loading: true });
    try {
      const res = await apiRequest<{ items: ProductDto[] }>({
        url: `/api/products?categoryId=${categoryId}`,
        requireAuth: false
      });
      const products: CategoryProduct[] = res.items.map((p) => ({
        ...p,
        minPriceText: formatPrice(p.skus.length > 0 ? p.skus[0].priceCents : 0)
      }));
      this.setData({ products, loading: false });
    } catch (err: unknown) {
      this.setData({ loading: false });
      wx.showToast({
        title: err instanceof Error ? err.message : '加载商品失败',
        icon: 'none'
      });
    }
  },

  goDetail(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    wx.navigateTo({ url: `/pages/product-detail/product-detail?id=${id}` });
  }
});
