# 极简自研实物电商微信小程序 — 部署与上线指南

本文档涵盖 **账号密码与配置位置汇总**、**本地开发联调** 与 **国内 2核4G 云服务器生产上线** 的完整操作步骤。

---

## 零、 账号密码与配置位置汇总

| 项目 | 默认值 / 说明 | 存放或修改位置 |
| :--- | :--- | :--- |
| **商家管理后台地址** | `http://localhost:5173` | 在 `admin/` 执行 `npm run dev` 启动 |
| **后台默认超级管理员** | 账号：`admin` / 密码：`Admin@2026!` | 由 `server/prisma/seed.ts` 初始化；可通过 `SEED_ADMIN_PASSWORD` 环境变量指定新密码，或在后台【权限矩阵】新增管理员账号 |
| **后端 API 服务地址** | `http://localhost:3001` | 在 `server/` 执行 `npm run dev` 启动；端口配置在 `server/.env` |
| **本地数据库文件** | SQLite `server/prisma/dev.db` | 连接串配置在 `server/.env` 的 `DATABASE_URL` |
| **JWT 登录签名密钥** | 本地开发默认值见 `server/.env` | 生产环境务必修改 `server/.env` 中的 `JWT_SECRET`（至少 32 位随机字符） |
| **小程序 AppID** | 填企业小程序 `AppID` | `miniprogram/project.config.json`（第 49 行 `appid`）及 `server/.env`（`WECHAT_APP_ID`） |
| **小程序 AppSecret / 商户号 / V3 密钥与证书** | 企业微信开放平台与商户平台获取 | 统一填写在 `server/.env`（字段说明见 `server/.env.example`，切勿写入 `miniprogram/` 前端代码） |
| **公司名称 / 客服电话 / 接口域名** | 示例企业商贸有限公司 / 400-000-0000 | `miniprogram/utils/config.ts`（`MERCHANT_NAME`、`SERVICE_PHONE`、`API_BASE_URL`） |
| **商城顶部标题与标语** | 甄选好物商城 / 企业直营标语 | `miniprogram/app.json`、`miniprogram/pages/index/index.json`、`miniprogram/pages/mine/mine.wxml` |

---

## 一、 本地快速启动与联调

### 1. 启动后端 (`server/`)
```bash
cd server
npm install
npx prisma generate
npx prisma db push
npm run prisma:seed
npm run dev
```
- 默认监听：`http://localhost:3001`
- 默认管理员账号：`admin`，密码：`Admin@2026!`
- 本地默认开启 `WECHAT_MODE=sandbox_mock`（仅限非生产环境使用，可用于小程序开发者工具端到端走通下单、模拟支付、发货、退款闭环）。

### 2. 启动商家管理后台 (`admin/`)
```bash
cd admin
npm install
npm run dev
```
- 浏览器访问：`http://localhost:5173`（Vite 已自动将 `/api` 与 `/uploads` 代理到 `http://localhost:3001`）。

### 3. 导入微信小程序 (`miniprogram/`)
1. 打开 **微信开发者工具** → 导入项目，目录选择本仓库下的 `miniprogram/`。
2. 本地联调阶段可在开发者工具右上角【详情 → 本地设置】勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」。
3. 若需在真实域名测试，修改 [config.ts](../miniprogram/utils/config.ts) 中的 `API_BASE_URL`、`MERCHANT_NAME` 与 `SERVICE_PHONE`。

---

## 二、 生产环境上线（国内 2核4G 云服务器）

### 1. 准备工作（微信合规前置）
1. **域名与 ICP 备案**：购买国内云服务器（阿里云/腾讯云等）及域名，完成域名 ICP 备案并申请免费 SSL 证书（HTTPS）。
2. **小程序认证与备案**：
   - 在微信公众平台完成企业小程序微信认证（300 元/年）。
   - 在【设置 → 小程序备案】完成工信部小程序 ICP 备案。
   - 在【开发管理 → 开发设置 → 服务器域名】将 `request` 与 `downloadFile` 合法域名配置为你的 HTTPS 域名（如 `https://shop.example.com`）。
3. **微信支付商户号与 V3 密钥**：
   - 在微信支付商户平台开通商户号并绑定当前小程序 `AppID`。
   - 获取并妥善存放于服务器安全目录（如 `/etc/wechat-certs/`）：
     - 商户私钥 `apiclient_key.pem`（`WECHAT_MCH_PRIVATE_KEY_PATH`）
     - 微信支付平台公钥或平台证书（`WECHAT_PLATFORM_PUBLIC_KEY_PATH`）及序列号/公钥 ID（`WECHAT_PLATFORM_CERT_SERIAL_NO`）
     - 32 字节 APIv3 密钥（`WECHAT_API_V3_KEY`）

### 2. 切换生产数据库与环境变量 (`server/.env`)
- 小体量单店可继续使用 SQLite（注意定期备份 `.db` 文件）；如并发较高，建议在 `server/prisma/schema.prisma` 中将 `provider = "sqlite"` 改为 `"postgresql"` 或 `"mysql"` 并执行 `npx prisma db push`。
- 严格设置 `server/.env`（缺失任意必填项或 `NODE_ENV=production` 下误配 `sandbox_mock` 会直接阻断启动）：

```env
NODE_ENV=production
PORT=3001
HOST=127.0.0.1
BASE_URL=https://shop.example.com
DATABASE_URL="postgresql://user:pass@127.0.0.1:5432/wechat_mall"
JWT_SECRET="请替换为至少32位高强度随机字符串"
JWT_EXPIRES_IN="7d"
ORDER_EXPIRE_MINUTES=15
WECHAT_MODE=live

WECHAT_APP_ID=你的小程序AppID
WECHAT_APP_SECRET=你的小程序AppSecret
WECHAT_MCH_ID=你的微信支付商户号
WECHAT_API_V3_KEY=32位APIv3密钥
WECHAT_MCH_CERT_SERIAL_NO=商户API证书序列号
WECHAT_MCH_PRIVATE_KEY_PATH=/etc/wechat-certs/apiclient_key.pem
WECHAT_PLATFORM_CERT_SERIAL_NO=平台公钥ID或平台证书序列号
WECHAT_PLATFORM_PUBLIC_KEY_PATH=/etc/wechat-certs/pub_key.pem
WECHAT_PAY_NOTIFY_URL=https://shop.example.com/api/wechat/pay-notify
WECHAT_REFUND_NOTIFY_URL=https://shop.example.com/api/wechat/refund-notify
```

### 3. 构建与进程守护
```bash
# 构建后端
cd server
npm ci --omit=dev
npx prisma generate
npx prisma db push
npm run build
# 首次上线初始化管理员（请修改默认密码）
SEED_ADMIN_PASSWORD="你的强密码" npm run prisma:seed
pm2 start dist/server.js --name wechat-mall-api

# 构建管理后台静态文件
cd ../admin
npm ci
npm run build
```

### 4. Nginx HTTPS 反向代理示例
```nginx
server {
    listen 443 ssl http2;
    server_name shop.example.com;

    ssl_certificate     /etc/nginx/ssl/shop.example.com.pem;
    ssl_certificate_key /etc/nginx/ssl/shop.example.com.key;

    # 管理后台静态资源（建议仅内网/VPN或指定IP访问，或独立子域名）
    location / {
        root /var/www/wechat-mall/admin/dist;
        try_files $uri $uri/ /index.html;
    }

    # 后端 API 与上传图片
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:3001;
    }
}
```

---

## 三、 上线前必测验收清单

1. 修改默认管理员 `admin` 密码，并按岗位配置最小权限矩阵。
2. 修改 `miniprogram/utils/config.ts` 中的生产域名与企业客服信息，用真机跑通 **0.01 元测试商品下单 → 微信支付回调 → 管理后台发货（确认 `WX_SHIPPING:SYNCED`）→ 买家确认收货 / 申请原路退款**。
3. 登录微信公众平台核对【发货信息管理】是否已正常收到测试订单的物流回传记录。
