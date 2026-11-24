import crypto from 'node:crypto';
import type { AppConfig } from '../../config/env.js';
import { AppError, CriticalError } from '../../lib/errors.js';
import { formatBeijingRfc3339 } from '../../lib/time.js';

export { formatBeijingRfc3339 as formatWechatRfc3339 };

export interface JsapiPrepayInput {
  outTradeNo: string;
  description: string;
  totalAmountCents: number;
  openId: string;
  timeExpire?: Date;
}

export interface JsapiPayClientParams {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

export interface WechatRefundInput {
  outTradeNo: string;
  outRefundNo: string;
  refundAmountCents: number;
  totalAmountCents: number;
  reason: string;
}

export interface WechatCallbackEncryptedResource {
  algorithm: string;
  ciphertext: string;
  associated_data?: string;
  nonce: string;
}

export interface WechatPaySuccessPayload {
  out_trade_no: string;
  transaction_id: string;
  trade_state: string;
  amount: {
    total: number;
    payer_total: number;
  };
  success_time?: string;
}

export interface WechatRefundSuccessPayload {
  out_trade_no: string;
  out_refund_no: string;
  refund_id: string;
  refund_status: string;
  amount: {
    refund: number;
    total: number;
  };
}

/**
 * WeChat Pay V3 client implementing RSA-SHA256 request signing, callback verification,
 * AES-256-GCM decryption, JSAPI prepay, order query, and refund execution.
 */
export class WechatPayService {
  constructor(private readonly config: AppConfig) {}

  private requireLiveWechatConfig() {
    if (this.config.wechatMode !== 'live' || !this.config.wechat) {
      throw new CriticalError('WeChat Pay live credentials are not configured');
    }
    return this.config.wechat;
  }

  /**
   * Unified WeChat Pay V3 HTTP client with 10s abort timeout and safe non-JSON gateway handling.
   */
  public async requestWechatPayJson<T>(
    method: 'GET' | 'POST',
    canonicalUrl: string,
    payload?: unknown
  ): Promise<{ status: number; ok: boolean; data: T | null }> {
    const bodyJson = payload !== undefined ? JSON.stringify(payload) : '';
    const authorization = this.buildAuthorizationHeader(method, canonicalUrl, bodyJson);

    const response = await fetch(`https://api.mch.weixin.qq.com${canonicalUrl}`, {
      method,
      headers: {
        ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json',
        Authorization: authorization
      },
      ...(payload !== undefined ? { body: bodyJson } : {}),
      signal: AbortSignal.timeout(10_000)
    });

    const rawText = await response.text();
    if (rawText.trim().length === 0) {
      return { status: response.status, ok: response.ok, data: null };
    }

    try {
      const parsed = JSON.parse(rawText) as T;
      return { status: response.status, ok: response.ok, data: parsed };
    } catch {
      throw new CriticalError(
        `WeChat Pay returned non-JSON response (${response.status}): ${rawText.slice(0, 200)}`
      );
    }
  }

  /**
   * Sign an arbitrary message using the merchant RSA private key (RSA-SHA256).
   */
  public signWithMerchantKey(message: string, privateKeyPem: string): string {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(message, 'utf8');
    signer.end();
    return signer.sign(privateKeyPem, 'base64');
  }

  /**
   * Build the WECHATPAY2-SHA256-RSA2048 Authorization header for WeChat Pay V3 HTTP requests.
   */
  public buildAuthorizationHeader(method: string, canonicalUrl: string, bodyJson: string): string {
    const wechat = this.requireLiveWechatConfig();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const message = `${method.toUpperCase()}\n${canonicalUrl}\n${timestamp}\n${nonceStr}\n${bodyJson}\n`;
    const signature = this.signWithMerchantKey(message, wechat.mchPrivateKeyPem);

    return `WECHATPAY2-SHA256-RSA2048 mchid="${wechat.mchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${wechat.mchCertSerialNo}"`;
  }

  /**
   * Generate wx.requestPayment client parameters signed with the merchant private key.
   */
  public buildMiniProgramPayParams(prepayId: string): JsapiPayClientParams {
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const pkg = `prepay_id=${prepayId}`;

    if (this.config.wechatMode === 'sandbox_mock') {
      return {
        timeStamp,
        nonceStr,
        package: pkg,
        signType: 'RSA',
        paySign: `MOCK_RSA_SIGN_${prepayId}`
      };
    }

    const wechat = this.requireLiveWechatConfig();
    const message = `${wechat.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
    const paySign = this.signWithMerchantKey(message, wechat.mchPrivateKeyPem);
    return {
      timeStamp,
      nonceStr,
      package: pkg,
      signType: 'RSA',
      paySign
    };
  }

  /**
   * Create a WeChat Pay V3 JSAPI prepay order and return prepayId + Mini Program payment params.
   */
  public async createJsapiPrepay(
    input: JsapiPrepayInput
  ): Promise<{ prepayId: string; payParams: JsapiPayClientParams }> {
    if (input.totalAmountCents <= 0) {
      throw new AppError(400, 'INVALID_PAY_AMOUNT', '支付金额必须大于 0');
    }

    if (this.config.wechatMode === 'sandbox_mock') {
      const prepayId = `mock_prepay_${input.outTradeNo}`;
      return {
        prepayId,
        payParams: this.buildMiniProgramPayParams(prepayId)
      };
    }

    const wechat = this.requireLiveWechatConfig();
    const canonicalUrl = '/v3/pay/transactions/jsapi';
    const payload = {
      appid: wechat.appId,
      mchid: wechat.mchId,
      description: input.description.slice(0, 127),
      out_trade_no: input.outTradeNo,
      ...(input.timeExpire ? { time_expire: formatBeijingRfc3339(input.timeExpire) } : {}),
      notify_url: wechat.payNotifyUrl,
      amount: {
        total: input.totalAmountCents,
        currency: 'CNY'
      },
      payer: {
        openid: input.openId
      }
    };

    const res = await this.requestWechatPayJson<{
      prepay_id?: string;
      code?: string;
      message?: string;
    }>('POST', canonicalUrl, payload);

    if (!res.ok || !res.data?.prepay_id) {
      throw new CriticalError(
        `WeChat Pay JSAPI prepay failed (${res.status}): ${res.data?.code ?? ''} ${res.data?.message ?? 'Unknown error'}`
      );
    }

    return {
      prepayId: res.data.prepay_id,
      payParams: this.buildMiniProgramPayParams(res.data.prepay_id)
    };
  }

  /**
   * Query order payment status directly from WeChat Pay V3.
   * Returns null if WeChat reports ORDERNOTEXIST (prepay was never created or already purged).
   */
  public async queryOrderByOutTradeNo(outTradeNo: string): Promise<WechatPaySuccessPayload | null> {
    if (this.config.wechatMode === 'sandbox_mock') {
      throw new AppError(400, 'SANDBOX_QUERY_UNSUPPORTED', '沙箱模拟模式请通过模拟支付接口完成支付');
    }

    const wechat = this.requireLiveWechatConfig();
    const canonicalUrl = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(wechat.mchId)}`;
    const res = await this.requestWechatPayJson<
      WechatPaySuccessPayload & { code?: string; message?: string }
    >('GET', canonicalUrl);

    if (res.status === 404 && res.data?.code === 'ORDERNOTEXIST') {
      return null;
    }
    if (!res.ok || !res.data) {
      throw new CriticalError(
        `WeChat Pay order query failed (${res.status}): ${res.data?.code ?? ''} ${res.data?.message ?? ''}`
      );
    }
    return res.data;
  }

  /**
   * Close an unpaid WeChat Pay V3 order so its prepay_id cannot be paid after local cancellation.
   */
  public async closeOrder(outTradeNo: string): Promise<void> {
    if (this.config.wechatMode === 'sandbox_mock') {
      return;
    }

    const wechat = this.requireLiveWechatConfig();
    const canonicalUrl = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
    const res = await this.requestWechatPayJson<{ code?: string; message?: string }>(
      'POST',
      canonicalUrl,
      { mchid: wechat.mchId }
    );

    if (res.status === 204 || res.ok) {
      return;
    }
    if (res.data?.code === 'ORDERNOTEXIST' || res.data?.code === 'ORDER_CLOSED') {
      return;
    }
    throw new CriticalError(
      `WeChat Pay closeOrder failed (${res.status}): ${res.data?.code ?? ''} ${res.data?.message ?? ''}`
    );
  }

  /**
   * Execute a WeChat Pay V3 refund request.
   */
  public async createRefund(
    input: WechatRefundInput
  ): Promise<{ refundId: string; status: string }> {
    if (input.refundAmountCents <= 0 || input.refundAmountCents > input.totalAmountCents) {
      throw new AppError(400, 'INVALID_REFUND_AMOUNT', '退款金额不合法');
    }

    if (this.config.wechatMode === 'sandbox_mock') {
      return {
        refundId: `mock_refund_${input.outRefundNo}`,
        status: 'SUCCESS'
      };
    }

    const wechat = this.requireLiveWechatConfig();
    const canonicalUrl = '/v3/refund/domestic/refunds';
    const payload = {
      out_trade_no: input.outTradeNo,
      out_refund_no: input.outRefundNo,
      reason: input.reason.slice(0, 80),
      notify_url: wechat.refundNotifyUrl,
      amount: {
        refund: input.refundAmountCents,
        total: input.totalAmountCents,
        currency: 'CNY'
      }
    };

    const res = await this.requestWechatPayJson<{
      refund_id?: string;
      status?: string;
      code?: string;
      message?: string;
    }>('POST', canonicalUrl, payload);

    if (!res.ok || !res.data?.refund_id || !res.data?.status) {
      throw new CriticalError(
        `WeChat Pay refund failed (${res.status}): ${res.data?.code ?? ''} ${res.data?.message ?? ''}`
      );
    }

    return {
      refundId: res.data.refund_id,
      status: res.data.status
    };
  }

  /**
   * Query an existing WeChat Pay V3 refund status by merchant out_refund_no.
   */
  public async queryRefundByOutRefundNo(
    outRefundNo: string
  ): Promise<{ refundId: string; status: string }> {
    if (this.config.wechatMode === 'sandbox_mock') {
      return {
        refundId: `mock_refund_${outRefundNo}`,
        status: 'SUCCESS'
      };
    }

    this.requireLiveWechatConfig();
    const canonicalUrl = `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`;
    const res = await this.requestWechatPayJson<{
      refund_id?: string;
      status?: string;
      code?: string;
      message?: string;
    }>('GET', canonicalUrl);

    if (!res.ok || !res.data?.refund_id || !res.data?.status) {
      throw new CriticalError(
        `WeChat Pay queryRefund failed (${res.status}): ${res.data?.code ?? ''} ${res.data?.message ?? ''}`
      );
    }

    return {
      refundId: res.data.refund_id,
      status: res.data.status
    };
  }

  /**
   * Verify WeChat Pay V3 callback signature and 5-minute replay timestamp window.
   */
  public verifyCallbackSignature(
    headers: {
      timestamp?: string;
      nonce?: string;
      signature?: string;
      serial?: string;
    },
    rawBody: string,
    nowSeconds: number = Math.floor(Date.now() / 1000)
  ): void {
    const wechat = this.requireLiveWechatConfig();
    const { timestamp, nonce, signature, serial } = headers;
    if (!timestamp || !nonce || !signature || !serial) {
      throw new AppError(401, 'MISSING_WECHAT_SIGNATURE', '微信回调签名头缺失');
    }

    const tsNum = Number(timestamp);
    if (!Number.isInteger(tsNum) || tsNum <= 0) {
      throw new AppError(401, 'INVALID_WECHAT_TIMESTAMP', '微信回调时间戳格式非法');
    }
    if (Math.abs(nowSeconds - tsNum) > 300) {
      throw new AppError(401, 'EXPIRED_WECHAT_SIGNATURE', '微信回调签名已过期');
    }

    if (serial !== wechat.platformCertSerialNo) {
      throw new AppError(
        401,
        'WECHAT_SERIAL_MISMATCH',
        `微信平台证书/公钥序列号不匹配: ${serial}`
      );
    }

    const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(message, 'utf8');
    verifier.end();

    const verified = verifier.verify(wechat.platformPublicKeyPem, signature, 'base64');
    if (!verified) {
      throw new AppError(401, 'INVALID_WECHAT_SIGNATURE', '微信回调签名验签失败');
    }
  }

  /**
   * Decrypt AES-256-GCM AEAD_AES_256_GCM callback resource payload using APIv3 key.
   */
  public decryptCallbackResource<T>(resource: WechatCallbackEncryptedResource): T {
    if (resource.algorithm !== 'AEAD_AES_256_GCM') {
      throw new CriticalError(`Unsupported WeChat Pay cipher algorithm: ${resource.algorithm}`);
    }
    const wechat = this.requireLiveWechatConfig();
    return decryptAes256Gcm<T>(
      resource.ciphertext,
      wechat.apiV3Key,
      resource.nonce,
      resource.associated_data ?? ''
    );
  }
}

/**
 * Pure AES-256-GCM decryption helper matching WeChat Pay V3 AEAD_AES_256_GCM format.
 */
export function decryptAes256Gcm<T>(
  ciphertextBase64: string,
  apiV3Key: string,
  nonce: string,
  associatedData: string
): T {
  const keyBuf = Buffer.from(apiV3Key, 'utf8');
  if (keyBuf.byteLength !== 32) {
    throw new CriticalError('APIv3 key must be 32 bytes for AES-256-GCM decryption');
  }
  const cipherBuf = Buffer.from(ciphertextBase64, 'base64');
  if (cipherBuf.byteLength <= 16) {
    throw new CriticalError('Encrypted WeChat Pay ciphertext is too short');
  }

  const authTag = cipherBuf.subarray(cipherBuf.byteLength - 16);
  const encryptedData = cipherBuf.subarray(0, cipherBuf.byteLength - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (associatedData.length > 0) {
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  }

  const plaintext = Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext) as T;
}
