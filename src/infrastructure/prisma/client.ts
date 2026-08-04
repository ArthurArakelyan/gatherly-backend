import { PrismaPg } from '@prisma/adapter-pg';

import type { Environment } from '../../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';

type PrismaEnvironment = Pick<Environment, 'DATABASE_URL' | 'PRISMA_POOL_MAX'>;

export const createPrismaClient = (environment: PrismaEnvironment): PrismaClient => {
  const adapter = new PrismaPg({
    connectionString: environment.DATABASE_URL,
    max: environment.PRISMA_POOL_MAX,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  return new PrismaClient({ adapter });
};
