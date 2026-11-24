import { useEffect, useState } from 'react';
import { adminFetch } from '../lib/api';
import type { AdminUserRecord } from '../types';

const PERMISSION_LABELS: Record<string, string> = {
  'dashboard:view': '运营看板',
  'products:manage': '商品管理',
  'categories:manage': '分类管理',
  'shipping:manage': '运费模板',
  'orders:manage': '订单与发货',
  'after_sales:manage': '售后退款',
  'admin_users:manage': '角色权限矩阵'
};

export function AdminUsersPage({ allPermissions }: { allPermissions: string[] }) {
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selectedPerms, setSelectedPerms] = useState<string[]>(['dashboard:view', 'orders:manage']);

  const loadUsers = async () => {
    setError('');
    try {
      const list = await adminFetch<AdminUserRecord[]>('/api/admin/users');
      setUsers(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载管理员列表失败');
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleToggleUserPerm = async (user: AdminUserRecord, perm: string) => {
    setError('');
    const nextPerms = user.permissions.includes(perm)
      ? user.permissions.filter((p) => p !== perm)
      : [...user.permissions, perm];
    try {
      await adminFetch(`/api/admin/users/${user.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions: nextPerms, isActive: user.isActive })
      });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新权限失败');
    }
  };

  const handleToggleActive = async (user: AdminUserRecord) => {
    setError('');
    try {
      await adminFetch(`/api/admin/users/${user.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions: user.permissions, isActive: !user.isActive })
      });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : '切换状态失败');
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await adminFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          displayName,
          role: 'OPERATOR',
          permissions: selectedPerms
        })
      });
      setUsername('');
      setPassword('');
      setDisplayName('');
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建管理员失败');
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-[32px] border border-dashed border-slate-300 bg-slate-100/60 p-6">
        <h1 className="text-lg font-black">角色权限矩阵</h1>
        <p className="text-xs font-semibold text-slate-500 mt-1">
          唯一入口权限控制：每个后台账户的可见页面与 API 操作完全依据矩阵勾选
        </p>
      </div>

      {error && (
        <div className="rounded-[24px] bg-rose-500/10 p-4 text-sm font-semibold text-rose-600">
          {error}
        </div>
      )}

      <form
        onSubmit={handleCreateUser}
        className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6 space-y-4"
      >
        <h2 className="text-sm font-black">新增操作员账号</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="登录账号（至少3位）"
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="初始密码（至少8位）"
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
            required
          />
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="显示姓名"
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
            required
          />
        </div>
        <div className="flex flex-wrap gap-3">
          {allPermissions.map((perm) => (
            <label key={perm} className="inline-flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={selectedPerms.includes(perm)}
                onChange={() =>
                  setSelectedPerms((prev) =>
                    prev.includes(perm) ? prev.filter((x) => x !== perm) : [...prev, perm]
                  )
                }
              />
              <span>{PERMISSION_LABELS[perm] ?? perm}</span>
            </label>
          ))}
        </div>
        <button
          type="submit"
          className="rounded-full h-11 px-6 bg-slate-900 text-white font-bold text-xs cursor-pointer"
        >
          创建操作员
        </button>
      </form>

      <div className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-xs font-bold text-slate-400 border-b border-dashed border-slate-200">
              <th className="py-3 pr-4">账号</th>
              <th className="py-3 pr-4">状态</th>
              {allPermissions.map((p) => (
                <th key={p} className="py-3 px-2 text-center">
                  {PERMISSION_LABELS[p] ?? p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-dashed border-slate-100">
                <td className="py-3 pr-4 font-semibold">
                  {u.displayName} ({u.username})
                </td>
                <td className="py-3 pr-4">
                  <button
                    onClick={() => handleToggleActive(u)}
                    className={`rounded-full h-5 px-2.5 text-[11px] font-bold cursor-pointer ${
                      u.isActive
                        ? 'bg-emerald-500/10 text-emerald-600'
                        : 'bg-rose-500/10 text-rose-600'
                    }`}
                  >
                    {u.isActive ? 'ACTIVE' : 'DISABLED'}
                  </button>
                </td>
                {allPermissions.map((p) => (
                  <td key={p} className="py-3 px-2 text-center">
                    <input
                      type="checkbox"
                      checked={u.permissions.includes(p)}
                      onChange={() => handleToggleUserPerm(u, p)}
                      className="cursor-pointer"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
