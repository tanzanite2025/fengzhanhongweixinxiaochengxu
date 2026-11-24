import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError, CriticalError } from '../../lib/errors.js';
import { AuthService } from '../auth/auth.service.js';

function normalizePhoneInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const cleaned = raw.replace(/[\s-]/g, '');
  if (/^\+?86(1\d{10})$/.test(cleaned)) {
    return cleaned.replace(/^\+?86/, '');
  }
  return cleaned;
}

const addressBody = z.object({
  receiverName: z.string().trim().min(1).max(32),
  receiverPhone: z.preprocess(
    normalizePhoneInput,
    z.string().regex(/^1\d{10}$/, '请输入正确的11位手机号')
  ),
  province: z.string().trim().min(1).max(32),
  city: z.string().trim().min(1).max(32),
  district: z.string().trim().min(1).max(32),
  detailAddress: z.string().trim().min(1).max(160),
  isDefault: z.boolean().default(false)
});

/**
 * Register buyer shipping address management routes.
 */
export function registerAddressRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  authService: AuthService
): void {
  app.get('/api/addresses', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    return prisma.userAddress.findMany({
      where: { userId: request.authUserId },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
    });
  });

  app.post('/api/addresses', { preHandler: authService.requireUserAuth }, async (request, reply) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const userId = request.authUserId;
    const body = addressBody.parse(request.body);

    const created = await prisma.$transaction(async (tx) => {
      const existingCount = await tx.userAddress.count({ where: { userId } });
      const shouldDefault = body.isDefault || existingCount === 0;
      if (shouldDefault) {
        await tx.userAddress.updateMany({ where: { userId }, data: { isDefault: false } });
      }
      return tx.userAddress.create({
        data: {
          userId,
          receiverName: body.receiverName,
          receiverPhone: body.receiverPhone,
          province: body.province,
          city: body.city,
          district: body.district,
          detailAddress: body.detailAddress,
          isDefault: shouldDefault
        }
      });
    });

    return reply.status(201).send(created);
  });

  app.put('/api/addresses/:id', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const userId = request.authUserId;
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const body = addressBody.parse(request.body);

    const existing = await prisma.userAddress.findFirst({ where: { id: params.id, userId } });
    if (!existing) {
      throw new AppError(404, 'ADDRESS_NOT_FOUND', '收货地址不存在');
    }

    return prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.userAddress.updateMany({ where: { userId }, data: { isDefault: false } });
      }
      return tx.userAddress.update({
        where: { id: params.id },
        data: body
      });
    });
  });

  app.delete('/api/addresses/:id', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const existing = await prisma.userAddress.findFirst({
      where: { id: params.id, userId: request.authUserId }
    });
    if (!existing) {
      throw new AppError(404, 'ADDRESS_NOT_FOUND', '收货地址不存在');
    }
    await prisma.userAddress.delete({ where: { id: existing.id } });
    return { success: true };
  });
}
