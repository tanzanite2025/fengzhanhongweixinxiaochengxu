const ADMIN_TOKEN_KEY = 'admin_token';
let unauthorizedListener: ((message: string) => void) | null = null;

/**
 * Register a global callback invoked when any authenticated admin request returns 401.
 */
export function registerUnauthorizedHandler(handler: ((message: string) => void) | null): void {
  unauthorizedListener = handler;
}

/**
 * Format integer cents to CNY string.
 */
export function formatYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function getAdminToken(): string | null {
  return localStorage.getItem(ADMIN_TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

/**
 * Strict API client for the merchant admin dashboard. Throws explicit errors on failure.
 */
export async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAdminToken();
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const errObj = parsed as { message?: string } | null;
    const msg = errObj?.message ?? `请求失败 (${response.status})`;
    if (response.status === 401) {
      clearAdminToken();
      unauthorizedListener?.(msg);
    }
    throw new Error(msg);
  }

  return parsed as T;
}
