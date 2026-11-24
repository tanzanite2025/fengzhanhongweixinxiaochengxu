import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config/env.js';
import { configureSqliteConcurrency, createPrismaClient } from '../src/lib/prisma.js';
import { ALL_ADMIN_PERMISSIONS } from '../src/modules/auth/auth.service.js';
import type { OrderService } from '../src/modules/order/order.service.js';

const testDbPath = path.resolve(process.cwd(), 'prisma', 'test-suite.db');
const testDbUrl = `file:${testDbPath.replace(/\\/g, '/')}`;

function cleanupTestDbFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${testDbPath}${suffix}`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

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
    cleanupTestDbFiles();

    execSync('npx prisma db push --skip-generate', {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: testDbUrl },
      stdio: 'pipe'
    });

    await prisma.$connect();
    await configureSqliteConcurrency(prisma, testDbUrl);

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
    cleanupTestDbFiles();
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

    // Pre-change JWT must be invalidated immediately after password change
    const staleTokenRes = await app.inject({
      method: 'GET',
      url: '/api/admin/auth/me',
      headers: { authorization: `Bearer ${restrictedAdminToken}` }
    });
    expect(staleTokenRes.statusCode).toBe(401);
    expect(staleTokenRes.json().code).toBe('TOKEN_REVOKED');
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

  it('supports custom partial refund amount on approval and rejects exceeding order total', async () => {
    const orderRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { addressId: deliverableAddressId, items: [{ skuId, quantity: 1 }] }
    });
    expect(orderRes.statusCode).toBe(201);
    const order = orderRes.json(); // items 6000 + shipping 1000 = 7000 cents

    await app.inject({
      method: 'POST',
      url: '/api/dev/mock-pay-notify',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { orderNo: order.orderNo }
    });

    await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${order.id}/ship`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { expressCompanyCode: 'SF', trackingNumber: 'SF9988776655' }
    });

    const asRes = await app.inject({
      method: 'POST',
      url: '/api/after-sales',
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        orderId: order.id,
        type: 'RETURN_AND_REFUND',
        reason: '七天无理由退货（扣首程运费）'
      }
    });
    const afterSaleId = asRes.json().id;

    // Exceeding order total (7001 > 7000) must fail
    const overRes = await app.inject({
      method: 'POST',
      url: `/api/admin/after-sales/${afterSaleId}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { refundAmountCents: order.totalAmountCents + 1 }
    });
    expect(overRes.statusCode).toBe(400);
    expect(overRes.json().code).toBe('INVALID_REFUND_AMOUNT');

    // Partial refund deducting shipping (6000 cents) must succeed
    const partialRes = await app.inject({
      method: 'POST',
      url: `/api/admin/after-sales/${afterSaleId}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { refundAmountCents: 6000 }
    });
    expect(partialRes.statusCode).toBe(200);
    expect(partialRes.json().status).toBe('REFUNDED');
    expect(partialRes.json().refundAmountCents).toBe(6000);
  });

  it('rejects ON_SALE products that have zero active SKUs', async () => {
    const cat = await prisma.category.findFirstOrThrow();
    const rule = await prisma.shippingRule.findFirstOrThrow();

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        categoryId: cat.id,
        shippingRuleId: rule.id,
        title: '无可用SKU的上架商品',
        coverUrl: 'https://example.com/p3.jpg',
        status: 'ON_SALE',
        skus: [
          {
            skuCode: 'DISABLED-ONLY-SKU',
            specName: '停用规格',
            priceCents: 1000,
            stock: 10,
            isActive: false
          }
        ]
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('reconciles concurrent cancel-vs-pay race safely and supports admin sync-refund', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { addressId: deliverableAddressId, items: [{ skuId, quantity: 1 }] }
    });
    expect(createRes.statusCode).toBe(201);
    const order = createRes.json();

    // Race cancelOrderAndRestoreStock and markOrderPaid concurrently
    await Promise.allSettled([
      orderService.cancelOrderAndRestoreStock(order.id, '并发关单测试', order.userId),
      orderService.markOrderPaid(
        order.orderNo,
        `TX_RACE_${order.orderNo}`,
        order.totalAmountCents,
        JSON.stringify({ race: true })
      )
    ]);

    const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    // Either markOrderPaid won cleanly (PENDING_SHIPMENT), OR cancel won and auto-refund reconciled (AUTO_REFUNDED)
    if (finalOrder.status === 'CANCELLED') {
      expect(finalOrder.abnormalPayStatus).toBe('AUTO_REFUNDED');
    } else {
      expect(finalOrder.status).toBe('PENDING_SHIPMENT');
    }

    // Test sync-refund endpoint on an APPROVED_REFUNDING after-sale order
    const order2Res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { addressId: deliverableAddressId, items: [{ skuId, quantity: 1 }] }
    });
    const order2 = order2Res.json();
    await app.inject({
      method: 'POST',
      url: '/api/dev/mock-pay-notify',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { orderNo: order2.orderNo }
    });
    const as2Res = await app.inject({
      method: 'POST',
      url: '/api/after-sales',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { orderId: order2.id, type: 'REFUND_ONLY', reason: '同步退款进度测试' }
    });
    const as2 = as2Res.json();

    // Simulate async PROCESSING state awaiting callback/sync
    await prisma.afterSaleOrder.update({
      where: { id: as2.id },
      data: { status: 'APPROVED_REFUNDING' }
    });

    const syncRes = await app.inject({
      method: 'POST',
      url: `/api/admin/after-sales/${as2.id}/sync-refund`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(syncRes.statusCode).toBe(200);
    expect(syncRes.json().status).toBe('REFUNDED');

    const order2After = await prisma.order.findUniqueOrThrow({ where: { id: order2.id } });
    expect(order2After.status).toBe('REFUNDED');
  });

  it('handles after-sale cancel, REFUND_FAILED retry with rotated outRefundNo, and partial shipped compensation without stock inflation', async () => {
    const skuBefore = await prisma.productSku.findUniqueOrThrow({ where: { id: skuId } });
    const orderRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { addressId: deliverableAddressId, items: [{ skuId, quantity: 1 }] }
    });
    expect(orderRes.statusCode).toBe(201);
    const order = orderRes.json();

    await app.inject({
      method: 'POST',
      url: '/api/dev/mock-pay-notify',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { orderNo: order.orderNo }
    });

    // Reject whitespace trackingNumber and test ship -> update-shipping
    const badShipRes = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${order.id}/ship`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { expressCompanyCode: 'SF', trackingNumber: 'SF 12345' }
    });
    expect(badShipRes.statusCode).toBe(400);

    const shipRes = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${order.id}/ship`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { expressCompanyCode: 'SF', trackingNumber: 'SF10000001' }
    });
    expect(shipRes.statusCode).toBe(200);

    const updateShipRes = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${order.id}/update-shipping`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { expressCompanyCode: 'ZTO', trackingNumber: 'ZTO90000009' }
    });
    expect(updateShipRes.statusCode).toBe(200);
    expect(updateShipRes.json().expressCompanyCode).toBe('ZTO');
    expect(updateShipRes.json().trackingNumber).toBe('ZTO90000009');

    // Buyer creates after-sale then cancels it while PENDING_REVIEW
    const asCancelCreate = await app.inject({
      method: 'POST',
      url: '/api/after-sales',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { orderId: order.id, type: 'REFUND_ONLY', reason: '误点申请售后' }
    });
    expect(asCancelCreate.statusCode).toBe(201);
    const cancelAsId = asCancelCreate.json().id;

    // Duplicate concurrent submit must be blocked
    const dupAsRes = await app.inject({
      method: 'POST',
      url: '/api/after-sales',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { orderId: order.id, type: 'REFUND_ONLY', reason: '重复提交' }
    });
    expect([400, 409]).toContain(dupAsRes.statusCode);

    const withdrawRes = await app.inject({
      method: 'POST',
      url: `/api/after-sales/${cancelAsId}/cancel`,
      headers: { authorization: `Bearer ${userToken}` }
    });
    expect(withdrawRes.statusCode).toBe(200);
    expect(withdrawRes.json().status).toBe('CANCELLED');
    const restoredOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(restoredOrder.status).toBe('SHIPPED');

    // Re-apply REFUND_ONLY partial compensation (e.g. 500 cents price difference), simulate REFUND_FAILED, then retry
    const as2Res = await app.inject({
      method: 'POST',
      url: '/api/after-sales',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { orderId: order.id, type: 'REFUND_ONLY', reason: '协商退差价5元' }
    });
    expect(as2Res.statusCode).toBe(201);
    const as2 = as2Res.json();

    await prisma.afterSaleOrder.update({
      where: { id: as2.id },
      data: { status: 'REFUND_FAILED', rejectReason: '模拟银行卡异常关闭' }
    });

    const retryRes = await app.inject({
      method: 'POST',
      url: `/api/admin/after-sales/${as2.id}/retry-refund`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { refundAmountCents: 500 }
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.json().status).toBe('REFUNDED');
    expect(retryRes.json().outRefundNo).not.toBe(as2.outRefundNo);

    // Goods were shipped and buyer kept them (partial REFUND_ONLY): SKU stock must NOT be inflated back!
    const skuAfterPartial = await prisma.productSku.findUniqueOrThrow({ where: { id: skuId } });
    expect(skuAfterPartial.stock).toBe(skuBefore.stock - 1);
  });

  it('supports abnormal refund retry, blocks deleting default shipping rule, and normalizes excluded province matching', async () => {
    await prisma.productSku.update({ where: { id: skuId }, data: { stock: 5 } });

    // 1. Admin retry-abnormal-refund for MANUAL_REFUND_REQUIRED order
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { addressId: deliverableAddressId, items: [{ skuId, quantity: 1 }] }
    });
    expect(createRes.statusCode).toBe(201);
    const order = createRes.json();
    await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${userToken}` }
    });
    await prisma.order.update({
      where: { id: order.id },
      data: {
        abnormalPayStatus: 'MANUAL_REFUND_REQUIRED',
        abnormalPayNote: '首次自动退款失败'
      }
    });

    const retryAbnRes = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${order.id}/retry-abnormal-refund`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(retryAbnRes.statusCode).toBe(200);
    expect(retryAbnRes.json().abnormalPayStatus).toBe('AUTO_REFUNDED');

    // 2. Blocking deletion of default shipping rule
    const defaultRule = await prisma.shippingRule.findFirstOrThrow({ where: { isDefault: true } });
    const delRuleRes = await app.inject({
      method: 'DELETE',
      url: `/api/admin/shipping-rules/${defaultRule.id}`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(delRuleRes.statusCode).toBe(400);
    expect(delRuleRes.json().code).toBe('CANNOT_DELETE_DEFAULT_RULE');

    // 3. Province normalization blocks "中国西藏" even without standard "自治区" suffix
    const trickyAddrRes = await app.inject({
      method: 'POST',
      url: '/api/addresses',
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        receiverName: '扎西',
        receiverPhone: '13900139001',
        province: '中国西藏',
        city: '拉萨市',
        district: '城关区',
        detailAddress: '宇拓路5号',
        isDefault: false
      }
    });
    expect(trickyAddrRes.statusCode).toBe(201);
    const blockedPreview = await app.inject({
      method: 'POST',
      url: '/api/orders/preview',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { addressId: trickyAddrRes.json().id, items: [{ skuId, quantity: 1 }] }
    });
    expect(blockedPreview.statusCode).toBe(400);
    expect(blockedPreview.json().code).toBe('REGION_NOT_DELIVERABLE');
  });

  it('decouples products:manage metadata, guards admin matrix self-lockout, hides inactive category products, and caps cart quantity at 99', async () => {
    // 1. Create product-only operator and verify /api/admin/products/meta works without shipping:manage
    const createOpRes = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        username: 'prodonly',
        password: 'ProdPassword@1',
        displayName: '商品专员',
        role: 'OPERATOR',
        permissions: ['products:manage']
      }
    });
    expect(createOpRes.statusCode).toBe(201);

    const opLoginRes = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { username: 'prodonly', password: 'ProdPassword@1' }
    });
    const opToken = opLoginRes.json().token;

    const metaRes = await app.inject({
      method: 'GET',
      url: '/api/admin/products/meta',
      headers: { authorization: `Bearer ${opToken}` }
    });
    expect(metaRes.statusCode).toBe(200);
    expect(Array.isArray(metaRes.json().categories)).toBe(true);
    expect(Array.isArray(metaRes.json().shippingRules)).toBe(true);

    const shipPermRes = await app.inject({
      method: 'GET',
      url: '/api/admin/shipping-rules',
      headers: { authorization: `Bearer ${opToken}` }
    });
    expect(shipPermRes.statusCode).toBe(403);

    // 2. Superadmin cannot revoke own admin_users:manage permission
    const superAdmin = await prisma.adminUser.findUniqueOrThrow({ where: { username: 'superadmin' } });
    const selfRevokeRes = await app.inject({
      method: 'PUT',
      url: `/api/admin/users/${superAdmin.id}/permissions`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        permissions: ['dashboard:view'],
        isActive: true
      }
    });
    expect(selfRevokeRes.statusCode).toBe(400);
    expect(selfRevokeRes.json().code).toBe('CANNOT_REVOKE_OWN_ADMIN_PERM');

    // 3. Inactive category hides ON_SALE product from storefront list & detail, and PUT validates refs
    const inactiveCat = await prisma.category.create({
      data: { name: '停用测试分类', sortOrder: 0, isActive: false }
    });
    const rule = await prisma.shippingRule.findFirstOrThrow();
    const hiddenProdRes = await app.inject({
      method: 'POST',
      url: '/api/admin/products',
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        categoryId: inactiveCat.id,
        shippingRuleId: rule.id,
        title: '停用分类下商品',
        coverUrl: 'https://example.com/hidden.jpg',
        status: 'ON_SALE',
        skus: [
          {
            skuCode: 'HIDDEN-CAT-SKU',
            specName: '默认',
            priceCents: 2500,
            stock: 150,
            isActive: true
          }
        ]
      }
    });
    expect(hiddenProdRes.statusCode).toBe(201);
    const hiddenProd = hiddenProdRes.json();

    const detailHiddenRes = await app.inject({
      method: 'GET',
      url: `/api/products/${hiddenProd.id}`
    });
    expect(detailHiddenRes.statusCode).toBe(404);

    // 4. Cart quantity cap <= 99 across accumulated POST /api/cart requests
    const hiddenSkuId = hiddenProd.skus[0].id;
    const cart1 = await app.inject({
      method: 'POST',
      url: '/api/cart',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { skuId: hiddenSkuId, quantity: 60 }
    });
    expect(cart1.statusCode).toBe(201);

    const cartOverflow = await app.inject({
      method: 'POST',
      url: '/api/cart',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { skuId: hiddenSkuId, quantity: 40 }
    });
    expect(cartOverflow.statusCode).toBe(400);
    expect(cartOverflow.json().code).toBe('MAX_CART_QUANTITY');
  });
});
