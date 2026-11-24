import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { configureSqliteConcurrency, createPrismaClient } from './lib/prisma.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = createPrismaClient(config.databaseUrl);
  await prisma.$connect();
  await configureSqliteConcurrency(prisma, config.databaseUrl);

  const { app, orderService } = await buildApp({ prisma, config });

  // Scan and expire unpaid orders every 60 seconds with re-entrancy guard
  let expireScanRunning = false;
  const expireTimer = setInterval(() => {
    if (expireScanRunning) {
      return;
    }
    expireScanRunning = true;
    orderService
      .cancelExpiredOrders()
      .catch((err) => {
        app.log.error({ err }, 'Failed to cancel expired orders');
      })
      .finally(() => {
        expireScanRunning = false;
      });
  }, 60_000);
  expireTimer.unref();

  const shutdown = async () => {
    clearInterval(expireTimer);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Server running on http://${config.host}:${config.port} (mode=${config.wechatMode})`);
}

main().catch((err) => {
  console.error('[CRITICAL] Server failed to start:', err);
  process.exit(1);
});
