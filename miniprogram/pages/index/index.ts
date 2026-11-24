import { formatPrice } from '../../utils/format';
import { apiRequest } from '../../utils/request';
import type { ProductDto } from '../../utils/types';

interface DisplayProduct extends ProductDto {
  minPriceText: string;
}

const PAGE_SIZE = 20;

Page({
  data: {
    keyword: '',
    loading: true,
    loadingMore: false,
    page: 1,
    hasMore: true,
    products: [] as DisplayProduct[]
  },

  onLoad() {
    this.loadProducts(true);
  },

  onPullDownRefresh() {
    this.loadProducts(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.loading && !this.data.loadingMore && this.data.hasMore) {
      this.loadProducts(false);
    }
  },

  onKeywordInput(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    this.loadProducts(true);
  },

  async loadProducts(reset: boolean) {
    const nextPage = reset ? 1 : this.data.page + 1;
    if (reset) {
      this.setData({ loading: true });
    } else {
      this.setData({ loadingMore: true });
    }

    try {
      const q = this.data.keyword.trim();
      const params = [`page=${nextPage}`, `pageSize=${PAGE_SIZE}`];
      if (q) {
        params.push(`keyword=${encodeURIComponent(q)}`);
      }

      const res = await apiRequest<{ total: number; items: ProductDto[] }>({
        url: `/api/products?${params.join('&')}`,
        requireAuth: false
      });

      const mapped: DisplayProduct[] = res.items.map((p) => {
        const minCents = p.skus.length > 0 ? p.skus[0].priceCents : 0;
        return {
          ...p,
          minPriceText: formatPrice(minCents)
        };
      });

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
      const msg = err instanceof Error ? err.message : '加载商品失败';
      wx.showToast({ title: msg, icon: 'none' });
    }
  },

  goDetail(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    wx.navigateTo({ url: `/pages/product-detail/product-detail?id=${id}` });
  }
});
