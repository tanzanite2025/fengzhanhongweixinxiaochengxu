# 极简自研实物电商微信小程序

面向企业主体的轻量级实物商品微信小程序商城，包含三端：
- `server/`：Node.js + TypeScript + Fastify + Prisma 后端服务（含事务锁库防超卖、超时关单、微信支付 V3、微信发货信息管理 `upload_shipping_info`、售后原路退款）
- `miniprogram/`：微信小程序原生 TypeScript 买家端
- `admin/`：React + Vite + TypeScript 商家管理后台
- `docs/DEPLOYMENT.md`：完整账号密码速查、本地启动与云服务器生产上线文档

## 默认账号与本地入口

- **商家管理后台**：`http://localhost:5173`
  - 默认管理员账号：`admin`
  - 默认管理员密码：`Admin@2026!`
- **后端 API 地址**：`http://localhost:3001`
- **微信小程序导入目录**：`miniprogram/`（使用微信开发者工具导入）
- **公司名称与客服电话配置**：`miniprogram/utils/config.ts`
- **企业 AppID / AppSecret / 微信支付商户号与 V3 密钥**：`server/.env`（模板见 `server/.env.example`）

详细部署与上线步骤请参阅 [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)。
