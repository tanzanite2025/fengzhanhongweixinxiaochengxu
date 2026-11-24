import { APP_CONFIG } from '../../utils/config';

Page({
  data: {
    merchantName: APP_CONFIG.MERCHANT_NAME,
    servicePhone: APP_CONFIG.SERVICE_PHONE
  },

  goOrders(e: WechatMiniprogram.TouchEvent) {
    const status = (e.currentTarget.dataset.status as string) ?? 'ALL';
    wx.navigateTo({ url: `/pages/order-list/order-list?status=${status}` });
  },

  goAddress() {
    wx.navigateTo({ url: '/pages/address/address' });
  },

  goLegal(e: WechatMiniprogram.TouchEvent) {
    const doc = (e.currentTarget.dataset.doc as string) ?? 'privacy';
    wx.navigateTo({ url: `/pages/legal/legal?doc=${doc}` });
  }
});
