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

const logger = pino(
  environment.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {},
);
const pool = createPool(environment);
pool.on('error', (error) => {
  logger.error({ err: error }, 'Idle PostgreSQL client failed');
});

const communitiesRepository = new CommunitiesRepository(pool);
const communitiesService = new CommunitiesService(communitiesRepository);
const communitiesRouter = createCommunitiesRouter(new CommunitiesController(communitiesService));

const membershipsRepository = new MembershipsRepository(pool);
const membershipsService = new MembershipsService(membershipsRepository);
const membershipsRouter = createMembershipsRouter(new MembershipsController(membershipsService));

const eventsRepository = new EventsRepository(pool);
const eventsService = new EventsService(eventsRepository);
const eventsRouter = createEventsRouter(new EventsController(eventsService));

const reservationsRepository = new ReservationsRepository(pool);
const reservationsService = new ReservationsService(reservationsRepository);
const reservationsRouter = createReservationsRouter(
  new ReservationsController(reservationsService),
);

const checkReadiness = async (): Promise<boolean> => {
  try {
    await pool.query('SELECT 1');
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
  communitiesRouter,
  membershipsRouter,
  eventsRouter,
  reservationsRouter,
});

const server = createServer(app);

server.listen(environment.PORT, () => {
  logger.info({ port: environment.PORT }, 'Gatherly HTTP server started');
});

const closeHttpServer = (): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });

let isShuttingDown = false;

const shutDown = async (signal: NodeJS.Signals): Promise<void> => {
  if (isShuttingDown) return;

  isShuttingDown = true;

  logger.info({ signal }, 'Graceful shutdown started');

  const forcedShutdown = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    server.closeAllConnections();
    process.exitCode = 1;
  }, 10_000);

  forcedShutdown.unref();

  try {
    await closeHttpServer();
    await pool.end();
    logger.info('Graceful shutdown completed');
  } catch (error) {
    logger.error({ err: error }, 'Graceful shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(forcedShutdown);
  }
};

process.once('SIGINT', (signal) => void shutDown(signal));
process.once('SIGTERM', (signal) => void shutDown(signal));
