import { formatPrice, ORDER_STATUS_LABEL } from '../../utils/format';
import { apiRequest } from '../../utils/request';
import type { OrderDto } from '../../utils/types';

interface DisplayOrder extends OrderDto {
  statusLabel: string;
  totalAmountText: string;
  formattedItems: Array<OrderDto['items'][number] & { unitPriceText: string }>;
}

const TABS = [
  { key: 'ALL', label: '全部' },
  { key: 'PENDING_PAYMENT', label: '待付款' },
  { key: 'PENDING_SHIPMENT', label: '待发货' },
  { key: 'SHIPPED', label: '待收货' },
  { key: 'REFUND_REQUESTED', label: '售后' }
];

const PAGE_SIZE = 20;

Page({
  data: {
    tabs: TABS,
    activeTab: 'ALL',
    orders: [] as DisplayOrder[],
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false
  },

  onLoad(options: { status?: string }) {
    if (options.status) {
      this.setData({ activeTab: options.status });
    }
  },

  onShow() {
    this.loadOrders(true);
  },

  onReachBottom() {
    if (!this.data.loading && !this.data.loadingMore && this.data.hasMore) {
      this.loadOrders(false);
    }
  },

  async onSwitchTab(e: WechatMiniprogram.TouchEvent) {
    const status = e.currentTarget.dataset.key as string;
    this.setData({ activeTab: status });
    await this.loadOrders(true);
  },

  async loadOrders(reset: boolean) {
    const nextPage = reset ? 1 : this.data.page + 1;
    if (reset) {
      this.setData({ loading: true });
    } else {
      this.setData({ loadingMore: true });
    }

    try {
      const res = await apiRequest<{ total: number; items: OrderDto[] }>({
        url: `/api/orders?status=${encodeURIComponent(this.data.activeTab)}&page=${nextPage}&pageSize=${PAGE_SIZE}`
      });

      const mapped: DisplayOrder[] = res.items.map((o) => ({
        ...o,
        statusLabel: ORDER_STATUS_LABEL[o.status] ?? o.status,
        totalAmountText: formatPrice(o.totalAmountCents),
        formattedItems: o.items.map((item) => ({
          ...item,
          unitPriceText: formatPrice(item.unitPriceCents)
        }))
      }));

      const merged = reset ? mapped : [...this.data.orders, ...mapped];
      this.setData({
        orders: merged,
        page: nextPage,
        hasMore: merged.length < res.total,
        loading: false,
        loadingMore: false
      });
    } catch (err: unknown) {
      this.setData({ loading: false, loadingMore: false });
      wx.showToast({
        title: err instanceof Error ? err.message : '加载订单失败',
        icon: 'none'
      });
    }
  },

  goOrderDetail(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${id}` });
  }
});
