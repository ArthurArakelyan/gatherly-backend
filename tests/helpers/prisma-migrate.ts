import { execa } from 'execa';

export const deployPrismaMigrations = async (databaseUrl: string): Promise<void> => {
  await execa('yarn', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
};
