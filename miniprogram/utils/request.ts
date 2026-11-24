import { APP_CONFIG } from './config';

const TOKEN_STORAGE_KEY = 'buyer_token';
const USER_ID_STORAGE_KEY = 'buyer_user_id';

interface ApiErrorBody {
  code?: string;
  message?: string;
}

let pendingLoginPromise: Promise<string> | null = null;

/**
 * Perform WeChat login strictly exchanging wx.login code for { token, userId }.
 */
export async function ensureLogin(): Promise<string> {
  const existing = wx.getStorageSync(TOKEN_STORAGE_KEY) as string | undefined;
  if (existing && existing.length > 0) {
    return existing;
  }

  if (pendingLoginPromise) {
    return pendingLoginPromise;
  }

  pendingLoginPromise = (async () => {
    const loginRes = await new Promise<WechatMiniprogram.LoginSuccessCallbackResult>(
      (resolve, reject) => {
        wx.login({
          success: resolve,
          fail: (err) => reject(new Error(`微信登录凭证获取失败: ${err.errMsg}`))
        });
      }
    );

    if (!loginRes.code) {
      throw new Error('微信登录未返回有效 code');
    }

    const res = await new Promise<WechatMiniprogram.RequestSuccessCallbackResult>(
      (resolve, reject) => {
        wx.request({
          url: `${APP_CONFIG.API_BASE_URL}/api/auth/wechat-login`,
          method: 'POST',
          data: { code: loginRes.code },
          header: { 'Content-Type': 'application/json' },
          success: resolve,
          fail: (err) => reject(new Error(`登录接口请求失败: ${err.errMsg}`))
        });
      }
    );

    if (res.statusCode !== 200) {
      const errBody = res.data as ApiErrorBody;
      throw new Error(errBody.message ?? `登录失败 (${res.statusCode})`);
    }

    const body = res.data as { token?: string; userId?: number };
    if (!body.token || typeof body.userId !== 'number') {
      throw new Error('[CRITICAL] 登录响应缺少 token 或 userId');
    }

    wx.setStorageSync(TOKEN_STORAGE_KEY, body.token);
    wx.setStorageSync(USER_ID_STORAGE_KEY, body.userId);
    return body.token;
  })();

  try {
    return await pendingLoginPromise;
  } finally {
    pendingLoginPromise = null;
  }
}

export interface RequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: unknown;
  requireAuth?: boolean;
}

/**
 * Unified Mini Program HTTP client with automatic 401 re-login and explicit fail-loudly errors.
 */
export async function apiRequest<T>(options: RequestOptions): Promise<T> {
  const requireAuth = options.requireAuth !== false;
  let token = requireAuth ? await ensureLogin() : '';

  const execute = (authToken: string) =>
    new Promise<WechatMiniprogram.RequestSuccessCallbackResult>((resolve, reject) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }
      wx.request({
        url: `${APP_CONFIG.API_BASE_URL}${options.url}`,
        method: options.method ?? 'GET',
        data: options.data as string | Record<string, unknown> | ArrayBuffer | undefined,
        header: headers,
        success: resolve,
        fail: (err) => reject(new Error(`网络请求失败: ${err.errMsg}`))
      });
    });

  let response = await execute(token);

  if (response.statusCode === 401 && requireAuth) {
    wx.removeStorageSync(TOKEN_STORAGE_KEY);
    token = await ensureLogin();
    response = await execute(token);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errBody = response.data as ApiErrorBody;
    throw new Error(errBody.message ?? `请求失败 (${response.statusCode})`);
  }

  return response.data as T;
}
