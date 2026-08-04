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

interface TestDatabase {
  pool: Pool;
  prisma: PrismaClient;
}

export const createTestApp = ({ pool, prisma }: TestDatabase): Express => {
  const communitiesRouter = createCommunitiesRouter(
    new CommunitiesController(new CommunitiesService(new CommunitiesRepository(prisma))),
  );
  const membershipsRouter = createMembershipsRouter(
    new MembershipsController(new MembershipsService(new MembershipsRepository(prisma))),
  );
  const eventsRouter = createEventsRouter(
    new EventsController(new EventsService(new EventsRepository(prisma))),
  );
  const reservationsRouter = createReservationsRouter(
    new ReservationsController(new ReservationsService(new ReservationsRepository(pool))),
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
  });
};
