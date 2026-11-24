import { useEffect, useState } from 'react';
import { adminFetch, formatYuan } from '../lib/api';
import type { AdminAfterSale } from '../types';

export function AfterSalesPage() {
  const [items, setItems] = useState<AdminAfterSale[]>([]);
  const [error, setError] = useState('');

  const loadAfterSales = async () => {
    setError('');
    try {
      const list = await adminFetch<AdminAfterSale[]>('/api/admin/after-sales');
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载售后单失败');
    }
  };

  useEffect(() => {
    loadAfterSales();
  }, []);

  const handleApprove = async (id: number) => {
    setError('');
    try {
      await adminFetch(`/api/admin/after-sales/${id}/approve`, { method: 'POST' });
      await loadAfterSales();
    } catch (err) {
      setError(err instanceof Error ? err.message : '退款执行失败');
    }
  };

  const handleReject = async (id: number) => {
    const reason = window.prompt('请输入驳回原因（必填）');
    if (!reason || reason.trim().length < 2) return;
    setError('');
    try {
      await adminFetch(`/api/admin/after-sales/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ rejectReason: reason.trim() })
      });
      await loadAfterSales();
    } catch (err) {
      setError(err instanceof Error ? err.message : '驳回失败');
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-[32px] border border-dashed border-slate-300 bg-slate-100/60 p-6">
        <h1 className="text-lg font-black">售后审核与原路退款</h1>
        <p className="text-xs font-semibold text-slate-500 mt-1">
          审核通过将直接调用微信支付 V3 退款接口原路退回并自动回滚库存
        </p>
      </div>

      {error && (
        <div className="rounded-[24px] bg-rose-500/10 p-4 text-sm font-semibold text-rose-600">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {items.length === 0 && (
          <div className="rounded-[24px] border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            暂无售后申请
          </div>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6 flex flex-wrap justify-between items-center gap-4"
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="tabular-nums text-xs font-bold">{item.afterSaleNo}</span>
                <span className="rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold bg-amber-500/10 text-amber-600">
                  {item.status}
                </span>
                <span className="text-xs text-slate-500">原订单：{item.order.orderNo}</span>
              </div>
              <div className="text-sm font-semibold mt-1">
                退款金额：¥{formatYuan(item.refundAmountCents)} · 原因：{item.reason}
              </div>
              {item.rejectReason && (
                <div className="text-xs text-rose-600 mt-1">驳回理由：{item.rejectReason}</div>
              )}
            </div>

            {item.status === 'PENDING_REVIEW' && (
              <div className="flex gap-2">
                <button
                  onClick={() => handleReject(item.id)}
                  className="rounded-full h-11 px-5 border border-slate-300 font-bold text-xs cursor-pointer"
                >
                  驳回申请
                </button>
                <button
                  onClick={() => handleApprove(item.id)}
                  className="rounded-full h-11 px-6 bg-slate-900 text-white font-bold text-xs cursor-pointer"
                >
                  同意并原路退款
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
