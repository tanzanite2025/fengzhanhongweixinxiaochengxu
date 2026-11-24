import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError, CriticalError } from '../../lib/errors.js';
import { AuthService } from '../auth/auth.service.js';

const addCartBody = z.object({
  skuId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(99)
});

const updateCartBody = z.object({
  quantity: z.number().int().min(1).max(99).optional(),
  selected: z.boolean().optional()
});

/**
 * Register buyer shopping cart routes.
 */
export function registerCartRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  authService: AuthService
): void {
  app.get('/api/cart', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const items = await prisma.cartItem.findMany({
      where: { userId: request.authUserId },
      include: {
        sku: {
          include: {
            product: {
              select: { id: true, title: true, coverUrl: true, status: true }
            }
          }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    return items.map((item) => {
      const available =
        item.sku.isActive &&
        item.sku.product.status === 'ON_SALE' &&
        item.sku.stock >= item.quantity;
      return {
        id: item.id,
        skuId: item.skuId,
        quantity: item.quantity,
        selected: item.selected,
        available,
        unavailableReason: !item.sku.isActive || item.sku.product.status !== 'ON_SALE'
          ? '商品已下架'
          : item.sku.stock < item.quantity
            ? `库存不足（剩余 ${item.sku.stock} 件）`
            : null,
        sku: {
          id: item.sku.id,
          specName: item.sku.specName,
          specImageUrl: item.sku.specImageUrl,
          priceCents: item.sku.priceCents,
          stock: item.sku.stock
        },
        product: item.sku.product
      };
    });
  });

  app.post('/api/cart', { preHandler: authService.requireUserAuth }, async (request, reply) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const body = addCartBody.parse(request.body);

    const sku = await prisma.productSku.findUnique({
      where: { id: body.skuId },
      include: { product: true }
    });
    if (!sku || !sku.isActive || sku.product.status !== 'ON_SALE') {
      throw new AppError(400, 'SKU_UNAVAILABLE', '该商品规格已下架或不存在');
    }

    const existing = await prisma.cartItem.findUnique({
      where: { userId_skuId: { userId: request.authUserId, skuId: body.skuId } }
    });
    const nextQty = (existing?.quantity ?? 0) + body.quantity;
    if (nextQty > sku.stock) {
      throw new AppError(400, 'INSUFFICIENT_STOCK', `库存不足，当前最多可加购 ${sku.stock} 件`);
    }

    const item = existing
      ? await prisma.cartItem.update({
          where: { id: existing.id },
          data: { quantity: nextQty, selected: true }
        })
      : await prisma.cartItem.create({
          data: {
            userId: request.authUserId,
            skuId: body.skuId,
            quantity: body.quantity,
            selected: true
          }
        });

    return reply.status(201).send(item);
  });

  app.put('/api/cart/:id', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const body = updateCartBody.parse(request.body);

    const existing = await prisma.cartItem.findFirst({
      where: { id: params.id, userId: request.authUserId },
      include: { sku: { include: { product: true } } }
    });
    if (!existing) {
      throw new AppError(404, 'CART_ITEM_NOT_FOUND', '购物车商品不存在');
    }

    if (body.quantity !== undefined) {
      if (!existing.sku.isActive || existing.sku.product.status !== 'ON_SALE') {
        throw new AppError(400, 'SKU_UNAVAILABLE', '该商品已下架');
      }
      if (body.quantity > existing.sku.stock) {
        throw new AppError(
          400,
          'INSUFFICIENT_STOCK',
          `库存不足，当前仅剩 ${existing.sku.stock} 件`
        );
      }
    }

    return prisma.cartItem.update({
      where: { id: existing.id },
      data: {
        ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
        ...(body.selected !== undefined ? { selected: body.selected } : {})
      }
    });
  });

  app.delete('/api/cart/:id', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) throw new CriticalError('authUserId missing');
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const existing = await prisma.cartItem.findFirst({
      where: { id: params.id, userId: request.authUserId }
    });
    if (!existing) {
      throw new AppError(404, 'CART_ITEM_NOT_FOUND', '购物车商品不存在');
    }
    await prisma.cartItem.delete({ where: { id: existing.id } });
    return { success: true };
  });
}
