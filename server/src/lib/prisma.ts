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
