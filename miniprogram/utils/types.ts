export interface CategoryDto {
  id: number;
  name: string;
}

export interface ProductSkuDto {
  id: number;
  productId: number;
  skuCode: string;
  specName: string;
  specImageUrl: string | null;
  priceCents: number;
  originalPriceCents: number | null;
  stock: number;
  isActive: boolean;
}

export interface ProductDto {
  id: number;
  categoryId: number;
  title: string;
  subtitle: string | null;
  coverUrl: string;
  galleryUrls: string[];
  descriptionHtml: string;
  salesCount: number;
  category?: CategoryDto;
  shippingRule?: {
    id: number;
    name: string;
    baseFeeCents: number;
    extraItemFeeCents: number;
    freeThresholdCents: number | null;
    excludedProvinces: string[];
  };
  skus: ProductSkuDto[];
}

export interface CartItemDto {
  id: number;
  skuId: number;
  quantity: number;
  selected: boolean;
  available: boolean;
  unavailableReason: string | null;
  sku: {
    id: number;
    specName: string;
    specImageUrl: string | null;
    priceCents: number;
    stock: number;
  };
  product: {
    id: number;
    title: string;
    coverUrl: string;
    status: string;
  };
}

export interface AddressDto {
  id: number;
  receiverName: string;
  receiverPhone: string;
  province: string;
  city: string;
  district: string;
  detailAddress: string;
  isDefault: boolean;
}

export interface OrderItemDto {
  id: number;
  productId: number;
  skuId: number;
  productTitle: string;
  skuSpecName: string;
  skuImageUrl: string;
  unitPriceCents: number;
  quantity: number;
  subtotalCents: number;
}

export interface AfterSaleDto {
  id: number;
  afterSaleNo: string;
  type: string;
  status: string;
  reason: string;
  refundAmountCents: number;
  rejectReason: string | null;
  createdAt: string;
}

export interface OrderDto {
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
  expressCompanyName: string | null;
  trackingNumber: string | null;
  wechatTransactionId: string | null;
  createdAt: string;
  items: OrderItemDto[];
  afterSales?: AfterSaleDto[];
}
