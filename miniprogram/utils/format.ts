/**
 * Format integer cents to yuan string (e.g. 6800 -> "68.00").
 */
export function formatPrice(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  return `${negative ? '-' : ''}${yuan}.${String(fen).padStart(2, '0')}`;
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: '待付款',
  PENDING_SHIPMENT: '待发货',
  SHIPPED: '待收货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '售后处理中',
  REFUNDED: '已退款'
};

export const AFTER_SALE_STATUS_LABEL: Record<string, string> = {
  PENDING_REVIEW: '待商家审核',
  APPROVED_REFUNDING: '退款打款中',
  REFUNDED: '已退款',
  REJECTED: '已驳回',
  CANCELLED: '已取消'
};
