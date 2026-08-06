import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';

import { PrismaClient } from '../src/generated/prisma/client.js';

const developmentPassword = process.env['DEVELOPMENT_SEED_PASSWORD'];
if (developmentPassword === undefined || developmentPassword.length < 12) {
  throw new Error('DEVELOPMENT_SEED_PASSWORD of at least 12 characters is required');
}

const passwordHash = await argon2.hash(developmentPassword, {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required to seed the database');

const adapter = new PrismaPg({ connectionString: databaseUrl, max: 1 });
const prisma = new PrismaClient({ adapter });

const users = [
  { id: '00000000-0000-4000-8000-000000000001', username: 'alice' },
  { id: '00000000-0000-4000-8000-000000000002', username: 'bob' },
  { id: '00000000-0000-4000-8000-000000000003', username: 'carol' },
] as const;

const seed = async (): Promise<void> => {
  for (const user of users) {
    await prisma.user.upsert({
      where: { username: user.username },
      update: { status: 'ACTIVE', passwordHash },
      create: { ...user, status: 'ACTIVE', passwordHash },
    });
  }
};

seed()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
