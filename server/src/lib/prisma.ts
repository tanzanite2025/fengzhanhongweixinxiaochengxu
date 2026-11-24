import { PrismaClient } from '@prisma/client';

/**
 * Create or reuse a configured PrismaClient instance.
 */
export function createPrismaClient(databaseUrl?: string): PrismaClient {
  if (databaseUrl) {
    return new PrismaClient({
      datasources: {
        db: { url: databaseUrl }
      }
    });
  }
  return new PrismaClient();
}

/**
 * Enable SQLite WAL mode and busy timeout to prevent SQLITE_BUSY under concurrent payments/expiry scans.
 */
export async function configureSqliteConcurrency(
  prisma: PrismaClient,
  databaseUrl: string
): Promise<void> {
  if (!databaseUrl.startsWith('file:')) {
    return;
  }
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
}
