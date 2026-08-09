import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  PGDATABASE: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  PGPOOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  DATABASE_URL: z.url(),
  PRISMA_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  CORS_ORIGIN: z.url().default('http://localhost:5173'),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default('gatherly-api'),
  JWT_AUDIENCE: z.string().min(1).default('gatherly-client'),
  JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  REDIS_URL: z.url().refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol), {
    message: 'REDIS_URL must use redis:// or rediss://',
  }),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(1_000),
  EVENT_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
});

export type Environment = z.infer<typeof environmentSchema>;

export const parseEnvironment = (input: NodeJS.ProcessEnv): Environment =>
  environmentSchema.parse(input);

export const environment: Environment = parseEnvironment(process.env);
