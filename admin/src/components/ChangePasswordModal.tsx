import { useState } from 'react';
import { adminFetch } from '../lib/api';

interface ChangePasswordModalProps {
  onClose: () => void;
  onPasswordChanged: () => void;
}

export function ChangePasswordModal({ onClose, onPasswordChanged }: ChangePasswordModalProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('新密码长度不能少于 8 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }

    setSubmitting(true);
    try {
      await adminFetch('/api/admin/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改密码失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-[32px] bg-white p-8 shadow-2xl space-y-4"
      >
        <h2 className="text-sm font-black">修改当前账号密码</h2>

        {error && (
          <div className="rounded-2xl bg-rose-500/10 px-4 py-3 text-xs font-semibold text-rose-600">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-2xl bg-emerald-500/10 px-4 py-3 text-xs font-semibold text-emerald-700">
            密码修改成功，旧登录凭证已失效，请使用新密码重新登录。
          </div>
        )}

        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="当前密码"
          className="w-full h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
          required
          disabled={success}
        />
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="新密码（至少 8 位）"
          className="w-full h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
          required
          disabled={success}
        />
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="确认新密码"
          className="w-full h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
          required
          disabled={success}
        />

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={success ? onPasswordChanged : onClose}
            className="rounded-full h-11 px-5 text-xs font-bold cursor-pointer"
          >
            {success ? '重新登录' : '取消'}
          </button>
          {!success && (
            <button
              type="submit"
              disabled={submitting}
              className="rounded-full h-11 px-6 bg-slate-900 text-white font-bold text-xs disabled:opacity-50 cursor-pointer"
            >
              {submitting ? '提交中...' : '确认修改'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
