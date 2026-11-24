import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { AppError, CriticalError } from '../../lib/errors.js';
import { parseStringArrayJson } from '../../lib/json.js';

export const ALL_ADMIN_PERMISSIONS = [
  'dashboard:view',
  'products:manage',
  'categories:manage',
  'shipping:manage',
  'orders:manage',
  'after_sales:manage',
  'admin_users:manage'
] as const;

export type AdminPermission = (typeof ALL_ADMIN_PERMISSIONS)[number];

interface JwtPayload {
  sub: number;
  kind: 'USER' | 'ADMIN';
}

declare module 'fastify' {
  interface FastifyRequest {
    authUserId?: number;
    authAdmin?: {
      id: number;
      username: string;
      displayName: string;
      permissions: string[];
    };
  }
}

/**
 * Authentication and authorization service for Mini Program users and Admin operators.
 * Login methods strictly verify identity and return only token and userId without side-loading business data.
 */
export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig
  ) {}

  /**
   * Sign a short/medium-lived JWT containing only subject ID and principal kind.
   */
  public signToken(sub: number, kind: 'USER' | 'ADMIN'): string {
    return jwt.sign({ sub, kind }, this.config.jwtSecret, {
      expiresIn: this.config.jwtExpiresIn as jwt.SignOptions['expiresIn']
    });
  }

  /**
   * Verify a bearer JWT token and enforce principal kind.
   */
  public verifyToken(token: string, expectedKind: 'USER' | 'ADMIN'): number {
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, this.config.jwtSecret);
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', '登录状态已失效，请重新登录');
    }

    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      typeof (decoded as JwtPayload).sub !== 'number' ||
      (decoded as JwtPayload).kind !== expectedKind
    ) {
      throw new AppError(401, 'UNAUTHORIZED', '无效的登录凭证');
    }

    return (decoded as JwtPayload).sub;
  }

  /**
   * Authenticate a WeChat Mini Program buyer using wx.login code.
   * Returns only { token, userId }.
   */
  public async wechatLogin(code: string): Promise<{ token: string; userId: number }> {
    const trimmedCode = code.trim();
    if (trimmedCode.length === 0) {
      throw new AppError(400, 'INVALID_CODE', '微信登录 code 不能为空');
    }

    let openId: string;
    let unionId: string | null = null;

    if (this.config.wechatMode === 'live') {
      if (!this.config.wechat) {
        throw new CriticalError('WeChat configuration is missing in live mode');
      }
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.searchParams.set('appid', this.config.wechat.appId);
      url.searchParams.set('secret', this.config.wechat.appSecret);
      url.searchParams.set('js_code', trimmedCode);
      url.searchParams.set('grant_type', 'authorization_code');

      const response = await fetch(url);
      if (!response.ok) {
        throw new CriticalError(`WeChat jscode2session HTTP error: ${response.status}`);
      }

      const data = (await response.json()) as {
        openid?: string;
        unionid?: string;
        errcode?: number;
        errmsg?: string;
      };

      if (data.errcode && data.errcode !== 0) {
        throw new AppError(
          401,
          'WECHAT_LOGIN_FAILED',
          `微信登录失败 (${data.errcode}): ${data.errmsg ?? '未知错误'}`
        );
      }

      if (!data.openid) {
        throw new CriticalError('WeChat jscode2session returned success without openid');
      }
      openId = data.openid;
      unionId = data.unionid ?? null;
    } else {
      // Sandbox mock mode is strictly rejected in production by loadConfig().
      openId = `mock_openid_${trimmedCode}`;
    }

    const user = await this.prisma.user.upsert({
      where: { openId },
      update: unionId ? { unionId } : {},
      create: { openId, unionId },
      select: { id: true }
    });

    const token = this.signToken(user.id, 'USER');
    return { token, userId: user.id };
  }

  /**
   * Authenticate an admin user strictly validating username/password and returning only token and adminId.
   */
  public async adminLogin(username: string, password: string): Promise<{ token: string; adminId: number }> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { username: username.trim() },
      select: { id: true, passwordHash: true, isActive: true }
    });

    if (!admin) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
    }
    if (!admin.isActive) {
      throw new AppError(403, 'ACCOUNT_DISABLED', '该管理员账号已被禁用');
    }

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
    }

    const token = this.signToken(admin.id, 'ADMIN');
    return { token, adminId: admin.id };
  }

  /**
   * Fastify preHandler middleware requiring a valid Mini Program buyer token.
   */
  public requireUserAuth = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = extractBearerToken(request.headers.authorization);
    const userId = this.verifyToken(token, 'USER');
    const exists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true }
    });
    if (!exists) {
      throw new AppError(401, 'USER_NOT_FOUND', '用户不存在或已注销');
    }
    request.authUserId = exists.id;
  };

  /**
   * Fastify preHandler middleware requiring a valid Admin token and verifying the Role Permission Matrix.
   */
  public requireAdminPermission = (requiredPermission?: AdminPermission) => {
    return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const token = extractBearerToken(request.headers.authorization);
      const adminId = this.verifyToken(token, 'ADMIN');

      const admin = await this.prisma.adminUser.findUnique({
        where: { id: adminId },
        select: {
          id: true,
          username: true,
          displayName: true,
          permissions: true,
          isActive: true
        }
      });

      if (!admin) {
        throw new AppError(401, 'ADMIN_NOT_FOUND', '管理员账号不存在');
      }
      if (!admin.isActive) {
        throw new AppError(403, 'ACCOUNT_DISABLED', '该管理员账号已被禁用');
      }

      const permissions = parseStringArrayJson(admin.permissions, `AdminUser(${admin.id}).permissions`);

      if (requiredPermission && !permissions.includes(requiredPermission)) {
        throw new AppError(403, 'FORBIDDEN', `缺少权限: ${requiredPermission}`);
      }

      request.authAdmin = {
        id: admin.id,
        username: admin.username,
        displayName: admin.displayName,
        permissions
      };
    };
  };
}

function extractBearerToken(headerValue: string | undefined): string {
  if (!headerValue) {
    throw new AppError(401, 'UNAUTHORIZED', '请先登录');
  }
  const [scheme, token] = headerValue.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authorization 格式无效');
  }
  return token;
}
