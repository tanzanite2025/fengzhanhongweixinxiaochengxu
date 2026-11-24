import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { validateUploadedImage } from '../src/lib/image-validation.js';
import { formatBeijingRfc3339 } from '../src/lib/time.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { verifyAndDecryptWechatCallback } from '../src/modules/wechat-pay/wechat-callback.js';
import {
  decryptAes256Gcm,
  formatWechatRfc3339,
  WechatPayService
} from '../src/modules/wechat-pay/wechat-pay.service.js';
import {
  EXPRESS_COMPANIES,
  maskPhoneForWechat
} from '../src/modules/wechat-shipping/wechat-shipping.service.js';

describe('Config & WeChat Pay V3 Cryptography', () => {
  it('fails loudly when production mode tries to enable sandbox_mock', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PORT: '3001',
        HOST: '0.0.0.0',
        BASE_URL: 'https://shop.example.com',
        DATABASE_URL: 'file:./prod.db',
        JWT_SECRET: 'super-strong-secret-at-least-32-chars',
        JWT_EXPIRES_IN: '7d',
        ORDER_EXPIRE_MINUTES: '15',
        WECHAT_MODE: 'sandbox_mock'
      })
    ).toThrow('[CRITICAL]');
  });

  it('fails loudly when WECHAT_MODE=live without WeChat credentials', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        PORT: '3001',
        HOST: '0.0.0.0',
        BASE_URL: 'http://localhost:3001',
        DATABASE_URL: 'file:./dev.db',
        JWT_SECRET: 'super-strong-secret-at-least-32-chars',
        JWT_EXPIRES_IN: '7d',
        ORDER_EXPIRE_MINUTES: '15',
        WECHAT_MODE: 'live'
      })
    ).toThrow('[CRITICAL]');
  });

  it('verifies RSA-SHA256 callback signatures and rejects tampered payloads', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const apiV3Key = '12345678901234567890123456789012';
    const service = new WechatPayService({
      nodeEnv: 'test',
      port: 3001,
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:3001',
      databaseUrl: 'file:./test.db',
      jwtSecret: 'test-jwt-secret-at-least-32-bytes',
      jwtExpiresIn: '1d',
      orderExpireMinutes: 15,
      wechatMode: 'live',
      wechat: {
        appId: 'wx_test_app',
        appSecret: 'wx_test_secret',
        mchId: '1900000001',
        apiV3Key,
        mchCertSerialNo: 'MCH_SERIAL_1',
        mchPrivateKeyPem: privateKey,
        platformCertSerialNo: 'PLAT_SERIAL_1',
        platformPublicKeyPem: publicKey,
        payNotifyUrl: 'https://shop.example.com/api/wechat/pay-notify',
        refundNotifyUrl: 'https://shop.example.com/api/wechat/refund-notify'
      }
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const timestamp = String(nowSec);
    const nonce = 'nonce123456';
    const rawBody = JSON.stringify({ event_type: 'TRANSACTION.SUCCESS' });
    const signature = service.signWithMerchantKey(`${timestamp}\n${nonce}\n${rawBody}\n`, privateKey);

    expect(() =>
      service.verifyCallbackSignature(
        { timestamp, nonce, signature, serial: 'PLAT_SERIAL_1' },
        rawBody,
        nowSec
      )
    ).not.toThrow();

    expect(() =>
      service.verifyCallbackSignature(
        { timestamp: String(nowSec - 600), nonce, signature, serial: 'PLAT_SERIAL_1' },
        rawBody,
        nowSec
      )
    ).toThrow('已过期');

    expect(() =>
      service.verifyCallbackSignature(
        { timestamp, nonce, signature, serial: 'PLAT_SERIAL_1' },
        JSON.stringify({ event_type: 'TAMPERED' }),
        nowSec
      )
    ).toThrow('验签失败');

    expect(() =>
      service.verifyCallbackSignature(
        { timestamp, nonce, signature, serial: 'WRONG_SERIAL' },
        rawBody,
        nowSec
      )
    ).toThrow('序列号不匹配');
  });

  it('decrypts AES-256-GCM WeChat Pay V3 callback resource', () => {
    const apiV3Key = 'abcdefghijklmnopqrstuvwxyz123456';
    const nonce = '123456789012';
    const aad = 'transaction';
    const plain = {
      out_trade_no: 'ORD202611230001',
      transaction_id: '4200001234567890',
      trade_state: 'SUCCESS',
      amount: { total: 6800, payer_total: 6800 }
    };

    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      Buffer.from(apiV3Key, 'utf8'),
      Buffer.from(nonce, 'utf8')
    );
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const ciphertextBase64 = Buffer.concat([encrypted, authTag]).toString('base64');

    const decoded = decryptAes256Gcm<typeof plain>(ciphertextBase64, apiV3Key, nonce, aad);
    expect(decoded).toEqual(plain);
  });

  it('verifies callback using exact rawBody whitespace rather than re-serialized JSON', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const apiV3Key = 'abcdefghijklmnopqrstuvwxyz123456';
    const nonce = '123456789012';
    const aad = 'transaction';
    const plain = {
      out_trade_no: 'ORD_RAW_BODY_1',
      transaction_id: 'TX_RAW_1',
      trade_state: 'SUCCESS',
      amount: { total: 5000, payer_total: 5000 }
    };

    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      Buffer.from(apiV3Key, 'utf8'),
      Buffer.from(nonce, 'utf8')
    );
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
    const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');

    // Pretty-printed JSON with extra whitespace/newlines (different from JSON.stringify output)
    const prettyRawBody = JSON.stringify(
      {
        event_type: 'TRANSACTION.SUCCESS',
        resource: {
          algorithm: 'AEAD_AES_256_GCM',
          ciphertext,
          associated_data: aad,
          nonce
        }
      },
      null,
      2
    );

    const service = new WechatPayService({
      nodeEnv: 'test',
      port: 3001,
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:3001',
      databaseUrl: 'file:./test.db',
      jwtSecret: 'test-jwt-secret-at-least-32-bytes',
      jwtExpiresIn: '1d',
      orderExpireMinutes: 15,
      wechatMode: 'live',
      wechat: {
        appId: 'wx_test_app',
        appSecret: 'wx_test_secret',
        mchId: '1900000001',
        apiV3Key,
        mchCertSerialNo: 'MCH_SERIAL_1',
        mchPrivateKeyPem: privateKey,
        platformCertSerialNo: 'PLAT_SERIAL_1',
        platformPublicKeyPem: publicKey,
        payNotifyUrl: 'https://shop.example.com/api/wechat/pay-notify',
        refundNotifyUrl: 'https://shop.example.com/api/wechat/refund-notify'
      }
    });

    const timestamp = String(Math.floor(Date.now() / 1000));
    const headerNonce = 'hdr_nonce';
    const signature = service.signWithMerchantKey(
      `${timestamp}\n${headerNonce}\n${prettyRawBody}\n`,
      privateKey
    );

    const fakeRequest = {
      rawBody: prettyRawBody,
      body: JSON.parse(prettyRawBody),
      headers: {
        'wechatpay-timestamp': timestamp,
        'wechatpay-nonce': headerNonce,
        'wechatpay-signature': signature,
        'wechatpay-serial': 'PLAT_SERIAL_1'
      }
    } as unknown as FastifyRequest;

    const result = verifyAndDecryptWechatCallback<typeof plain>(
      fakeRequest,
      service,
      'TRANSACTION.SUCCESS'
    );
    expect(result.eventType).toBe('TRANSACTION.SUCCESS');
    expect(result.payload).toEqual(plain);
  });

  it('validates real image magic bytes and rejects forged extensions', () => {
    const validPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
    ]);
    expect(validateUploadedImage('demo.PNG', validPng)).toBe('.png');

    const fakeJpg = Buffer.from('console.log("not an image")', 'utf8');
    expect(() => validateUploadedImage('evil.jpg', fakeJpg)).toThrow('不匹配');
  });

  it('formats Beijing time RFC3339 timestamps for WeChat Pay time_expire and blocks mock_openid in live mode', async () => {
    expect(formatWechatRfc3339(new Date('2026-11-24T10:30:05.000Z'))).toBe(
      '2026-11-24T18:30:05+08:00'
    );

    const fakePrisma = {
      user: {
        findUnique: async () => ({ id: 9, openId: 'mock_openid_old_dev' })
      }
    } as unknown as ConstructorParameters<typeof AuthService>[0];

    const auth = new AuthService(fakePrisma, {
      nodeEnv: 'production',
      port: 3001,
      host: '0.0.0.0',
      baseUrl: 'https://shop.example.com',
      databaseUrl: 'file:./prod.db',
      jwtSecret: 'prod-jwt-secret-at-least-32-chars!',
      jwtExpiresIn: '7d',
      orderExpireMinutes: 15,
      wechatMode: 'live',
      wechat: null
    });

    const token = auth.signToken(9, 'USER');
    await expect(
      auth.requireUserAuth(
        { headers: { authorization: `Bearer ${token}` } } as unknown as FastifyRequest,
        {} as never
      )
    ).rejects.toThrow('重新授权登录');
  });

  it('validates WeChat shipping formatting, JTSD express code, and production HTTPS URLs', () => {
    expect(formatBeijingRfc3339(new Date('2026-11-24T10:30:05.120Z'), true)).toBe(
      '2026-11-24T18:30:05.120+08:00'
    );
    expect(maskPhoneForWechat('13800138000')).toBe('138****8000');
    expect(EXPRESS_COMPANIES.find((c) => c.name === '极兔速递')?.code).toBe('JTSD');

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PORT: '3001',
        HOST: '0.0.0.0',
        BASE_URL: 'http://shop.example.com',
        DATABASE_URL: 'file:./prod.db',
        JWT_SECRET: 'super-strong-secret-at-least-32-chars',
        JWT_EXPIRES_IN: '7d',
        ORDER_EXPIRE_MINUTES: '15',
        WECHAT_MODE: 'live'
      })
    ).toThrow('https://');
  });

  it('handles non-JSON WeChat Pay gateway errors cleanly and decrypts multi-event refund callbacks', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const apiV3Key = 'abcdefghijklmnopqrstuvwxyz123456';
    const service = new WechatPayService({
      nodeEnv: 'test',
      port: 3001,
      host: '127.0.0.1',
      baseUrl: 'https://shop.example.com',
      databaseUrl: 'file:./test.db',
      jwtSecret: 'test-jwt-secret-at-least-32-bytes',
      jwtExpiresIn: '1d',
      orderExpireMinutes: 15,
      wechatMode: 'live',
      wechat: {
        appId: 'wx_test_app',
        appSecret: 'wx_test_secret',
        mchId: '1900000001',
        apiV3Key,
        mchCertSerialNo: 'MCH_SERIAL_1',
        mchPrivateKeyPem: privateKey,
        platformCertSerialNo: 'PLAT_SERIAL_1',
        platformPublicKeyPem: publicKey,
        payNotifyUrl: 'https://shop.example.com/api/wechat/pay-notify',
        refundNotifyUrl: 'https://shop.example.com/api/wechat/refund-notify'
      }
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' }
      });

    try {
      await expect(service.requestWechatPayJson('GET', '/v3/test')).rejects.toThrow('non-JSON');
    } finally {
      globalThis.fetch = originalFetch;
    }

    const nonce = '123456789012';
    const aad = 'refund';
    const plain = {
      out_trade_no: 'ORD_RF_1',
      out_refund_no: 'RF_1',
      refund_id: 'WX_RF_1',
      refund_status: 'ABNORMAL',
      amount: { refund: 1000, total: 1000 }
    };
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      Buffer.from(apiV3Key, 'utf8'),
      Buffer.from(nonce, 'utf8')
    );
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
    const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');

    const rawBody = JSON.stringify({
      event_type: 'REFUND.ABNORMAL',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext,
        associated_data: aad,
        nonce
      }
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headerNonce = 'rf_nonce';
    const signature = service.signWithMerchantKey(
      `${timestamp}\n${headerNonce}\n${rawBody}\n`,
      privateKey
    );

    const decoded = verifyAndDecryptWechatCallback<typeof plain>(
      {
        rawBody,
        body: JSON.parse(rawBody),
        headers: {
          'wechatpay-timestamp': timestamp,
          'wechatpay-nonce': headerNonce,
          'wechatpay-signature': signature,
          'wechatpay-serial': 'PLAT_SERIAL_1'
        }
      } as unknown as FastifyRequest,
      service,
      ['REFUND.SUCCESS', 'REFUND.ABNORMAL', 'REFUND.CLOSED']
    );
    expect(decoded.eventType).toBe('REFUND.ABNORMAL');
    expect(decoded.payload?.refund_status).toBe('ABNORMAL');
  });
});
