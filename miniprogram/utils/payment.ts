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

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared WeChat JSAPI / sandbox payment execution service.
 * Returns 'PAID' when confirmed, 'PENDING' if bank settlement is still propagating,
 * or 'CANCELLED' when the buyer aborts payment.
 */
export async function executeOrderPayment(
  orderId: number,
  options: { promptInMock: boolean }
): Promise<'PAID' | 'PENDING' | 'CANCELLED'> {
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

  // Poll sync-pay up to 3 times to absorb transient bank USERPAYING settlement delay
  const retryDelays = [0, 1000, 1500];
  for (const waitMs of retryDelays) {
    if (waitMs > 0) {
      await delayMs(waitMs);
    }
    const synced = await apiRequest<{ status: string }>({
      url: `/api/orders/${orderId}/sync-pay`,
      method: 'POST'
    });
    if (synced.status !== 'PENDING_PAYMENT') {
      return 'PAID';
    }
  }

  return 'PENDING';
}
