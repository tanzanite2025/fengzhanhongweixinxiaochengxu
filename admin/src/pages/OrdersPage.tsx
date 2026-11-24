import { useEffect, useState } from 'react';
import { adminFetch, formatYuan } from '../lib/api';
import type { AdminOrder, ExpressCompany } from '../types';

export function OrdersPage() {
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [companies, setCompanies] = useState<ExpressCompany[]>([]);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [error, setError] = useState('');
  const [shippingOrderId, setShippingOrderId] = useState<number | null>(null);
  const [expressCode, setExpressCode] = useState('SF');
  const [trackingNo, setTrackingNo] = useState('');

  const loadOrders = async (status = statusFilter, targetPage = page) => {
    setError('');
    try {
      const [res, expressList] = await Promise.all([
        adminFetch<{ total: number; items: AdminOrder[] }>(
          `/api/admin/orders?status=${encodeURIComponent(status)}&page=${targetPage}&pageSize=${pageSize}`
        ),
        adminFetch<ExpressCompany[]>('/api/admin/express-companies')
      ]);
      setOrders(res.items);
      setTotal(res.total);
      setCompanies(expressList);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载订单失败');
    }
  };

  useEffect(() => {
    loadOrders(statusFilter, page);
  }, [statusFilter, page]);

  const handleShipSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shippingOrderId) return;
    setError('');
    try {
      const updated = await adminFetch<AdminOrder>(`/api/admin/orders/${shippingOrderId}/ship`, {
        method: 'POST',
        body: JSON.stringify({
          expressCompanyCode: expressCode,
          trackingNumber: trackingNo
        })
      });
      if (updated.wechatShippingSyncStatus === 'FAILED') {
        setError(
          `订单已标记发货，但同步微信发货管理失败（请检查配置后重试）：${updated.wechatShippingSyncError ?? '未知错误'}`
        );
      }
      setShippingOrderId(null);
      setTrackingNo('');
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发货失败');
    }
  };

  const handleRetrySync = async (orderId: number) => {
    setError('');
    try {
      const updated = await adminFetch<AdminOrder>(
        `/api/admin/orders/${orderId}/retry-wechat-shipping`,
        { method: 'POST' }
      );
      if (updated.wechatShippingSyncStatus === 'FAILED') {
        setError(`重试同步微信发货仍然失败：${updated.wechatShippingSyncError ?? '未知错误'}`);
      }
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重试失败');
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-[32px] border border-dashed border-slate-300 bg-slate-100/60 p-6 flex flex-wrap justify-between items-center gap-4">
        <div>
          <h1 className="text-lg font-black">订单履约与微信发货</h1>
          <p className="text-xs font-semibold text-slate-500 mt-1">
            发货后自动调用微信 upload_shipping_info 接口，确保货款合规结算
          </p>
        </div>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="h-12 rounded-2xl border-none bg-white px-4 text-sm font-semibold"
        >
          <option value="ALL">全部订单</option>
          <option value="PENDING_PAYMENT">待付款</option>
          <option value="PENDING_SHIPMENT">待发货</option>
          <option value="SHIPPED">已发货</option>
          <option value="COMPLETED">已完成</option>
          <option value="REFUND_REQUESTED">售后中</option>
          <option value="REFUNDED">已退款</option>
        </select>
      </div>

      {error && (
        <div className="rounded-[24px] bg-rose-500/10 p-4 text-sm font-semibold text-rose-600">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {orders.map((order) => (
          <div
            key={order.id}
            className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6 space-y-3"
          >
            <div className="flex flex-wrap justify-between items-center gap-2 border-b border-dashed border-slate-200 pb-3">
              <div className="flex items-center gap-3">
                <span className="tabular-nums text-xs font-bold">{order.orderNo}</span>
                <span className="rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold bg-slate-900/10 text-slate-800">
                  {order.status}
                </span>
                {order.shippedAt !== null && (
                  <span
                    className={`rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold ${
                      order.wechatShippingSyncStatus === 'SYNCED'
                        ? 'bg-emerald-500/10 text-emerald-600'
                        : order.wechatShippingSyncStatus === 'FAILED'
                          ? 'bg-rose-500/10 text-rose-600 animate-pulse'
                          : 'bg-amber-500/10 text-amber-600'
                    }`}
                  >
                    WX_SHIPPING:{order.wechatShippingSyncStatus}
                  </span>
                )}
                {order.abnormalPayStatus !== 'NONE' && (
                  <span className="rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold bg-rose-500/10 text-rose-600">
                    {order.abnormalPayStatus}
                  </span>
                )}
              </div>
              <div className="font-black text-slate-900">¥{formatYuan(order.totalAmountCents)}</div>
            </div>

            <div className="text-xs text-slate-600">
              收货人：{order.receiverName}（{order.receiverPhone}）· {order.receiverProvince}
              {order.receiverCity}
              {order.receiverDistrict}
              {order.receiverDetail}
              {order.buyerRemark ? ` · 留言：${order.buyerRemark}` : ''}
            </div>

            <div className="flex flex-wrap gap-3">
              {order.items.map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl bg-slate-50 px-3 py-2 text-xs flex items-center gap-2"
                >
                  <span className="font-semibold">{item.productTitle}</span>
                  <span className="text-slate-500">
                    ({item.skuSpecName}) × {item.quantity}
                  </span>
                </div>
              ))}
            </div>

            {order.trackingNumber && (
              <div className="text-xs text-slate-700 font-medium tabular-nums">
                物流：{order.expressCompanyName} | {order.trackingNumber}
              </div>
            )}
            {order.wechatShippingSyncError && (
              <div className="text-xs text-rose-600">
                微信同步异常：{order.wechatShippingSyncError}
              </div>
            )}
            {order.abnormalPayNote && (
              <div className="text-xs text-rose-600 font-semibold">
                支付对账异常：{order.abnormalPayNote}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              {order.status === 'PENDING_SHIPMENT' && (
                <button
                  onClick={() => setShippingOrderId(order.id)}
                  className="rounded-full h-11 px-6 bg-slate-900 text-white font-bold text-xs cursor-pointer"
                >
                  录入物流并发货
                </button>
              )}
              {order.wechatShippingSyncStatus === 'FAILED' && (
                <button
                  onClick={() => handleRetrySync(order.id)}
                  className="rounded-full h-11 px-6 bg-rose-600 text-white font-bold text-xs cursor-pointer"
                >
                  重试同步微信发货
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-between items-center pt-2 text-xs text-slate-600">
        <span>共 {total} 条订单</span>
        <div className="flex items-center gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-full h-9 px-4 border border-slate-300 font-bold disabled:opacity-40 cursor-pointer"
          >
            上一页
          </button>
          <span className="tabular-nums font-semibold">
            第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页
          </span>
          <button
            disabled={page * pageSize >= total}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-full h-9 px-4 border border-slate-300 font-bold disabled:opacity-40 cursor-pointer"
          >
            下一页
          </button>
        </div>
      </div>

      {shippingOrderId !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <form
            onSubmit={handleShipSubmit}
            className="w-full max-w-md rounded-[32px] bg-white p-8 shadow-2xl space-y-4"
          >
            <h2 className="text-sm font-black">录入快递单号</h2>
            <select
              value={expressCode}
              onChange={(e) => setExpressCode(e.target.value)}
              className="w-full h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
            >
              {companies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
            <input
              value={trackingNo}
              onChange={(e) => setTrackingNo(e.target.value)}
              placeholder="请输入真实快递单号"
              className="w-full h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
              required
            />
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShippingOrderId(null)}
                className="rounded-full h-11 px-5 text-xs font-bold cursor-pointer"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-full h-11 px-6 bg-slate-900 text-white font-bold text-xs cursor-pointer"
              >
                确认发货并同步微信
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
