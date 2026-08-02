import 'dotenv/config';

import { createServer } from 'node:http';

import pino from 'pino';

import { createApp } from './app.js';
import { environment } from './config/env.js';
import { createPool } from './infrastructure/postgres/pool.js';
import { CommunitiesController } from './modules/communities/communities.controller.js';
import { CommunitiesRepository } from './modules/communities/communities.repository.js';
import { createCommunitiesRouter } from './modules/communities/communities.routes.js';
import { CommunitiesService } from './modules/communities/communities.service.js';
import { MembershipsRepository } from './modules/memberships/memberships.repository.js';
import { MembershipsService } from './modules/memberships/memberships.service.js';
import { MembershipsController } from './modules/memberships/memberships.controller.js';
import { createMembershipsRouter } from './modules/memberships/memberships.routes.js';
import { EventsRepository } from './modules/events/events.repository.js';
import { EventsService } from './modules/events/events.service.js';
import { EventsController } from './modules/events/events.controller.js';
import { createEventsRouter } from './modules/events/events.routes.js';
import { ReservationsRepository } from './modules/reservations/reservations.repository.js';
import { ReservationsService } from './modules/reservations/reservations.service.js';
import { ReservationsController } from './modules/reservations/reservations.controller.js';
import { createReservationsRouter } from './modules/reservations/reservations.routes.js';

const logger = pino(
  environment.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {},
);

const pool = createPool(environment);

const communitiesRepository = new CommunitiesRepository(pool);
const communitiesService = new CommunitiesService(communitiesRepository);
const communitiesController = new CommunitiesController(communitiesService);
const communitiesRouter = createCommunitiesRouter(communitiesController);

const membershipsRepository = new MembershipsRepository(pool);
const membershipsService = new MembershipsService(membershipsRepository);
const membershipsController = new MembershipsController(membershipsService);
const membershipsRouter = createMembershipsRouter(membershipsController);

const eventsRepository = new EventsRepository(pool);
const eventsService = new EventsService(eventsRepository);
const eventsController = new EventsController(eventsService);
const eventsRouter = createEventsRouter(eventsController);

const reservationsRepository = new ReservationsRepository(pool);
const reservationsService = new ReservationsService(reservationsRepository);
const reservationsController = new ReservationsController(reservationsService);
const reservationsRouter = createReservationsRouter(reservationsController);

const app = createApp({
  corsOrigin: environment.CORS_ORIGIN,
  enableHttpLogging: environment.NODE_ENV === 'development',
  logger,
  communitiesRouter,
  membershipsRouter,
  eventsRouter,
  reservationsRouter,
});

const server = createServer(app);

server.listen(environment.PORT, () => {
  logger.info({ port: environment.PORT }, 'Gatherly HTTP server started');
});

let isShuttingDown = false;

const shutDown = (signal: NodeJS.Signals): void => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Graceful shutdown started');

  const forcedShutdown = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    process.exitCode = 1;
    server.closeAllConnections();
  }, 10_000);
  forcedShutdown.unref();

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'HTTP server failed to close cleanly');
      process.exitCode = 1;
    }

    void pool
      .end()
      .then(() => {
        logger.info('HTTP server and PostgreSQL pool closed');
      })
      .catch((poolError: unknown) => {
        logger.error({ err: poolError }, 'PostgreSQL pool failed to close');
        process.exitCode = 1;
      })
      .finally(() => {
        clearTimeout(forcedShutdown);
      });
  });
};

process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
