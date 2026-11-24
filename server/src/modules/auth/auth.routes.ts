import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError, CriticalError } from '../../lib/errors.js';
import { parseStringArrayJson } from '../../lib/json.js';
import { ALL_ADMIN_PERMISSIONS, AuthService } from './auth.service.js';

const wechatLoginBody = z.object({
  code: z.string().min(1, '登录 code 不能为空')
});

const updateProfileBody = z.object({
  nickname: z.string().min(1).max(32).optional(),
  avatarUrl: z.string().url().optional()
});

const adminLoginBody = z.object({
  username: z.string().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码')
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(8, '新密码长度至少 8 位').max(64)
});

const createAdminBody = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(64),
  displayName: z.string().min(1).max(32),
  role: z.enum(['SUPER_ADMIN', 'OPERATOR']),
  permissions: z.array(z.enum(ALL_ADMIN_PERMISSIONS)).min(1)
});

const updatePermissionsBody = z.object({
  permissions: z.array(z.enum(ALL_ADMIN_PERMISSIONS)),
  isActive: z.boolean()
});

/**
 * Register authentication and admin RBAC matrix routes.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  authService: AuthService
): void {
  app.post('/api/auth/wechat-login', async (request) => {
    const body = wechatLoginBody.parse(request.body);
    return authService.wechatLogin(body.code);
  });

  app.get('/api/auth/me', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) {
      throw new CriticalError('authUserId missing after requireUserAuth');
    }
    const user = await prisma.user.findUnique({
      where: { id: request.authUserId },
      select: { id: true, nickname: true, avatarUrl: true, phone: true, createdAt: true }
    });
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');
    }
    return user;
  });

  app.put('/api/auth/me', { preHandler: authService.requireUserAuth }, async (request) => {
    if (!request.authUserId) {
      throw new CriticalError('authUserId missing after requireUserAuth');
    }
    const body = updateProfileBody.parse(request.body);
    return prisma.user.update({
      where: { id: request.authUserId },
      data: {
        ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
        ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {})
      },
      select: { id: true, nickname: true, avatarUrl: true, phone: true }
    });
  });

  app.post('/api/admin/auth/login', async (request) => {
    const body = adminLoginBody.parse(request.body);
    return authService.adminLogin(body.username, body.password);
  });

  app.get(
    '/api/admin/auth/me',
    { preHandler: authService.requireAdminPermission() },
    async (request) => {
      if (!request.authAdmin) {
        throw new CriticalError('authAdmin missing after requireAdminPermission');
      }
      return {
        ...request.authAdmin,
        allPermissions: ALL_ADMIN_PERMISSIONS
      };
    }
  );

  app.post(
    '/api/admin/auth/change-password',
    { preHandler: authService.requireAdminPermission() },
    async (request) => {
      if (!request.authAdmin) {
        throw new CriticalError('authAdmin missing after requireAdminPermission');
      }
      const body = changePasswordBody.parse(request.body);
      if (body.currentPassword === body.newPassword) {
        throw new AppError(400, 'SAME_PASSWORD', '新密码不能与当前密码相同');
      }

      const admin = await prisma.adminUser.findUnique({
        where: { id: request.authAdmin.id },
        select: { id: true, passwordHash: true }
      });
      if (!admin) {
        throw new AppError(404, 'ADMIN_NOT_FOUND', '管理员账号不存在');
      }

      const valid = await bcrypt.compare(body.currentPassword, admin.passwordHash);
      if (!valid) {
        throw new AppError(400, 'INVALID_CURRENT_PASSWORD', '当前密码不正确');
      }

      const nextHash = await bcrypt.hash(body.newPassword, 10);
      await prisma.adminUser.update({
        where: { id: admin.id },
        data: { passwordHash: nextHash }
      });

      return { success: true };
    }
  );

  app.get(
    '/api/admin/users',
    { preHandler: authService.requireAdminPermission('admin_users:manage') },
    async () => {
      const admins = await prisma.adminUser.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          permissions: true,
          isActive: true,
          createdAt: true
        }
      });
      return admins.map((a) => ({
        ...a,
        permissions: parseStringArrayJson(a.permissions, `AdminUser(${a.id}).permissions`)
      }));
    }
  );

  app.post(
    '/api/admin/users',
    { preHandler: authService.requireAdminPermission('admin_users:manage') },
    async (request, reply) => {
      const body = createAdminBody.parse(request.body);
      const exists = await prisma.adminUser.findUnique({ where: { username: body.username } });
      if (exists) {
        throw new AppError(409, 'USERNAME_EXISTS', '该管理员账号已存在');
      }
      const passwordHash = await bcrypt.hash(body.password, 10);
      const created = await prisma.adminUser.create({
        data: {
          username: body.username,
          passwordHash,
          displayName: body.displayName,
          role: body.role,
          permissions: JSON.stringify(body.permissions),
          isActive: true
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          permissions: true,
          isActive: true
        }
      });
      return reply.status(201).send({
        ...created,
        permissions: parseStringArrayJson(created.permissions, `AdminUser(${created.id}).permissions`)
      });
    }
  );

  app.put(
    '/api/admin/users/:id/permissions',
    { preHandler: authService.requireAdminPermission('admin_users:manage') },
    async (request) => {
      const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const body = updatePermissionsBody.parse(request.body);
      const target = await prisma.adminUser.findUnique({ where: { id: params.id } });
      if (!target) {
        throw new AppError(404, 'ADMIN_NOT_FOUND', '管理员不存在');
      }
      if (request.authAdmin?.id === params.id && !body.isActive) {
        throw new AppError(400, 'CANNOT_DISABLE_SELF', '不能禁用当前登录账号');
      }

      const updated = await prisma.adminUser.update({
        where: { id: params.id },
        data: {
          permissions: JSON.stringify(body.permissions),
          isActive: body.isActive
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          permissions: true,
          isActive: true
        }
      });

      return {
        ...updated,
        permissions: parseStringArrayJson(updated.permissions, `AdminUser(${updated.id}).permissions`)
      };
    }
  );
}
