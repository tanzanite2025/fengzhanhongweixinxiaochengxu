import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { ALL_ADMIN_PERMISSIONS } from '../src/modules/auth/auth.service.js';

const prisma = new PrismaClient();

async function seed(): Promise<void> {
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@2026!';
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  await prisma.adminUser.upsert({
    where: { username: 'admin' },
    update: {
      permissions: JSON.stringify([...ALL_ADMIN_PERMISSIONS]),
      isActive: true
    },
    create: {
      username: 'admin',
      passwordHash,
      displayName: '系统主管理员',
      role: 'SUPER_ADMIN',
      permissions: JSON.stringify([...ALL_ADMIN_PERMISSIONS]),
      isActive: true
    }
  });

  const defaultRule = await prisma.shippingRule.upsert({
    where: { name: '全国标准运费（满99包邮）' },
    update: {},
    create: {
      name: '全国标准运费（满99包邮）',
      isDefault: true,
      baseFeeCents: 800,
      extraItemFeeCents: 200,
      freeThresholdCents: 9900,
      excludedProvinces: JSON.stringify(['西藏', '新疆'])
    }
  });

  const catTea = await prisma.category.upsert({
    where: { name: '精选茗茶' },
    update: {},
    create: { name: '精选茗茶', sortOrder: 100, isActive: true }
  });

  const catWare = await prisma.category.upsert({
    where: { name: '生活器物' },
    update: {},
    create: { name: '生活器物', sortOrder: 90, isActive: true }
  });

  const existingProduct = await prisma.product.findFirst({
    where: { title: '高山乌龙礼盒装' }
  });

  if (!existingProduct) {
    await prisma.product.create({
      data: {
        categoryId: catTea.id,
        shippingRuleId: defaultRule.id,
        title: '高山乌龙礼盒装',
        subtitle: '当季新采 · 顺丰冷链直发',
        coverUrl: 'https://dummyimage.com/600x600/1f2937/f9fafb&text=Oolong+Tea',
        galleryUrls: JSON.stringify([
          'https://dummyimage.com/800x800/1f2937/f9fafb&text=Oolong+1',
          'https://dummyimage.com/800x800/374151/f9fafb&text=Oolong+2'
        ]),
        descriptionHtml: '<p>精选高海拔生态茶园鲜叶，传统炭焙工艺，香气清雅持久。</p>',
        status: 'ON_SALE',
        sortOrder: 100,
        skus: {
          create: [
            {
              skuCode: 'TEA-OOLONG-150G',
              specName: '150g 品鉴罐装',
              priceCents: 6800,
              originalPriceCents: 8800,
              stock: 50,
              isActive: true
            },
            {
              skuCode: 'TEA-OOLONG-300G',
              specName: '300g 礼盒装',
              priceCents: 12800,
              originalPriceCents: 16800,
              stock: 30,
              isActive: true
            }
          ]
        }
      }
    });
  }

  const existingCup = await prisma.product.findFirst({
    where: { title: '手工粗陶品茗杯' }
  });

  if (!existingCup) {
    await prisma.product.create({
      data: {
        categoryId: catWare.id,
        shippingRuleId: defaultRule.id,
        title: '手工粗陶品茗杯',
        subtitle: '景德镇手作 · 高温还原烧',
        coverUrl: 'https://dummyimage.com/600x600/334155/f8fafc&text=Ceramic+Cup',
        galleryUrls: JSON.stringify([
          'https://dummyimage.com/800x800/334155/f8fafc&text=Cup+1'
        ]),
        descriptionHtml: '<p>天然矿物釉面，温润贴手，容量 75ml，防烫耐看。</p>',
        status: 'ON_SALE',
        sortOrder: 90,
        skus: {
          create: [
            {
              skuCode: 'CUP-MIST-75',
              specName: '雾灰釉 · 单杯',
              priceCents: 4500,
              originalPriceCents: 5900,
              stock: 40,
              isActive: true
            },
            {
              skuCode: 'CUP-INK-PAIR',
              specName: '墨釉 · 对杯礼盒',
              priceCents: 8600,
              originalPriceCents: 10800,
              stock: 20,
              isActive: true
            }
          ]
        }
      }
    });
  }

  console.log('Seed completed. Default admin username=admin password=' + adminPassword);
}

seed()
  .catch((err) => {
    console.error('[CRITICAL] Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
