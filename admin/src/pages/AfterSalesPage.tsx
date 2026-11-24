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

  const executeRefundAction = async (
    item: AdminAfterSale,
    endpoint: 'approve' | 'retry-refund',
    promptTitle: string
  ) => {
    const defaultYuan = formatYuan(item.refundAmountCents);
    const input = window.prompt(
      `${promptTitle}当前实付总额 ¥${formatYuan(item.order.totalAmountCents)}，请输入实退金额（元）：`,
      defaultYuan
    );
    if (input === null) return;
    const parsedCents = Math.round(Number(input) * 100);
    if (!Number.isFinite(parsedCents) || parsedCents <= 0 || parsedCents > item.order.totalAmountCents) {
      setError(`实退金额必须在 0.01 至 ${formatYuan(item.order.totalAmountCents)} 元之间`);
      return;
    }

    setError('');
    try {
      await adminFetch(`/api/admin/after-sales/${item.id}/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify({ refundAmountCents: parsedCents })
      });
      await loadAfterSales();
    } catch (err) {
      setError(err instanceof Error ? err.message : '退款执行失败');
    }
  };

  const handleApprove = (item: AdminAfterSale) =>
    executeRefundAction(item, 'approve', '确认同意退款？');

  const handleRetryRefund = (item: AdminAfterSale) =>
    executeRefundAction(item, 'retry-refund', '更换新退款单号重新发起微信退款？');

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

  const handleSyncRefund = async (id: number) => {
    setError('');
    try {
      await adminFetch(`/api/admin/after-sales/${id}/sync-refund`, { method: 'POST' });
      await loadAfterSales();
    } catch (err) {
      setError(err instanceof Error ? err.message : '同步退款进度失败');
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
                <span
                  className={`rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold ${
                    item.status === 'REFUND_FAILED'
                      ? 'bg-rose-500/10 text-rose-600'
                      : item.status === 'REFUNDED'
                        ? 'bg-emerald-500/10 text-emerald-600'
                        : 'bg-amber-500/10 text-amber-600'
                  }`}
                >
                  {item.status}
                </span>
                <span className="text-xs text-slate-500">原订单：{item.order.orderNo}</span>
              </div>
              <div className="text-sm font-semibold mt-1">
                退款金额：¥{formatYuan(item.refundAmountCents)} · 原因：{item.reason}
              </div>
              {item.rejectReason && (
                <div className="text-xs text-rose-600 mt-1">说明：{item.rejectReason}</div>
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
                  onClick={() => handleApprove(item)}
                  className="rounded-full h-11 px-6 bg-slate-900 text-white font-bold text-xs cursor-pointer"
                >
                  同意并原路退款
                </button>
              </div>
            )}
            {(item.status === 'APPROVED_REFUNDING' || item.status === 'REFUND_FAILED') && (
              <div className="flex gap-2">
                <button
                  onClick={() => handleSyncRefund(item.id)}
                  className="rounded-full h-11 px-5 border border-slate-300 font-bold text-xs cursor-pointer"
                >
                  同步微信退款进度
                </button>
                {item.status === 'REFUND_FAILED' && (
                  <button
                    onClick={() => handleRetryRefund(item)}
                    className="rounded-full h-11 px-5 bg-rose-600 text-white font-bold text-xs cursor-pointer"
                  >
                    更换单号重发退款
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
