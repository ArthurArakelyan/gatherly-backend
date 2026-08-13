import type { Express } from 'express';
import pino from 'pino';
import type { Pool } from 'pg';

import { createApp } from '../../src/app.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { CommunitiesController } from '../../src/modules/communities/communities.controller.js';
import { CommunitiesRepository } from '../../src/modules/communities/communities.repository.js';
import { createCommunitiesRouter } from '../../src/modules/communities/communities.routes.js';
import { CommunitiesService } from '../../src/modules/communities/communities.service.js';
import { EventsController } from '../../src/modules/events/events.controller.js';
import type { EventCache } from '../../src/modules/events/events.cache.js';
import { EventsRepository } from '../../src/modules/events/events.repository.js';
import { createEventsRouter } from '../../src/modules/events/events.routes.js';
import { EventsService } from '../../src/modules/events/events.service.js';
import { MembershipsController } from '../../src/modules/memberships/memberships.controller.js';
import { MembershipsRepository } from '../../src/modules/memberships/memberships.repository.js';
import { createMembershipsRouter } from '../../src/modules/memberships/memberships.routes.js';
import { MembershipsService } from '../../src/modules/memberships/memberships.service.js';
import { ReservationsController } from '../../src/modules/reservations/reservations.controller.js';
import { ReservationsRepository } from '../../src/modules/reservations/reservations.repository.js';
import { createReservationsRouter } from '../../src/modules/reservations/reservations.routes.js';
import { ReservationsService } from '../../src/modules/reservations/reservations.service.js';
import { RealtimeController } from '../../src/modules/realtime/realtime.controller.js';
import { createRealtimeRouter } from '../../src/modules/realtime/realtime.routes.js';
import type { RealtimeService } from '../../src/modules/realtime/realtime.service.js';
import type { RealtimeWakeupPublisher } from '../../src/modules/realtime/realtime.types.js';
import { ChatController } from '../../src/modules/chat/chat.controller.js';
import { ChatRepository } from '../../src/modules/chat/chat.repository.js';
import { createChatRouter } from '../../src/modules/chat/chat.routes.js';
import { ChatService } from '../../src/modules/chat/chat.service.js';
import type { WebSocketTicketStore } from '../../src/infrastructure/redis/websocket-ticket-store.js';
import { Argon2PasswordHasher } from '../../src/infrastructure/security/argon2-password-hasher.js';
import { JwtAccessTokens } from '../../src/infrastructure/security/jwt-access-tokens.js';
import { IdentityController } from '../../src/modules/identity/identity.controller.js';
import {
  signInRateLimitPolicy,
  signUpRateLimitPolicy,
} from '../../src/modules/identity/identity.rate-limits.js';
import { IdentityRepository } from '../../src/modules/identity/identity.repository.js';
import { createIdentityRouter } from '../../src/modules/identity/identity.routes.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';
import type { IdentityRateLimiters } from '../../src/modules/identity/identity.types.js';
import { SearchController } from '../../src/modules/search/search.controller.js';
import { createSearchRouter } from '../../src/modules/search/search.routes.js';
import type { SearchService } from '../../src/modules/search/search.service.js';
import { createRequireAuthenticatedUser } from '../../src/shared/auth/authentication.middleware.js';
import { createLocalRateLimit } from '../../src/shared/rate-limit/rate-limit.middleware.js';

interface TestDatabase {
  pool: Pool;
  prisma: PrismaClient;
}

interface TestAppDependencies {
  chatTicketStore?: WebSocketTicketStore;
  eventCache?: EventCache;
  identityRateLimiters?: IdentityRateLimiters;
  realtimeService?: RealtimeService;
  realtimeWakeupPublisher?: RealtimeWakeupPublisher;
  searchService?: SearchService;
}

const testAccessTokens = new JwtAccessTokens({
  secret: 'test-only-jwt-secret-that-is-long-enough',
  issuer: 'gatherly-test-api',
  audience: 'gatherly-test-client',
  ttlSeconds: 900,
});

export const authorizationFor = (userId: string): string =>
  `Bearer ${testAccessTokens.sign(userId)}`;

export const createTestApp = (
  { pool, prisma }: TestDatabase,
  dependencies: TestAppDependencies = {},
): Express => {
  const identityService = new IdentityService(
    new IdentityRepository(prisma),
    new Argon2PasswordHasher(),
    testAccessTokens,
    900,
  );
  const requireAuthenticatedUser = createRequireAuthenticatedUser(identityService);
  const identityRateLimiters = dependencies.identityRateLimiters ?? {
    signIn: createLocalRateLimit(signInRateLimitPolicy),
    signUp: createLocalRateLimit(signUpRateLimitPolicy),
  };
  const identityRouter = createIdentityRouter(
    new IdentityController(identityService),
    requireAuthenticatedUser,
    identityRateLimiters,
  );
  const communitiesRouter = createCommunitiesRouter(
    new CommunitiesController(new CommunitiesService(new CommunitiesRepository(prisma))),
    requireAuthenticatedUser,
  );
  const membershipsRouter = createMembershipsRouter(
    new MembershipsController(new MembershipsService(new MembershipsRepository(prisma))),
    requireAuthenticatedUser,
  );
  const eventsRouter = createEventsRouter(
    new EventsController(new EventsService(new EventsRepository(prisma), dependencies.eventCache)),
    requireAuthenticatedUser,
  );
  const reservationsRouter = createReservationsRouter(
    new ReservationsController(
      new ReservationsService(
        new ReservationsRepository(pool),
        dependencies.realtimeWakeupPublisher,
      ),
    ),
    requireAuthenticatedUser,
  );
  const realtimeRouter =
    dependencies.realtimeService === undefined
      ? undefined
      : createRealtimeRouter(
          new RealtimeController(dependencies.realtimeService),
          requireAuthenticatedUser,
        );
  const chatRouter =
    dependencies.chatTicketStore === undefined
      ? undefined
      : createChatRouter(
          new ChatController(
            new ChatService(new ChatRepository(pool)),
            dependencies.chatTicketStore,
          ),
          requireAuthenticatedUser,
        );
  const searchRouter =
    dependencies.searchService === undefined
      ? undefined
      : createSearchRouter(new SearchController(dependencies.searchService));

  return createApp({
    corsOrigin: 'http://localhost:5173',
    enableHttpLogging: false,
    logger: pino({ enabled: false }),
    checkReadiness: () => Promise.resolve(true),
    isShuttingDown: () => false,
    communitiesRouter,
    membershipsRouter,
    eventsRouter,
    reservationsRouter,
    identityRouter,
    ...(realtimeRouter === undefined ? {} : { realtimeRouter }),
    ...(chatRouter === undefined ? {} : { chatRouter }),
    ...(searchRouter === undefined ? {} : { searchRouter }),
  });
};
