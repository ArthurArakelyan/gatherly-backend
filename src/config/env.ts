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
  SSE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(5_000).max(60_000).default(15_000),
  SSE_RETRY_MS: z.coerce.number().int().min(500).max(30_000).default(3_000),
  SSE_REPLAY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  SSE_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().min(1).max(10).default(3),
  SSE_MAX_CONNECTION_DURATION_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(600_000),
  WS_TICKET_TTL_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  WS_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1_024).max(65_536).default(16_384),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(5_000).max(60_000).default(30_000),
  WS_PRESENCE_LEASE_MS: z.coerce.number().int().min(15_000).max(300_000).default(90_000),
  WS_MAX_CONNECTION_DURATION_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(600_000),
  WS_MAX_BUFFERED_BYTES: z.coerce.number().int().min(16_384).max(4_194_304).default(262_144),
  WS_COMMAND_LIMIT: z.coerce.number().int().min(1).max(1_000).default(30),
  WS_COMMAND_WINDOW_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  WS_TYPING_TTL_MS: z.coerce.number().int().min(1_000).max(15_000).default(5_000),
});

export type Environment = z.infer<typeof environmentSchema>;

export const parseEnvironment = (input: NodeJS.ProcessEnv): Environment =>
  environmentSchema.parse(input);

export const environment: Environment = parseEnvironment(process.env);
