import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { validateUploadedImage } from '../../lib/image-validation.js';
import { parseStringArrayJson } from '../../lib/json.js';
import { AuthService } from '../auth/auth.service.js';

const categoryBody = z.object({
  name: z.string().min(1).max(32),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true)
});

const skuInputSchema = z.object({
  id: z.number().int().positive().optional(),
  skuCode: z.string().min(1).max(64),
  specName: z.string().min(1).max(64),
  specImageUrl: z.string().min(1).nullable().optional(),
  priceCents: z.number().int().positive(),
  originalPriceCents: z.number().int().positive().nullable().optional(),
  stock: z.number().int().min(0),
  isActive: z.boolean().default(true)
});

const productBody = z
  .object({
    categoryId: z.number().int().positive(),
    shippingRuleId: z.number().int().positive(),
    title: z.string().min(1).max(120),
    subtitle: z.string().max(200).nullable().optional(),
    coverUrl: z.string().min(1),
    galleryUrls: z.array(z.string().min(1)).default([]),
    descriptionHtml: z.string().default(''),
    status: z.enum(['ON_SALE', 'OFF_SALE']).default('ON_SALE'),
    sortOrder: z.number().int().default(0),
    skus: z.array(skuInputSchema).min(1, '至少需要配置一个 SKU 规格')
  })
  .superRefine((data, ctx) => {
    if (data.status === 'ON_SALE' && !data.skus.some((s) => s.isActive)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['skus'],
        message: '上架商品至少需要启用一个 SKU 规格'
      });
    }
  });

function formatProduct(product: {
  id: number;
  categoryId: number;
  shippingRuleId: number;
  title: string;
  subtitle: string | null;
  coverUrl: string;
  galleryUrls: string;
  descriptionHtml: string;
  status: string;
  sortOrder: number;
  salesCount: number;
  createdAt: Date;
  updatedAt: Date;
  category?: { id: number; name: string };
  shippingRule?: {
    id: number;
    name: string;
    baseFeeCents: number;
    extraItemFeeCents: number;
    freeThresholdCents: number | null;
    excludedProvinces: string;
  };
  skus: Array<{
    id: number;
    productId: number;
    skuCode: string;
    specName: string;
    specImageUrl: string | null;
    priceCents: number;
    originalPriceCents: number | null;
    stock: number;
    isActive: boolean;
  }>;
}) {
  return {
    ...product,
    galleryUrls: parseStringArrayJson(product.galleryUrls, `Product(${product.id}).galleryUrls`),
    shippingRule: product.shippingRule
      ? {
          ...product.shippingRule,
          excludedProvinces: parseStringArrayJson(
            product.shippingRule.excludedProvinces,
            `ShippingRule(${product.shippingRule.id}).excludedProvinces`
          )
        }
      : undefined
  };
}

/**
 * Register storefront & admin category/product/upload routes.
 */
export function registerProductRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  authService: AuthService,
  config: AppConfig,
  uploadDir: string
): void {
  // Public storefront: categories
  app.get('/api/categories', async () => {
    return prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'desc' }, { id: 'asc' }]
    });
  });

  // Public storefront: product list
  app.get('/api/products', async (request) => {
    const query = z
      .object({
        categoryId: z.coerce.number().int().positive().optional(),
        keyword: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20)
      })
      .parse(request.query);

    const where = {
      status: 'ON_SALE',
      category: { isActive: true },
      skus: { some: { isActive: true } },
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.keyword && query.keyword.trim().length > 0
        ? {
            OR: [
              { title: { contains: query.keyword.trim() } },
              { subtitle: { contains: query.keyword.trim() } }
            ]
          }
        : {})
    };

    const [total, list] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          skus: { where: { isActive: true }, orderBy: { priceCents: 'asc' } }
        },
        orderBy: [{ sortOrder: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      })
    ]);

    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: list.map(formatProduct)
    };
  });

  // Public storefront: product detail
  app.get('/api/products/:id', async (request) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const product = await prisma.product.findFirst({
      where: {
        id: params.id,
        status: 'ON_SALE',
        category: { isActive: true },
        skus: { some: { isActive: true } }
      },
      include: {
        category: { select: { id: true, name: true } },
        shippingRule: true,
        skus: { where: { isActive: true }, orderBy: { id: 'asc' } }
      }
    });

    if (!product) {
      throw new AppError(404, 'PRODUCT_NOT_FOUND', '商品不存在或已下架');
    }
    return formatProduct(product);
  });

  // Admin: categories CRUD
  app.get(
    '/api/admin/categories',
    { preHandler: authService.requireAdminPermission('categories:manage') },
    async () => {
      return prisma.category.findMany({ orderBy: [{ sortOrder: 'desc' }, { id: 'asc' }] });
    }
  );

  app.post(
    '/api/admin/categories',
    { preHandler: authService.requireAdminPermission('categories:manage') },
    async (request, reply) => {
      const body = categoryBody.parse(request.body);
      const exists = await prisma.category.findUnique({ where: { name: body.name } });
      if (exists) {
        throw new AppError(409, 'CATEGORY_EXISTS', '分类名称已存在');
      }
      const created = await prisma.category.create({ data: body });
      return reply.status(201).send(created);
    }
  );

  app.put(
    '/api/admin/categories/:id',
    { preHandler: authService.requireAdminPermission('categories:manage') },
    async (request) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const body = categoryBody.parse(request.body);
      const exists = await prisma.category.findUnique({ where: { id: params.id } });
      if (!exists) {
        throw new AppError(404, 'CATEGORY_NOT_FOUND', '分类不存在');
      }
      return prisma.category.update({ where: { id: params.id }, data: body });
    }
  );

  app.delete(
    '/api/admin/categories/:id',
    { preHandler: authService.requireAdminPermission('categories:manage') },
    async (request) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const count = await prisma.product.count({ where: { categoryId: params.id } });
      if (count > 0) {
        throw new AppError(400, 'CATEGORY_IN_USE', '该分类下仍有商品，不能删除');
      }
      await prisma.category.delete({ where: { id: params.id } });
      return { success: true };
    }
  );

  // Admin: products metadata options (decoupled from shipping:manage / categories:manage permissions)
  app.get(
    '/api/admin/products/meta',
    { preHandler: authService.requireAdminPermission('products:manage') },
    async () => {
      const [categories, shippingRules] = await Promise.all([
        prisma.category.findMany({ orderBy: [{ sortOrder: 'desc' }, { id: 'asc' }] }),
        prisma.shippingRule.findMany({ orderBy: { id: 'asc' } })
      ]);
      return {
        categories,
        shippingRules: shippingRules.map((r) => ({
          ...r,
          excludedProvinces: parseStringArrayJson(
            r.excludedProvinces,
            `ShippingRule(${r.id}).excludedProvinces`
          )
        }))
      };
    }
  );

  // Admin: products CRUD
  app.get(
    '/api/admin/products',
    { preHandler: authService.requireAdminPermission('products:manage') },
    async () => {
      const list = await prisma.product.findMany({
        include: {
          category: { select: { id: true, name: true } },
          shippingRule: true,
          skus: { orderBy: { id: 'asc' } }
        },
        orderBy: [{ sortOrder: 'desc' }, { id: 'desc' }]
      });
      return list.map(formatProduct);
    }
  );

  const assertRefsExist = async (categoryId: number, shippingRuleId: number) => {
    const [category, shippingRule] = await Promise.all([
      prisma.category.findUnique({ where: { id: categoryId } }),
      prisma.shippingRule.findUnique({ where: { id: shippingRuleId } })
    ]);
    if (!category) throw new AppError(400, 'CATEGORY_NOT_FOUND', '所选商品分类不存在');
    if (!shippingRule) throw new AppError(400, 'SHIPPING_RULE_NOT_FOUND', '所选运费模板不存在');
  };

  app.post(
    '/api/admin/products',
    { preHandler: authService.requireAdminPermission('products:manage') },
    async (request, reply) => {
      const body = productBody.parse(request.body);
      await assertRefsExist(body.categoryId, body.shippingRuleId);

      const created = await prisma.product.create({
        data: {
          categoryId: body.categoryId,
          shippingRuleId: body.shippingRuleId,
          title: body.title,
          subtitle: body.subtitle ?? null,
          coverUrl: body.coverUrl,
          galleryUrls: JSON.stringify(body.galleryUrls),
          descriptionHtml: body.descriptionHtml,
          status: body.status,
          sortOrder: body.sortOrder,
          skus: {
            create: body.skus.map((sku) => ({
              skuCode: sku.skuCode,
              specName: sku.specName,
              specImageUrl: sku.specImageUrl ?? null,
              priceCents: sku.priceCents,
              originalPriceCents: sku.originalPriceCents ?? null,
              stock: sku.stock,
              isActive: sku.isActive
            }))
          }
        },
        include: {
          category: { select: { id: true, name: true } },
          shippingRule: true,
          skus: true
        }
      });

      return reply.status(201).send(formatProduct(created));
    }
  );

  app.put(
    '/api/admin/products/:id',
    { preHandler: authService.requireAdminPermission('products:manage') },
    async (request) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const body = productBody.parse(request.body);

      const existing = await prisma.product.findUnique({
        where: { id: params.id },
        include: { skus: true }
      });
      if (!existing) {
        throw new AppError(404, 'PRODUCT_NOT_FOUND', '商品不存在');
      }
      await assertRefsExist(body.categoryId, body.shippingRuleId);

      const existingSkuIds = new Set(existing.skus.map((s) => s.id));
      for (const sku of body.skus) {
        if (sku.id !== undefined && !existingSkuIds.has(sku.id)) {
          throw new AppError(
            400,
            'INVALID_SKU_ID',
            `SKU #${sku.id} 不属于当前商品，拒绝跨商品修改`
          );
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id: params.id },
          data: {
            categoryId: body.categoryId,
            shippingRuleId: body.shippingRuleId,
            title: body.title,
            subtitle: body.subtitle ?? null,
            coverUrl: body.coverUrl,
            galleryUrls: JSON.stringify(body.galleryUrls),
            descriptionHtml: body.descriptionHtml,
            status: body.status,
            sortOrder: body.sortOrder
          }
        });

        const incomingIds = new Set(body.skus.filter((s) => s.id).map((s) => s.id as number));
        for (const oldSku of existing.skus) {
          if (!incomingIds.has(oldSku.id)) {
            await tx.productSku.update({
              where: { id: oldSku.id },
              data: { isActive: false }
            });
          }
        }

        for (const sku of body.skus) {
          if (sku.id) {
            await tx.productSku.update({
              where: { id: sku.id },
              data: {
                skuCode: sku.skuCode,
                specName: sku.specName,
                specImageUrl: sku.specImageUrl ?? null,
                priceCents: sku.priceCents,
                originalPriceCents: sku.originalPriceCents ?? null,
                stock: sku.stock,
                isActive: sku.isActive
              }
            });
          } else {
            await tx.productSku.create({
              data: {
                productId: params.id,
                skuCode: sku.skuCode,
                specName: sku.specName,
                specImageUrl: sku.specImageUrl ?? null,
                priceCents: sku.priceCents,
                originalPriceCents: sku.originalPriceCents ?? null,
                stock: sku.stock,
                isActive: sku.isActive
              }
            });
          }
        }

        return tx.product.findUniqueOrThrow({
          where: { id: params.id },
          include: {
            category: { select: { id: true, name: true } },
            shippingRule: true,
            skus: { orderBy: { id: 'asc' } }
          }
        });
      });

      return formatProduct(updated);
    }
  );

  // Admin: upload product image
  app.post(
    '/api/admin/upload',
    { preHandler: authService.requireAdminPermission('products:manage') },
    async (request) => {
      const file = await request.file();
      if (!file) {
        throw new AppError(400, 'FILE_REQUIRED', '请上传图片文件');
      }

      const buffer = await file.toBuffer();
      const ext = validateUploadedImage(file.filename, buffer);

      const fileName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
      await fs.mkdir(uploadDir, { recursive: true });
      await fs.writeFile(path.join(uploadDir, fileName), buffer);

      return { url: `${config.baseUrl}/uploads/${fileName}` };
    }
  );
}
