import { formatPrice } from '../../utils/format';
import { apiRequest } from '../../utils/request';
import type { CategoryDto, ProductDto } from '../../utils/types';

interface CategoryProduct extends ProductDto {
  minPriceText: string;
}

const PAGE_SIZE = 20;

Page({
  data: {
    categories: [] as CategoryDto[],
    activeCategoryId: 0,
    products: [] as CategoryProduct[],
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false
  },

  onLoad() {
    this.initData();
  },

  onPullDownRefresh() {
    this.initData().finally(() => wx.stopPullDownRefresh());
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
        await this.loadProductsByCategory(firstId, true);
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
    await this.loadProductsByCategory(id, true);
  },

  onLoadMore() {
    if (!this.data.loading && !this.data.loadingMore && this.data.hasMore && this.data.activeCategoryId > 0) {
      this.loadProductsByCategory(this.data.activeCategoryId, false);
    }
  },

  async loadProductsByCategory(categoryId: number, reset: boolean) {
    const nextPage = reset ? 1 : this.data.page + 1;
    if (reset) {
      this.setData({ loading: true });
    } else {
      this.setData({ loadingMore: true });
    }
    try {
      const res = await apiRequest<{ total: number; items: ProductDto[] }>({
        url: `/api/products?categoryId=${categoryId}&page=${nextPage}&pageSize=${PAGE_SIZE}`,
        requireAuth: false
      });
      const mapped: CategoryProduct[] = res.items.map((p) => ({
        ...p,
        minPriceText: formatPrice(p.skus.length > 0 ? p.skus[0].priceCents : 0)
      }));
      const merged = reset ? mapped : [...this.data.products, ...mapped];
      this.setData({
        products: merged,
        page: nextPage,
        hasMore: merged.length < res.total,
        loading: false,
        loadingMore: false
      });
    } catch (err: unknown) {
      this.setData({ loading: false, loadingMore: false });
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
