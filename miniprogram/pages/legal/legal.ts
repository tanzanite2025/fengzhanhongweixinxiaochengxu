import { APP_CONFIG } from '../../utils/config';

Page({
  data: {
    title: '隐私政策',
    content: ''
  },

  onLoad(options: { doc?: string }) {
    const isTerms = options.doc === 'terms';
    wx.setNavigationBarTitle({
      title: isTerms ? '用户协议与退换货说明' : '隐私政策'
    });

    const content = isTerms
      ? `本商城由 ${APP_CONFIG.MERCHANT_NAME} 运营。商品下单后支持 7 天无理由退换货（生鲜/定制等特殊说明商品除外），未发货订单可直接申请极速退款；已发货订单请保持商品及包装完好并联系客服退回后退款。客服电话：${APP_CONFIG.SERVICE_PHONE}。`
      : `本商城由 ${APP_CONFIG.MERCHANT_NAME} 运营，我们严格遵守《个人信息保护法》及微信小程序隐私规范，仅在订单履约、收货地址配送及售后退款必要范围内使用您的微信登录标识与收货信息，绝不向无关第三方出售或共享。`;

    this.setData({
      title: isTerms ? '用户协议与退换货说明' : '隐私政策',
      content
    });
  }
});
