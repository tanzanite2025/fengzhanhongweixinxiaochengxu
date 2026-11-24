import path from 'node:path';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';
import type { AppConfig } from './config/env.js';
import { AppError, CriticalError } from './lib/errors.js';
import { registerAddressRoutes } from './modules/address/address.routes.js';
import { registerAfterSaleRoutes } from './modules/after-sale/after-sale.routes.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { AuthService } from './modules/auth/auth.service.js';
import { registerCartRoutes } from './modules/cart/cart.routes.js';
import { registerOrderRoutes } from './modules/order/order.routes.js';
import { OrderService } from './modules/order/order.service.js';
import { registerProductRoutes } from './modules/product/product.routes.js';
import { registerShippingRoutes } from './modules/shipping/shipping.routes.js';
import { WechatPayService } from './modules/wechat-pay/wechat-pay.service.js';
import { WechatShippingService } from './modules/wechat-shipping/wechat-shipping.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export interface BuildAppOptions {
  prisma: PrismaClient;
  config: AppConfig;
  uploadDir?: string;
}

/**
 * Assemble the Fastify server, register all domain routes, and configure fail-loudly error handling.
 */
export async function buildApp(options: BuildAppOptions): Promise<{
  app: FastifyInstance;
  orderService: OrderService;
}> {
  const { prisma, config } = options;
  const uploadDir = options.uploadDir ?? path.resolve(process.cwd(), 'uploads');

  const app = Fastify({
    logger: config.nodeEnv !== 'test'
  });

  // Preserve exact raw JSON body for cryptographic WeChat Pay V3 signature verification.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = raw;
    if (raw.trim().length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(new AppError(400, 'INVALID_JSON', '请求体不是有效的 JSON 格式'));
    }
  });

  await app.register(cors, {
    origin: true,
    credentials: true
  });

  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 }
  });

  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: '/uploads/',
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      const details = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: `参数校验失败: ${details}`
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const target = Array.isArray(error.meta?.target)
          ? error.meta.target.join(', ')
          : String(error.meta?.target ?? '唯一字段');
        return reply.status(409).send({
          code: 'DUPLICATE_RECORD',
          message: `存在重复数据，请检查唯一字段: ${target}`
        });
      }
      if (error.code === 'P2003') {
        return reply.status(400).send({
          code: 'INVALID_REFERENCE',
          message: '关联数据不存在或正在被其他记录引用'
        });
      }
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        code: error.code,
        message: error.message
      });
    }

    if (error instanceof CriticalError) {
      app.log.error({ err: error }, 'Critical runtime error');
      return reply.status(500).send({
        code: error.code,
        message: error.message
      });
    }

    app.log.error({ err: error }, 'Unhandled server error');
    return reply.status(500).send({
      code: 'INTERNAL_SERVER_ERROR',
      message: error instanceof Error ? error.message : '服务器内部异常'
    });
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    wechatMode: config.wechatMode,
    timestamp: new Date().toISOString()
  }));

  const authService = new AuthService(prisma, config);
  const wechatPay = new WechatPayService(config);
  const wechatShipping = new WechatShippingService(config);
  const orderService = new OrderService(prisma, config, wechatPay, wechatShipping);

  registerAuthRoutes(app, prisma, authService);
  registerShippingRoutes(app, prisma, authService);
  registerProductRoutes(app, prisma, authService, config, uploadDir);
  registerCartRoutes(app, prisma, authService);
  registerAddressRoutes(app, prisma, authService);
  registerOrderRoutes(app, prisma, config, authService, orderService, wechatPay);
  registerAfterSaleRoutes(app, prisma, authService, wechatPay);

  return { app, orderService };
}
