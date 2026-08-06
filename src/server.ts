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

const accessTokens = new JwtAccessTokens({
  secret: environment.JWT_SECRET,
  issuer: environment.JWT_ISSUER,
  audience: environment.JWT_AUDIENCE,
  ttlSeconds: environment.JWT_ACCESS_TOKEN_TTL_SECONDS,
});

const identityRepository = new IdentityRepository(prisma);
const identityService = new IdentityService(
  identityRepository,
  new Argon2PasswordHasher(),
  accessTokens,
  environment.JWT_ACCESS_TOKEN_TTL_SECONDS,
);
const requireAuthenticatedUser = createRequireAuthenticatedUser(identityService);
const identityRouter = createIdentityRouter(
  new IdentityController(identityService),
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
const eventsService = new EventsService(eventsRepository);
const eventsRouter = createEventsRouter(
  new EventsController(eventsService),
  requireAuthenticatedUser,
);

const reservationsRepository = new ReservationsRepository(pool);
const reservationsService = new ReservationsService(reservationsRepository);
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
});

const server = createServer(app);

server.listen(environment.PORT, () => {
  logger.info({ port: environment.PORT }, 'Gatherly HTTP server started');
});

const gracefulShutdown = createGracefulShutdown({
  server,
  state: shutdownState,
  logger,
  timeoutMs: 10_000,
  closeDependencies: async () => {
    await Promise.all([prisma.$disconnect(), pool.end()]);
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
