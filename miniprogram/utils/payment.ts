import { apiRequest } from './request';

interface PayInitResponse {
  orderNo: string;
  totalAmountCents: number;
  payParams: {
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: 'RSA';
    paySign: string;
  };
}

/**
 * Shared WeChat JSAPI / sandbox payment execution service.
 * Returns 'PAID' when payment is confirmed, or 'CANCELLED' when user aborts payment.
 */
export async function executeOrderPayment(
  orderId: number,
  options: { promptInMock: boolean }
): Promise<'PAID' | 'CANCELLED'> {
  const payInit = await apiRequest<PayInitResponse>({
    url: `/api/orders/${orderId}/pay`,
    method: 'POST'
  });

  if (payInit.payParams.paySign.startsWith('MOCK_RSA_SIGN_')) {
    if (options.promptInMock) {
      const confirmed = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '本地沙箱联调提示',
          content: '当前后端处于 sandbox_mock 联调模式，是否触发模拟支付完成以验证全流程？',
          confirmText: '确认模拟支付',
          cancelText: '稍后付款',
          success: (res) => resolve(res.confirm),
          fail: () => resolve(false)
        });
      });
      if (!confirmed) {
        return 'CANCELLED';
      }
    }

    await apiRequest({
      url: '/api/dev/mock-pay-notify',
      method: 'POST',
      data: { orderNo: payInit.orderNo }
    });
    return 'PAID';
  }

  const paid = await new Promise<boolean>((resolve, reject) => {
    wx.requestPayment({
      ...payInit.payParams,
      success: () => resolve(true),
      fail: (err) => {
        if (err.errMsg.includes('cancel')) {
          resolve(false);
        } else {
          reject(new Error(`微信支付失败: ${err.errMsg}`));
        }
      }
    });
  });

  if (!paid) {
    return 'CANCELLED';
  }

  await apiRequest({
    url: `/api/orders/${orderId}/sync-pay`,
    method: 'POST'
  });
  return 'PAID';
}
