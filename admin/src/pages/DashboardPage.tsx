import { useEffect, useState } from 'react';
import { adminFetch, formatYuan } from '../lib/api';
import type { DashboardStats } from '../types';

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    adminFetch<DashboardStats>('/api/admin/dashboard')
      .then(setStats)
      .catch((err) => setError(err instanceof Error ? err.message : '加载看板失败'));
  }, []);

  if (error) {
    return (
      <div className="rounded-[24px] border border-dashed border-rose-300 bg-rose-500/10 p-6 text-sm font-semibold text-rose-600">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-[32px] border border-dashed border-slate-300 bg-slate-100/60 p-6">
        <h1 className="text-lg font-black">运营概览看板</h1>
        <p className="text-xs font-semibold text-slate-500 mt-1">
          实时监控订单履约、售后待办与微信发货合规状态
        </p>
      </div>

      {!stats ? (
        <div className="text-sm text-slate-500">正在加载统计数据...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6">
            <div className="text-xs font-bold text-slate-400">
              累计实付 GMV
            </div>
            <div className="mt-2 text-2xl font-black tabular-nums text-slate-900">
              ¥{formatYuan(stats.gmvCents)}
            </div>
          </div>

          <div className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6">
            <div className="text-xs font-bold text-slate-400">
              全部订单数
            </div>
            <div className="mt-2 text-2xl font-black tabular-nums text-slate-900">{stats.totalOrders}</div>
          </div>

          <div className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6">
            <div className="text-xs font-bold text-slate-400">
              待发货订单
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-2xl font-black tabular-nums text-slate-900">
                {stats.pendingShipmentCount}
              </span>
              {stats.pendingShipmentCount > 0 && (
                <span className="rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold bg-amber-500/10 text-amber-600">
                  ALERT
                </span>
              )}
            </div>
          </div>

          <div className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6">
            <div className="text-xs font-bold text-slate-400">
              待审核售后
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-2xl font-black tabular-nums text-slate-900">
                {stats.pendingAfterSalesCount}
              </span>
              {stats.pendingAfterSalesCount > 0 && (
                <span className="rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold bg-amber-500/10 text-amber-600">
                  REVIEW
                </span>
              )}
            </div>
          </div>

          <div className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6">
            <div className="text-xs font-bold text-slate-400">
              微信发货同步失败
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-2xl font-black tabular-nums text-slate-900">
                {stats.shippingSyncFailedCount}
              </span>
              {stats.shippingSyncFailedCount > 0 ? (
                <span className="rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold bg-rose-500/10 text-rose-600 animate-pulse">
                  CRITICAL
                </span>
              ) : (
                <span className="rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold bg-emerald-500/10 text-emerald-600">
                  HEALTHY
                </span>
              )}
            </div>
          </div>

          <div className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6">
            <div className="text-xs font-bold text-slate-400">
              关单后付款异常单
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-2xl font-black tabular-nums text-slate-900">
                {stats.abnormalPaidOrdersCount}
              </span>
              {stats.manualRefundRequiredCount > 0 ? (
                <span className="rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold bg-rose-500/10 text-rose-600 animate-pulse">
                  人工介入 {stats.manualRefundRequiredCount}
                </span>
              ) : stats.abnormalPaidOrdersCount > 0 ? (
                <span className="rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold bg-amber-500/10 text-amber-600">
                  已自动退款
                </span>
              ) : (
                <span className="rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold bg-emerald-500/10 text-emerald-600">
                  HEALTHY
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
