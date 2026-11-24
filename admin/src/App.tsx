import { useEffect, useState } from 'react';
import { ChangePasswordModal } from './components/ChangePasswordModal';
import { adminFetch, clearAdminToken, getAdminToken } from './lib/api';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { AfterSalesPage } from './pages/AfterSalesPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { OrdersPage } from './pages/OrdersPage';
import { ProductsPage } from './pages/ProductsPage';
import { ShippingRulesPage } from './pages/ShippingRulesPage';
import type { AdminProfile } from './types';

type TabKey = 'dashboard' | 'products' | 'shipping' | 'orders' | 'after_sales' | 'admin_users';

interface NavItem {
  key: TabKey;
  label: string;
  requiredPerm: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: '运营看板', requiredPerm: 'dashboard:view' },
  { key: 'products', label: '商品管理', requiredPerm: 'products:manage' },
  { key: 'shipping', label: '运费模板', requiredPerm: 'shipping:manage' },
  { key: 'orders', label: '订单与发货', requiredPerm: 'orders:manage' },
  { key: 'after_sales', label: '售后退款', requiredPerm: 'after_sales:manage' },
  { key: 'admin_users', label: '权限矩阵', requiredPerm: 'admin_users:manage' }
];

export function App() {
  const [tokenReady, setTokenReady] = useState<boolean>(() => Boolean(getAdminToken()));
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [authError, setAuthError] = useState('');
  const [showChangePwd, setShowChangePwd] = useState(false);

  const fetchProfile = async () => {
    setAuthError('');
    try {
      const me = await adminFetch<AdminProfile>('/api/admin/auth/me');
      setProfile(me);
      const firstAllowed = NAV_ITEMS.find((item) => me.permissions.includes(item.requiredPerm));
      if (firstAllowed) {
        setActiveTab(firstAllowed.key);
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : '加载身份信息失败');
      clearAdminToken();
      setTokenReady(false);
    }
  };

  useEffect(() => {
    if (tokenReady) {
      fetchProfile();
    }
  }, [tokenReady]);

  if (!tokenReady) {
    return <LoginPage onSuccess={() => setTokenReady(true)} />;
  }

  if (authError) {
    return (
      <div className="p-8 text-rose-600 font-semibold">
        {authError}
      </div>
    );
  }

  if (!profile) {
    return <div className="p-8 text-sm text-slate-500">正在加载权限矩阵...</div>;
  }

  const visibleNav = NAV_ITEMS.filter((item) => profile.permissions.includes(item.requiredPerm));

  return (
    <div className="min-h-screen flex bg-slate-50">
      <aside className="w-64 bg-white border-r border-dashed border-slate-200 p-6 flex flex-col justify-between">
        <div>
          <div className="text-base font-black text-slate-900">
            MALL CONSOLE
          </div>
          <div className="text-xs font-semibold text-slate-500 mt-1 mb-8">
            {profile.displayName} ({profile.username})
          </div>

          <nav className="space-y-2">
            {visibleNav.map((item) => (
              <button
                key={item.key}
                onClick={() => setActiveTab(item.key)}
                className={`w-full text-left rounded-full h-11 px-5 text-xs font-bold cursor-pointer transition ${
                  activeTab === item.key
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="space-y-2">
          <button
            onClick={() => setShowChangePwd(true)}
            className="w-full rounded-full h-11 px-5 border border-dashed border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            修改密码
          </button>
          <button
            onClick={() => {
              clearAdminToken();
              setProfile(null);
              setTokenReady(false);
            }}
            className="w-full rounded-full h-11 px-5 border border-dashed border-slate-300 text-xs font-bold text-slate-600 cursor-pointer"
          >
            退出登录
          </button>
        </div>
      </aside>

      {showChangePwd && <ChangePasswordModal onClose={() => setShowChangePwd(false)} />}

      <main className="flex-1 p-8 max-w-6xl">
        {activeTab === 'dashboard' && profile.permissions.includes('dashboard:view') && (
          <DashboardPage />
        )}
        {activeTab === 'products' && profile.permissions.includes('products:manage') && (
          <ProductsPage canManageCategories={profile.permissions.includes('categories:manage')} />
        )}
        {activeTab === 'shipping' && profile.permissions.includes('shipping:manage') && (
          <ShippingRulesPage />
        )}
        {activeTab === 'orders' && profile.permissions.includes('orders:manage') && <OrdersPage />}
        {activeTab === 'after_sales' && profile.permissions.includes('after_sales:manage') && (
          <AfterSalesPage />
        )}
        {activeTab === 'admin_users' && profile.permissions.includes('admin_users:manage') && (
          <AdminUsersPage allPermissions={profile.allPermissions} />
        )}
      </main>
    </div>
  );
}

export default App;
