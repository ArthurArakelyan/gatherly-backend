import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client.js';

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
      update: { status: 'ACTIVE' },
      create: { ...user, status: 'ACTIVE' },
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
