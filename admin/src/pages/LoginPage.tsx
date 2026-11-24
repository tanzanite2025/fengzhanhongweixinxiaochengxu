import { useState } from 'react';
import { adminFetch, setAdminToken } from '../lib/api';

interface LoginPageProps {
  onSuccess: () => void;
}

export function LoginPage({ onSuccess }: LoginPageProps) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await adminFetch<{ token: string; adminId: number }>('/api/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      setAdminToken(res.token);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-[32px] bg-white p-8 shadow-2xl relative overflow-hidden"
      >
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900/5 via-transparent pointer-events-none" />
        <h1 className="text-lg font-black text-slate-900">
          WECHAT MALL CONSOLE
        </h1>
        <p className="text-xs font-semibold text-slate-500 mt-1 mb-6">
          企业微信自研商城 · 商家管理控制台
        </p>

        {error && (
          <div className="mb-4 rounded-2xl bg-rose-500/10 px-4 py-3 text-xs font-semibold text-rose-600">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-2">
              管理员账号
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm outline-none focus:ring-2 focus:ring-slate-900"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-2">
              登录密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="默认种子密码 Admin@2026!"
              className="w-full h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm outline-none focus:ring-2 focus:ring-slate-900"
              required
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="mt-6 w-full rounded-full h-11 bg-slate-900 text-white font-bold text-xs hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
        >
          {loading ? '正在验证身份...' : '登录管理后台'}
        </button>
      </form>
    </div>
  );
}
