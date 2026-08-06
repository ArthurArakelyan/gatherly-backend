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
import { Argon2PasswordHasher } from '../../src/infrastructure/security/argon2-password-hasher.js';
import { JwtAccessTokens } from '../../src/infrastructure/security/jwt-access-tokens.js';
import { IdentityController } from '../../src/modules/identity/identity.controller.js';
import { IdentityRepository } from '../../src/modules/identity/identity.repository.js';
import { createIdentityRouter } from '../../src/modules/identity/identity.routes.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';
import { createRequireAuthenticatedUser } from '../../src/shared/auth/authentication.middleware.js';

interface TestDatabase {
  pool: Pool;
  prisma: PrismaClient;
}

const testAccessTokens = new JwtAccessTokens({
  secret: 'test-only-jwt-secret-that-is-long-enough',
  issuer: 'gatherly-test-api',
  audience: 'gatherly-test-client',
  ttlSeconds: 900,
});

export const authorizationFor = (userId: string): string =>
  `Bearer ${testAccessTokens.sign(userId)}`;

export const createTestApp = ({ pool, prisma }: TestDatabase): Express => {
  const identityService = new IdentityService(
    new IdentityRepository(prisma),
    new Argon2PasswordHasher(),
    testAccessTokens,
    900,
  );
  const requireAuthenticatedUser = createRequireAuthenticatedUser(identityService);
  const identityRouter = createIdentityRouter(
    new IdentityController(identityService),
    requireAuthenticatedUser,
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
    new EventsController(new EventsService(new EventsRepository(prisma))),
    requireAuthenticatedUser,
  );
  const reservationsRouter = createReservationsRouter(
    new ReservationsController(new ReservationsService(new ReservationsRepository(pool))),
    requireAuthenticatedUser,
  );

  return createApp({
    corsOrigin: 'http://localhost:5173',
    enableHttpLogging: false,
    logger: pino({ enabled: false }),
    checkReadiness: () => Promise.resolve(true),
    communitiesRouter,
    membershipsRouter,
    eventsRouter,
    reservationsRouter,
    identityRouter,
  });
};
