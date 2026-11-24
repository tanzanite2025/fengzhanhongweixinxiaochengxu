import type { AppConfig } from '../../config/env.js';
import { AppError, CriticalError } from '../../lib/errors.js';
import { formatBeijingRfc3339 } from '../../lib/time.js';

export const EXPRESS_COMPANIES = [
  { code: 'SF', name: '顺丰速运' },
  { code: 'ZTO', name: '中通快递' },
  { code: 'YTO', name: '圆通速递' },
  { code: 'STO', name: '申通快递' },
  { code: 'YD', name: '韵达速递' },
  { code: 'JD', name: '京东物流' },
  { code: 'EMS', name: '中国邮政EMS' },
  { code: 'JTSD', name: '极兔速递' }
] as const;

export interface UploadShippingInput {
  outTradeNo: string;
  transactionId: string | null;
  openId: string;
  receiverPhone: string;
  expressCompanyCode: string;
  trackingNumber: string;
  itemDesc: string;
}

/**
 * Mask receiver phone per WeChat upload_shipping_info spec: last 4 digits must remain visible.
 */
export function maskPhoneForWechat(phone: string): string {
  const cleaned = phone.trim();
  if (cleaned.length <= 4) {
    return `****${cleaned}`;
  }
  if (cleaned.length >= 11) {
    return `${cleaned.slice(0, 3)}****${cleaned.slice(-4)}`;
  }
  return `****${cleaned.slice(-4)}`;
}

/**
 * Service integrating WeChat Mini Program Shipping Information Management
 * (POST /wxa/sec/order/upload_shipping_info).
 */
export class WechatShippingService {
  private cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

  constructor(private readonly config: AppConfig) {}

  /**
   * Resolve a known express company name from its standard code.
   */
  public resolveExpressName(code: string): string {
    const found = EXPRESS_COMPANIES.find((c) => c.code === code);
    if (!found) {
      throw new AppError(400, 'INVALID_EXPRESS_COMPANY', `不支持的快递公司编码: ${code}`);
    }
    return found.name;
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (this.config.wechatMode !== 'live' || !this.config.wechat) {
      throw new CriticalError('WeChat credentials missing for access_token retrieval');
    }

    const now = Date.now();
    if (!forceRefresh && this.cachedAccessToken && this.cachedAccessToken.expiresAtMs - 120_000 > now) {
      return this.cachedAccessToken.token;
    }

    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', this.config.wechat.appId);
    url.searchParams.set('secret', this.config.wechat.appSecret);

    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new CriticalError(`WeChat getAccessToken HTTP error: ${response.status}`);
    }
    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      errcode?: number;
      errmsg?: string;
    };

    if (!data.access_token || !data.expires_in) {
      throw new CriticalError(
        `WeChat getAccessToken failed (${data.errcode ?? 'unknown'}): ${data.errmsg ?? 'missing token'}`
      );
    }

    this.cachedAccessToken = {
      token: data.access_token,
      expiresAtMs: now + data.expires_in * 1000
    };
    return data.access_token;
  }

  /**
   * Upload physical shipping logistics information to WeChat so escrowed funds can settle.
   * Automatically refreshes access_token once if WeChat reports 40001/42001.
   */
  public async uploadShippingInfo(input: UploadShippingInput): Promise<void> {
    this.resolveExpressName(input.expressCompanyCode);

    if (this.config.wechatMode === 'sandbox_mock') {
      return;
    }

    const wechat = this.config.wechat;
    if (!wechat) {
      throw new CriticalError('WeChat config missing in live mode');
    }

    const orderKey = input.transactionId
      ? {
          order_number_type: 2,
          transaction_id: input.transactionId
        }
      : {
          order_number_type: 1,
          mchid: wechat.mchId,
          out_trade_no: input.outTradeNo
        };

    const payload = {
      order_key: orderKey,
      logistics_type: 1, // 1 = 实体物流配送
      delivery_mode: 1, // 1 = 统一发货
      shipping_list: [
        {
          tracking_no: input.trackingNumber,
          express_company: input.expressCompanyCode,
          item_desc: input.itemDesc.slice(0, 120),
          contact: {
            receiver_contact: maskPhoneForWechat(input.receiverPhone)
          }
        }
      ],
      upload_time: formatBeijingRfc3339(new Date(), true),
      payer: {
        openid: input.openId
      }
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await this.getAccessToken(attempt > 0);
      const url = `https://api.weixin.qq.com/wxa/sec/order/upload_shipping_info?access_token=${encodeURIComponent(accessToken)}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000)
      });

      if (!response.ok) {
        throw new CriticalError(`WeChat upload_shipping_info HTTP error: ${response.status}`);
      }

      const resData = (await response.json()) as { errcode?: number; errmsg?: string };
      if (resData.errcode === 0) {
        return;
      }

      if ((resData.errcode === 40001 || resData.errcode === 42001) && attempt === 0) {
        this.cachedAccessToken = null;
        continue;
      }

      throw new CriticalError(
        `WeChat upload_shipping_info failed (${resData.errcode}): ${resData.errmsg ?? 'Unknown error'}`
      );
    }
  }
}
