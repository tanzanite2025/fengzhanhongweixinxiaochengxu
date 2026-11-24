export interface AdminProfile {
  id: number;
  username: string;
  displayName: string;
  permissions: string[];
  allPermissions: string[];
}

export interface DashboardStats {
  totalOrders: number;
  pendingShipmentCount: number;
  pendingAfterSalesCount: number;
  shippingSyncFailedCount: number;
  abnormalPaidOrdersCount: number;
  manualRefundRequiredCount: number;
  gmvCents: number;
}

export interface Category {
  id: number;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface ShippingRule {
  id: number;
  name: string;
  isDefault: boolean;
  baseFeeCents: number;
  extraItemFeeCents: number;
  freeThresholdCents: number | null;
  excludedProvinces: string[];
}

export interface ProductSku {
  id?: number;
  skuCode: string;
  specName: string;
  specImageUrl?: string | null;
  priceCents: number;
  originalPriceCents?: number | null;
  stock: number;
  isActive: boolean;
}

export interface Product {
  id: number;
  categoryId: number;
  shippingRuleId: number;
  title: string;
  subtitle: string | null;
  coverUrl: string;
  galleryUrls: string[];
  descriptionHtml: string;
  status: 'ON_SALE' | 'OFF_SALE';
  sortOrder: number;
  salesCount: number;
  category?: { id: number; name: string };
  shippingRule?: ShippingRule;
  skus: ProductSku[];
}

export interface OrderItem {
  id: number;
  productTitle: string;
  skuSpecName: string;
  skuImageUrl: string;
  unitPriceCents: number;
  quantity: number;
  subtotalCents: number;
}

export interface AdminOrder {
  id: number;
  orderNo: string;
  status: string;
  itemsAmountCents: number;
  shippingFeeCents: number;
  totalAmountCents: number;
  receiverName: string;
  receiverPhone: string;
  receiverProvince: string;
  receiverCity: string;
  receiverDistrict: string;
  receiverDetail: string;
  buyerRemark: string | null;
  expressCompanyCode: string | null;
  expressCompanyName: string | null;
  trackingNumber: string | null;
  shippedAt: string | null;
  wechatShippingSyncStatus: string;
  wechatShippingSyncError: string | null;
  abnormalPayStatus: string;
  abnormalPayNote: string | null;
  createdAt: string;
  items: OrderItem[];
}

export interface AdminAfterSale {
  id: number;
  afterSaleNo: string;
  type: string;
  status: string;
  reason: string;
  description: string | null;
  refundAmountCents: number;
  rejectReason: string | null;
  reviewedBy: string | null;
  createdAt: string;
  order: {
    orderNo: string;
    totalAmountCents: number;
    items: OrderItem[];
  };
}

export interface AdminUserRecord {
  id: number;
  username: string;
  displayName: string;
  role: 'SUPER_ADMIN' | 'OPERATOR';
  permissions: string[];
  isActive: boolean;
}

export interface ExpressCompany {
  code: string;
  name: string;
}
