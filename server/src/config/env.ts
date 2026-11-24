import fs from 'node:fs';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535),
  HOST: z.string().min(1),
  BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().min(1),
  ORDER_EXPIRE_MINUTES: z.coerce.number().int().min(1).max(1440),
  WECHAT_MODE: z.enum(['sandbox_mock', 'live']),

  WECHAT_APP_ID: z.string().optional(),
  WECHAT_APP_SECRET: z.string().optional(),
  WECHAT_MCH_ID: z.string().optional(),
  WECHAT_API_V3_KEY: z.string().optional(),
  WECHAT_MCH_CERT_SERIAL_NO: z.string().optional(),
  WECHAT_MCH_PRIVATE_KEY_PATH: z.string().optional(),
  WECHAT_PLATFORM_CERT_SERIAL_NO: z.string().optional(),
  WECHAT_PLATFORM_PUBLIC_KEY_PATH: z.string().optional(),
  WECHAT_PAY_NOTIFY_URL: z.string().optional(),
  WECHAT_REFUND_NOTIFY_URL: z.string().optional()
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  baseUrl: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  orderExpireMinutes: number;
  wechatMode: 'sandbox_mock' | 'live';
  wechat: {
    appId: string;
    appSecret: string;
    mchId: string;
    apiV3Key: string;
    mchCertSerialNo: string;
    mchPrivateKeyPem: string;
    platformCertSerialNo: string;
    platformPublicKeyPem: string;
    payNotifyUrl: string;
    refundNotifyUrl: string;
  } | null;
}

function readRequiredPemFile(filePath: string | undefined, label: string): string {
  if (!filePath || filePath.trim().length === 0) {
    throw new Error(`[CRITICAL] Missing required certificate/key path for ${label}`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`[CRITICAL] Certificate/key file not found for ${label}: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (content.length === 0) {
    throw new Error(`[CRITICAL] Certificate/key file is empty for ${label}: ${filePath}`);
  }
  return content;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`[CRITICAL] Missing required environment variable: ${name}`);
  }
  return value.trim();
}

/**
 * Load and strictly validate application configuration from process.env.
 * Throws a blocking [CRITICAL] error if any required setting is absent or invalid.
 */
export function loadConfig(sourceEnv: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(sourceEnv);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`[CRITICAL] Environment configuration validation failed: ${details}`);
  }

  const data = parsed.data;

  if (data.NODE_ENV === 'production' && data.WECHAT_MODE !== 'live') {
    throw new Error('[CRITICAL] WECHAT_MODE=sandbox_mock is strictly forbidden when NODE_ENV=production');
  }

  if (data.WECHAT_MODE === 'live') {
    const apiV3Key = requireNonEmpty(data.WECHAT_API_V3_KEY, 'WECHAT_API_V3_KEY');
    if (Buffer.byteLength(apiV3Key, 'utf8') !== 32) {
      throw new Error('[CRITICAL] WECHAT_API_V3_KEY must be exactly 32 UTF-8 bytes');
    }

    return {
      nodeEnv: data.NODE_ENV,
      port: data.PORT,
      host: data.HOST,
      baseUrl: data.BASE_URL.replace(/\/+$/, ''),
      databaseUrl: data.DATABASE_URL,
      jwtSecret: data.JWT_SECRET,
      jwtExpiresIn: data.JWT_EXPIRES_IN,
      orderExpireMinutes: data.ORDER_EXPIRE_MINUTES,
      wechatMode: 'live',
      wechat: {
        appId: requireNonEmpty(data.WECHAT_APP_ID, 'WECHAT_APP_ID'),
        appSecret: requireNonEmpty(data.WECHAT_APP_SECRET, 'WECHAT_APP_SECRET'),
        mchId: requireNonEmpty(data.WECHAT_MCH_ID, 'WECHAT_MCH_ID'),
        apiV3Key,
        mchCertSerialNo: requireNonEmpty(data.WECHAT_MCH_CERT_SERIAL_NO, 'WECHAT_MCH_CERT_SERIAL_NO'),
        mchPrivateKeyPem: readRequiredPemFile(data.WECHAT_MCH_PRIVATE_KEY_PATH, 'WECHAT_MCH_PRIVATE_KEY_PATH'),
        platformCertSerialNo: requireNonEmpty(
          data.WECHAT_PLATFORM_CERT_SERIAL_NO,
          'WECHAT_PLATFORM_CERT_SERIAL_NO'
        ),
        platformPublicKeyPem: readRequiredPemFile(
          data.WECHAT_PLATFORM_PUBLIC_KEY_PATH,
          'WECHAT_PLATFORM_PUBLIC_KEY_PATH'
        ),
        payNotifyUrl: requireNonEmpty(data.WECHAT_PAY_NOTIFY_URL, 'WECHAT_PAY_NOTIFY_URL'),
        refundNotifyUrl: requireNonEmpty(data.WECHAT_REFUND_NOTIFY_URL, 'WECHAT_REFUND_NOTIFY_URL')
      }
    };
  }

  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    host: data.HOST,
    baseUrl: data.BASE_URL.replace(/\/+$/, ''),
    databaseUrl: data.DATABASE_URL,
    jwtSecret: data.JWT_SECRET,
    jwtExpiresIn: data.JWT_EXPIRES_IN,
    orderExpireMinutes: data.ORDER_EXPIRE_MINUTES,
    wechatMode: 'sandbox_mock',
    wechat: null
  };
}
