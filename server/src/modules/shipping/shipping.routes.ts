import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { parseStringArrayJson } from '../../lib/json.js';
import { AuthService } from '../auth/auth.service.js';

const shippingRuleBody = z.object({
  name: z.string().min(1).max(64),
  isDefault: z.boolean().default(false),
  baseFeeCents: z.number().int().min(0),
  extraItemFeeCents: z.number().int().min(0),
  freeThresholdCents: z.number().int().min(0).nullable(),
  excludedProvinces: z.array(z.string().min(1)).default([])
});

/**
 * Register shipping rule management routes.
 */
export function registerShippingRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  authService: AuthService
): void {
  app.get(
    '/api/admin/shipping-rules',
    { preHandler: authService.requireAdminPermission('shipping:manage') },
    async () => {
      const rules = await prisma.shippingRule.findMany({ orderBy: { id: 'asc' } });
      return rules.map((r) => ({
        ...r,
        excludedProvinces: parseStringArrayJson(
          r.excludedProvinces,
          `ShippingRule(${r.id}).excludedProvinces`
        )
      }));
    }
  );

  app.post(
    '/api/admin/shipping-rules',
    { preHandler: authService.requireAdminPermission('shipping:manage') },
    async (request, reply) => {
      const body = shippingRuleBody.parse(request.body);
      const created = await prisma.$transaction(async (tx) => {
        if (body.isDefault) {
          await tx.shippingRule.updateMany({ data: { isDefault: false } });
        }
        return tx.shippingRule.create({
          data: {
            name: body.name,
            isDefault: body.isDefault,
            baseFeeCents: body.baseFeeCents,
            extraItemFeeCents: body.extraItemFeeCents,
            freeThresholdCents: body.freeThresholdCents,
            excludedProvinces: JSON.stringify(body.excludedProvinces)
          }
        });
      });

      return reply.status(201).send({
        ...created,
        excludedProvinces: parseStringArrayJson(
          created.excludedProvinces,
          `ShippingRule(${created.id}).excludedProvinces`
        )
      });
    }
  );

  app.put(
    '/api/admin/shipping-rules/:id',
    { preHandler: authService.requireAdminPermission('shipping:manage') },
    async (request) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const body = shippingRuleBody.parse(request.body);

      const exists = await prisma.shippingRule.findUnique({ where: { id: params.id } });
      if (!exists) {
        throw new AppError(404, 'SHIPPING_RULE_NOT_FOUND', '运费模板不存在');
      }

      const updated = await prisma.$transaction(async (tx) => {
        if (body.isDefault) {
          await tx.shippingRule.updateMany({ data: { isDefault: false } });
        }
        return tx.shippingRule.update({
          where: { id: params.id },
          data: {
            name: body.name,
            isDefault: body.isDefault,
            baseFeeCents: body.baseFeeCents,
            extraItemFeeCents: body.extraItemFeeCents,
            freeThresholdCents: body.freeThresholdCents,
            excludedProvinces: JSON.stringify(body.excludedProvinces)
          }
        });
      });

      return {
        ...updated,
        excludedProvinces: parseStringArrayJson(
          updated.excludedProvinces,
          `ShippingRule(${updated.id}).excludedProvinces`
        )
      };
    }
  );

  app.delete(
    '/api/admin/shipping-rules/:id',
    { preHandler: authService.requireAdminPermission('shipping:manage') },
    async (request) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const inUseCount = await prisma.product.count({ where: { shippingRuleId: params.id } });
      if (inUseCount > 0) {
        throw new AppError(400, 'SHIPPING_RULE_IN_USE', '该运费模板正在被商品使用，无法删除');
      }
      await prisma.shippingRule.delete({ where: { id: params.id } });
      return { success: true };
    }
  );
}
