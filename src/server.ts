import 'dotenv/config';

import { createServer } from 'node:http';

import pino from 'pino';

import { createApp } from './app.js';
import { environment } from './config/env.js';
import { createPool } from './infrastructure/postgres/pool.js';
import { createPrismaClient } from './infrastructure/prisma/client.js';
import { CommunitiesController } from './modules/communities/communities.controller.js';
import { CommunitiesRepository } from './modules/communities/communities.repository.js';
import { createCommunitiesRouter } from './modules/communities/communities.routes.js';
import { CommunitiesService } from './modules/communities/communities.service.js';
import { EventsController } from './modules/events/events.controller.js';
import { EventsRepository } from './modules/events/events.repository.js';
import { createEventsRouter } from './modules/events/events.routes.js';
import { EventsService } from './modules/events/events.service.js';
import { MembershipsController } from './modules/memberships/memberships.controller.js';
import { MembershipsRepository } from './modules/memberships/memberships.repository.js';
import { createMembershipsRouter } from './modules/memberships/memberships.routes.js';
import { MembershipsService } from './modules/memberships/memberships.service.js';
import { ReservationsController } from './modules/reservations/reservations.controller.js';
import { ReservationsRepository } from './modules/reservations/reservations.repository.js';
import { createReservationsRouter } from './modules/reservations/reservations.routes.js';
import { ReservationsService } from './modules/reservations/reservations.service.js';
import { JwtAccessTokens } from './infrastructure/security/jwt-access-tokens.js';
import { IdentityRepository } from './modules/identity/identity.repository.js';
import { IdentityService } from './modules/identity/identity.service.js';
import { Argon2PasswordHasher } from './infrastructure/security/argon2-password-hasher.js';
import { createRequireAuthenticatedUser } from './shared/auth/authentication.middleware.js';
import { createIdentityRouter } from './modules/identity/identity.routes.js';
import { IdentityController } from './modules/identity/identity.controller.js';
import { createGracefulShutdown } from './infrastructure/http/graceful-shutdown.js';
import {
  closeRedisClient,
  createRedisClient,
  startRedisClient,
} from './infrastructure/redis/client.js';
import { RedisCache } from './infrastructure/redis/cache.js';
import { createEventCache } from './modules/events/events.cache.js';
import {
  signInRateLimitPolicy,
  signUpRateLimitPolicy,
} from './modules/identity/identity.rate-limits.js';
import { RedisFixedWindowRateLimiter } from './infrastructure/redis/redis-fixed-window-rate-limiter.js';
import { createDistributedRateLimit } from './shared/rate-limit/rate-limit.middleware.js';
import { RedisRealtimeBus, createRealtimeSubscriber } from './infrastructure/redis/realtime-bus.js';
import { RealtimeController } from './modules/realtime/realtime.controller.js';
import { RealtimeRepository } from './modules/realtime/realtime.repository.js';
import { createRealtimeRouter } from './modules/realtime/realtime.routes.js';
import { RealtimeService } from './modules/realtime/realtime.service.js';
import { ChatWebSocketGateway } from './infrastructure/http/chat-websocket-gateway.js';
import { ChatWebSocketServer } from './infrastructure/http/chat-websocket-server.js';
import { RedisChatBus, createChatSubscriber } from './infrastructure/redis/chat-bus.js';
import { RedisChatPresence } from './infrastructure/redis/chat-presence.js';
import { WebSocketTicketStore } from './infrastructure/redis/websocket-ticket-store.js';
import { ChatController } from './modules/chat/chat.controller.js';
import { ChatRepository } from './modules/chat/chat.repository.js';
import { createChatRouter } from './modules/chat/chat.routes.js';
import { ChatService } from './modules/chat/chat.service.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from './infrastructure/elasticsearch/client.js';
import { SearchController } from './modules/search/search.controller.js';
import { SearchRepository } from './modules/search/search.repository.js';
import { createSearchRouter } from './modules/search/search.routes.js';
import { SearchService } from './modules/search/search.service.js';

const pinoConfig = {
  redact: {
    paths: [
      'req.headers.authorization',
      'request.headers.authorization',
      'headers.authorization',
      'password',
      '*.password',
      '*.passwordHash',
    ],
    censor: '[REDACTED]',
  },
};

const logger = pino(
  environment.NODE_ENV === 'development'
    ? { ...pinoConfig, transport: { target: 'pino-pretty' } }
    : pinoConfig,
);

const pool = createPool(environment);
const prisma = createPrismaClient(environment);

pool.on('error', (error) => {
  logger.error({ err: error }, 'Idle PostgreSQL client failed');
});

const elasticsearch = createElasticsearchClient(environment, logger);
const searchService = new SearchService(new SearchRepository(elasticsearch, logger));
const searchRouter = createSearchRouter(new SearchController(searchService));

const accessTokens = new JwtAccessTokens({
  secret: environment.JWT_SECRET,
  issuer: environment.JWT_ISSUER,
  audience: environment.JWT_AUDIENCE,
  ttlSeconds: environment.JWT_ACCESS_TOKEN_TTL_SECONDS,
});

const redis = createRedisClient(environment, logger);
const redisCache = new RedisCache(redis, logger);
startRedisClient(redis, logger);

const identityRepository = new IdentityRepository(prisma);
const identityService = new IdentityService(
  identityRepository,
  new Argon2PasswordHasher(),
  accessTokens,
  environment.JWT_ACCESS_TOKEN_TTL_SECONDS,
);
const requireAuthenticatedUser = createRequireAuthenticatedUser(identityService);
const fixedWindowRateLimiter = new RedisFixedWindowRateLimiter(redis, logger);
const identityRateLimiters = {
  signIn: createDistributedRateLimit(fixedWindowRateLimiter, signInRateLimitPolicy),
  signUp: createDistributedRateLimit(fixedWindowRateLimiter, signUpRateLimitPolicy),
};
const identityRouter = createIdentityRouter(
  new IdentityController(identityService),
  requireAuthenticatedUser,
  identityRateLimiters,
);

const chatRepository = new ChatRepository(pool);
const chatService = new ChatService(chatRepository);
const webSocketTickets = new WebSocketTicketStore(redis, logger, environment.WS_TICKET_TTL_SECONDS);
const chatRouter = createChatRouter(
  new ChatController(chatService, webSocketTickets),
  requireAuthenticatedUser,
);

const chatSubscriber = createChatSubscriber(redis, logger);
const chatBus = new RedisChatBus(redis, chatSubscriber, logger);
const chatPresence = new RedisChatPresence(redis, logger, environment.WS_PRESENCE_LEASE_MS);
const chatGateway = new ChatWebSocketGateway(chatService, chatBus, chatPresence, logger, {
  heartbeatIntervalMs: environment.WS_HEARTBEAT_INTERVAL_MS,
  maxConnectionDurationMs: environment.WS_MAX_CONNECTION_DURATION_MS,
  maxBufferedBytes: environment.WS_MAX_BUFFERED_BYTES,
  commandLimit: environment.WS_COMMAND_LIMIT,
  commandWindowMs: environment.WS_COMMAND_WINDOW_MS,
  typingTtlMs: environment.WS_TYPING_TTL_MS,
});

chatBus.start(chatGateway);

const realtimeRepository = new RealtimeRepository(pool);
const realtimeService = new RealtimeService(realtimeRepository, logger, {
  heartbeatIntervalMs: environment.SSE_HEARTBEAT_INTERVAL_MS,
  retryMs: environment.SSE_RETRY_MS,
  replayBatchSize: environment.SSE_REPLAY_BATCH_SIZE,
  maxConnectionsPerUser: environment.SSE_MAX_CONNECTIONS_PER_USER,
  maxConnectionDurationMs: environment.SSE_MAX_CONNECTION_DURATION_MS,
});
const realtimeSubscriber = createRealtimeSubscriber(redis, logger);
const realtimeBus = new RedisRealtimeBus(redis, realtimeSubscriber, realtimeService, logger);

realtimeBus.start();

const realtimeRouter = createRealtimeRouter(
  new RealtimeController(realtimeService),
  requireAuthenticatedUser,
);

const communitiesRepository = new CommunitiesRepository(prisma);
const communitiesService = new CommunitiesService(communitiesRepository);
const communitiesRouter = createCommunitiesRouter(
  new CommunitiesController(communitiesService),
  requireAuthenticatedUser,
);

const membershipsRepository = new MembershipsRepository(prisma);
const membershipsService = new MembershipsService(membershipsRepository);
const membershipsRouter = createMembershipsRouter(
  new MembershipsController(membershipsService),
  requireAuthenticatedUser,
);

const eventsRepository = new EventsRepository(prisma);
const eventCache = createEventCache(redisCache, environment.EVENT_CACHE_TTL_SECONDS);
const eventsService = new EventsService(eventsRepository, eventCache);
const eventsRouter = createEventsRouter(
  new EventsController(eventsService),
  requireAuthenticatedUser,
);

const reservationsRepository = new ReservationsRepository(pool);
const reservationsService = new ReservationsService(reservationsRepository, realtimeBus);
const reservationsRouter = createReservationsRouter(
  new ReservationsController(reservationsService),
  requireAuthenticatedUser,
);

const shutdownState = { started: false };

const checkReadiness = async (): Promise<boolean> => {
  if (shutdownState.started) return false;

  try {
    await Promise.all([pool.query('SELECT 1'), prisma.$queryRaw`SELECT 1`]);
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'PostgreSQL readiness check failed');
    return false;
  }
};

const app = createApp({
  corsOrigin: environment.CORS_ORIGIN,
  enableHttpLogging: environment.NODE_ENV === 'development',
  logger,
  checkReadiness,
  isShuttingDown: () => shutdownState.started,
  communitiesRouter,
  membershipsRouter,
  eventsRouter,
  reservationsRouter,
  identityRouter,
  realtimeRouter,
  chatRouter,
  searchRouter,
});

const server = createServer(app);

const chatWebSocketServer = new ChatWebSocketServer(
  server,
  webSocketTickets,
  chatService,
  chatGateway,
  logger,
  {
    allowedOrigin: environment.CORS_ORIGIN,
    maxPayloadBytes: environment.WS_MAX_PAYLOAD_BYTES,
  },
);

chatWebSocketServer.start();

server.listen(environment.PORT, () => {
  logger.info({ port: environment.PORT }, 'Gatherly HTTP server started');
});

const gracefulShutdown = createGracefulShutdown({
  server,
  state: shutdownState,
  logger,
  timeoutMs: 10_000,
  closeLongLivedConnections: async () => {
    realtimeService.shutdown();
    await chatWebSocketServer.shutdown();
  },
  closeDependencies: async () => {
    await Promise.all([
      chatBus.close(),
      realtimeBus.close(),
      closeRedisClient(redis),
      closeElasticsearchClient(elasticsearch),
      prisma.$disconnect(),
      pool.end(),
    ]);
  },
});

const handleSignal = (signal: NodeJS.Signals): void => {
  void gracefulShutdown
    .shutdown(signal)
    .then(({ forced }) => {
      if (forced) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'Graceful shutdown failed');
      process.exitCode = 1;
    });
};

process.once('SIGINT', handleSignal);
process.once('SIGTERM', handleSignal);
