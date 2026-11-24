import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config/env.js';
import { createPrismaClient } from '../src/lib/prisma.js';
import { ALL_ADMIN_PERMISSIONS } from '../src/modules/auth/auth.service.js';
import type { OrderService } from '../src/modules/order/order.service.js';

const testDbPath = path.resolve(process.cwd(), 'prisma', 'test-suite.db');
const testDbUrl = `file:${testDbPath.replace(/\\/g, '/')}`;

describe('Physical Goods E-Commerce Core Flow', () => {
  const prisma = createPrismaClient(testDbUrl);
  let app: FastifyInstance;
  let orderService: OrderService;
  let userToken = '';
  let adminToken = '';
  let restrictedAdminToken = '';
  let skuId = 0;
  let deliverableAddressId = 0;
  let excludedAddressId = 0;

  beforeAll(async () => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    execSync('npx prisma db push --skip-generate', {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: testDbUrl },
      stdio: 'pipe'
    });

    await prisma.$connect();

    const config: AppConfig = {
      nodeEnv: 'test',
      port: 3099,
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:3099',
      databaseUrl: testDbUrl,
      jwtSecret: 'test-suite-jwt-secret-at-least-32-chars',
      jwtExpiresIn: '1d',
      orderExpireMinutes: 15,
      wechatMode: 'sandbox_mock',
      wechat: null
    };

    const built = await buildApp({ prisma, config });
    app = built.app;
    orderService = built.orderService;

    const hash = await bcrypt.hash('Pass1234!', 8);
    await prisma.adminUser.create({
      data: {
        username: 'superadmin',
        passwordHash: hash,
        displayName: '主管理员',
        role: 'SUPER_ADMIN',
        permissions: JSON.stringify([...ALL_ADMIN_PERMISSIONS]),
        isActive: true
      }
    });

    await prisma.adminUser.create({
      data: {
        username: 'viewer',
        passwordHash: hash,
        displayName: '只读客服',
        role: 'OPERATOR',
        permissions: JSON.stringify(['dashboard:view']),
        isActive: true
      }
    });

    const rule = await prisma.shippingRule.create({
      data: {
        name: '标准运费（满100包邮）',
        isDefault: true,
        baseFeeCents: 1000,
        extraItemFeeCents: 300,
        freeThresholdCents: 10000,
        excludedProvinces: JSON.stringify(['西藏'])
      }
    });

    const cat = await prisma.category.create({
      data: { name: '茶叶', sortOrder: 1, isActive: true }
    });

    const product = await prisma.product.create({
      data: {
        categoryId: cat.id,
        shippingRuleId: rule.id,
        title: '测试乌龙茶',
        coverUrl: 'https://example.com/tea.jpg',
        galleryUrls: '[]',
        descriptionHtml: '<p>好茶</p>',
        status: 'ON_SALE',
        skus: {
          create: {
            skuCode: 'TEST-SKU-1',
            specName: '200g 罐装',
            priceCents: 6000,
            stock: 2,
            isActive: true
          }
        }
      },
      include: { skus: true }
    });
    skuId = product.skus[0]!.id;

    // Buyer login (verifies token + userId only)
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/wechat-login',
      payload: { code: 'buyer_001' }
    });
    expect(loginRes.statusCode).toBe(200);
    const loginBody = loginRes.json();
    expect(Object.keys(loginBody).sort()).toEqual(['token', 'userId']);
    userToken = loginBody.token;

    // Admin login
    const adminLoginRes = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { username: 'superadmin', password: 'Pass1234!' }
    });
    expect(adminLoginRes.statusCode).toBe(200);
    expect(Object.keys(adminLoginRes.json()).sort()).toEqual(['adminId', 'token']);
    adminToken = adminLoginRes.json().token;

    const viewerLoginRes = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { username: 'viewer', password: 'Pass1234!' }
    });
    restrictedAdminToken = viewerLoginRes.json().token;

    // Create addresses
    const addr1 = await app.inject({
      method: 'POST',
      url: '/api/addresses',
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        receiverName: '张三',
        receiverPhone: '13800138000',
        province: '广东省',
        city: '深圳市',
        district: '南山区',
        detailAddress: '科技园路1号',
        isDefault: true
      }
    });
    deliverableAddressId = addr1.json().id;

    const addr2 = await app.inject({
      method: 'POST',
      url: '/api/addresses',
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        receiverName: '李四',
        receiverPhone: '13900139000',
        province: '西藏自治区',
        city: '拉萨市',
        district: '城关区',
        detailAddress: '北京中路2号',
        isDefault: false
      }
    });
    excludedAddressId = addr2.json().id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it('enforces Role Permission Matrix strictly on admin routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/orders',
      headers: { authorization: `Bearer ${restrictedAdminToken}` }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('rejects orders to excluded provinces and calculates shipping accurately', async () => {
    const excludedRes = await app.inject({
      method: 'POST',
      url: '/api/orders/preview',
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        addressId: excludedAddressId,
        items: [{ skuId, quantity: 1 }]
      }
    });
    expect(excludedRes.statusCode).toBe(400);
    expect(excludedRes.json().code).toBe('REGION_NOT_DELIVERABLE');

    // 1 item = 6000 cents < 10000 threshold -> base fee 1000 cents
    const singlePreview = await app.inject({
      method: 'POST',
      url: '/api/orders/preview',
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        addressId: deliverableAddressId,
        items: [{ skuId, quantity: 1 }]
      }
    });
    expect(singlePreview.statusCode).toBe(200);
    expect(singlePreview.json().shippingFeeCents).toBe(1000);
    expect(singlePreview.json().totalAmountCents).toBe(7000);

    // 2 items = 12000 cents >= 10000 threshold -> free shipping (0)
    const freePreview = await app.inject({
      method: 'POST',
      url: '/api/orders/preview',
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        addressId: deliverableAddressId,
        items: [{ skuId, quantity: 2 }]
      }
    });
    expect(freePreview.statusCode).toBe(200);
    expect(freePreview.json().shippingFeeCents).toBe(0);
    expect(freePreview.json().totalAmountCents).toBe(12000);
  });

  it('prevents overselling under concurrent order creation and restores stock on expiry', async () => {
    const [res1, res2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { addressId: deliverableAddressId, items: [{ skuId, quantity: 2 }] }
      }),
      app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { addressId: deliverableAddressId, items: [{ skuId, quantity: 2 }] }
      })
    ]);

    const codes = [res1.statusCode, res2.statusCode].sort();
    expect(codes).toEqual([201, 409]);

    const skuAfter = await prisma.productSku.findUniqueOrThrow({ where: { id: skuId } });
    expect(skuAfter.stock).toBe(0);

    const createdOrder = res1.statusCode === 201 ? res1.json() : res2.json();
    // Simulate order expiration in the past
    await prisma.order.update({
      where: { id: createdOrder.id },
      data: { expireAt: new Date(Date.now() - 10_000) }
    });

    const cancelledCount = await orderService.cancelExpiredOrders();
    expect(cancelledCount).toBe(1);

    const skuRestored = await prisma.productSku.findUniqueOrThrow({ where: { id: skuId } });
    expect(skuRestored.stock).toBe(2);
  });

  it('completes pay -> idempotent notify -> ship -> wechat sync -> refund -> stock restore', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { addressId: deliverableAddressId, items: [{ skuId, quantity: 1 }] }
    });
    expect(createRes.statusCode).toBe(201);
    const order = createRes.json();

    const payInitRes = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/pay`,
      headers: { authorization: `Bearer ${userToken}` }
    });
    expect(payInitRes.statusCode).toBe(200);
    expect(payInitRes.json().payParams.package).toContain('prepay_id=');

    // Mock pay notify twice to verify idempotency
    const notify1 = await app.inject({
      method: 'POST',
      url: '/api/dev/mock-pay-notify',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { orderNo: order.orderNo }
    });
    expect(notify1.statusCode).toBe(200);
    expect(notify1.json().status).toBe('PENDING_SHIPMENT');

    const notify2 = await app.inject({
      method: 'POST',
      url: '/api/dev/mock-pay-notify',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { orderNo: order.orderNo }
    });
    expect(notify2.statusCode).toBe(200);

    const productAfterPay = await prisma.product.findFirstOrThrow();
    expect(productAfterPay.salesCount).toBe(1);

    // Admin ships order & syncs WeChat Shipping Service
    const shipRes = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${order.id}/ship`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { expressCompanyCode: 'SF', trackingNumber: 'SF1234567890' }
    });
    expect(shipRes.statusCode).toBe(200);
    expect(shipRes.json().status).toBe('SHIPPED');
    expect(shipRes.json().wechatShippingSyncStatus).toBe('SYNCED');

    // Buyer requests return & refund
    const asRes = await app.inject({
      method: 'POST',
      url: '/api/after-sales',
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        orderId: order.id,
        type: 'RETURN_AND_REFUND',
        reason: '规格拍错了'
      }
    });
    expect(asRes.statusCode).toBe(201);
    const afterSale = asRes.json();

    // Admin approves refund -> WeChat refund & stock restore
    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/admin/after-sales/${afterSale.id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().status).toBe('REFUNDED');

    const skuFinal = await prisma.productSku.findUniqueOrThrow({ where: { id: skuId } });
    expect(skuFinal.stock).toBe(2);
    const orderFinal = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderFinal.status).toBe('REFUNDED');
  });

  it('normalizes phone numbers, maps duplicate SKU codes to 409, and handles paid-after-cancel', async () => {
    // 1. Phone normalization (+86 and hyphens)
    const addrRes = await app.inject({
      method: 'POST',
      url: '/api/addresses',
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        receiverName: '王五',
        receiverPhone: '+86 138-0013-8001',
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detailAddress: '文三路10号',
        isDefault: false
      }
    });
    expect(addrRes.statusCode).toBe(201);
    expect(addrRes.json().receiverPhone).toBe('13800138001');

    // 2. Duplicate SKU code maps Prisma P2002 cleanly to 409
    const cat = await prisma.category.findFirstOrThrow();
    const rule = await prisma.shippingRule.findFirstOrThrow();
    const dupRes = await app.inject({
      method: 'POST',
      url: '/api/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        categoryId: cat.id,
        shippingRuleId: rule.id,
        title: '重复编码测试商品',
        coverUrl: 'https://example.com/p.jpg',
        skus: [
          {
            skuCode: 'TEST-SKU-1',
            specName: '默认',
            priceCents: 1000,
            stock: 5,
            isActive: true
          }
        ]
      }
    });
    expect(dupRes.statusCode).toBe(409);
    expect(dupRes.json().code).toBe('DUPLICATE_RECORD');

    // 3. Empty JSON body POST (cancel order) + paid-after-cancel auto refund reconciliation
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { addressId: deliverableAddressId, items: [{ skuId, quantity: 1 }] }
    });
    expect(createRes.statusCode).toBe(201);
    const order = createRes.json();

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/cancel`,
      headers: {
        authorization: `Bearer ${userToken}`,
        'content-type': 'application/json'
      }
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().status).toBe('CANCELLED');

    const abnormalOrder = await orderService.markOrderPaid(
      order.orderNo,
      'MOCK_LATE_TX_1',
      order.totalAmountCents,
      JSON.stringify({ late: true })
    );
    expect(abnormalOrder.abnormalPayStatus).toBe('AUTO_REFUNDED');

    const dashRes = await app.inject({
      method: 'GET',
      url: '/api/admin/dashboard',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(dashRes.statusCode).toBe(200);
    expect(dashRes.json().abnormalPaidOrdersCount).toBe(1);
    expect(dashRes.json().manualRefundRequiredCount).toBe(0);
  });

  it('allows admin to change own password and enforces current password validation', async () => {
    const badRes = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/change-password',
      headers: { authorization: `Bearer ${restrictedAdminToken}` },
      payload: { currentPassword: 'WrongPassword', newPassword: 'NewPassword@2026' }
    });
    expect(badRes.statusCode).toBe(400);

    const okRes = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/change-password',
      headers: { authorization: `Bearer ${restrictedAdminToken}` },
      payload: { currentPassword: 'Pass1234!', newPassword: 'NewPassword@2026' }
    });
    expect(okRes.statusCode).toBe(200);

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { username: 'viewer', password: 'Pass1234!' }
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { username: 'viewer', password: 'NewPassword@2026' }
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('blocks cross-product SKU IDOR, prevents concurrent after-sale double approval, and paginates orders', async () => {
    const cat = await prisma.category.findFirstOrThrow();
    const rule = await prisma.shippingRule.findFirstOrThrow();

    const prod2Res = await app.inject({
      method: 'POST',
      url: '/api/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        categoryId: cat.id,
        shippingRuleId: rule.id,
        title: '第二件测试商品',
        coverUrl: 'https://example.com/p2.jpg',
        skus: [
          {
            skuCode: 'PROD2-SKU-1',
            specName: '默认',
            priceCents: 3000,
            stock: 10,
            isActive: true
          }
        ]
      }
    });
    expect(prod2Res.statusCode).toBe(201);
    const prod2 = prod2Res.json();

    // Attempt to update SKU of product 1 inside product 2's PUT payload -> must block!
    const idorRes = await app.inject({
      method: 'PUT',
      url: `/api/admin/products/${prod2.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        categoryId: cat.id,
        shippingRuleId: rule.id,
        title: '第二件测试商品',
        coverUrl: 'https://example.com/p2.jpg',
        skus: [
          {
            id: skuId,
            skuCode: 'HIJACKED',
            specName: '篡改',
            priceCents: 1,
            stock: 999,
            isActive: true
          }
        ]
      }
    });
    expect(idorRes.statusCode).toBe(400);
    expect(idorRes.json().code).toBe('INVALID_SKU_ID');

    // Verify paginated order endpoints
    const buyerOrdersRes = await app.inject({
      method: 'GET',
      url: '/api/orders?page=1&pageSize=2',
      headers: { authorization: `Bearer ${userToken}` }
    });
    expect(buyerOrdersRes.statusCode).toBe(200);
    expect(Array.isArray(buyerOrdersRes.json().items)).toBe(true);
    expect(typeof buyerOrdersRes.json().total).toBe('number');

    const adminOrdersRes = await app.inject({
      method: 'GET',
      url: '/api/admin/orders?page=1&pageSize=2',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(adminOrdersRes.statusCode).toBe(200);
    expect(Array.isArray(adminOrdersRes.json().items)).toBe(true);

    // Concurrent after-sale approval race lock
    const orderRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { addressId: deliverableAddressId, items: [{ skuId: prod2.skus[0].id, quantity: 1 }] }
    });
    const order = orderRes.json();
    await app.inject({
      method: 'POST',
      url: '/api/dev/mock-pay-notify',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { orderNo: order.orderNo }
    });
    const asRes = await app.inject({
      method: 'POST',
      url: '/api/after-sales',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { orderId: order.id, type: 'REFUND_ONLY', reason: '并发测试退款' }
    });
    const afterSaleId = asRes.json().id;

    const [a1, a2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/admin/after-sales/${afterSaleId}/approve`,
        headers: { authorization: `Bearer ${adminToken}` }
      }),
      app.inject({
        method: 'POST',
        url: `/api/admin/after-sales/${afterSaleId}/approve`,
        headers: { authorization: `Bearer ${adminToken}` }
      })
    ]);
    const statuses = [a1.statusCode, a2.statusCode].sort();
    expect(statuses[0]).toBe(200);
    expect([400, 409]).toContain(statuses[1]);
  });
});
