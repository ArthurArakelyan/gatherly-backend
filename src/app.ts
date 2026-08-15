import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import { createErrorHandler } from './shared/errors/error-handler.js';
import { notFoundHandler } from './shared/errors/not-found-handler.js';
import { createDevelopmentHttpLogger } from './shared/logging/logger.js';
import { requestIdMiddleware } from './shared/logging/request-id.middleware.js';
import { traceIdMiddleware } from './shared/logging/trace-id.middleware.js';
import { createProductionHttpLogger } from './shared/logging/http-logger.middleware.js';
import type { ApplicationMetrics } from './infrastructure/observability/metrics.js';
import type { BuildInfo } from './config/build-info.js';
import {
  createHttpMetricsMiddleware,
  createMetricsHandler,
} from './infrastructure/observability/metrics.js';

export interface AppDependencies {
  corsOrigin: string;
  enableHttpLogging: boolean;
  logger: Logger;
  buildInfo?: BuildInfo;
  checkReadiness: () => Promise<boolean>;
  isShuttingDown: () => boolean;
  communitiesRouter: Router;
  membershipsRouter: Router;
  eventsRouter: Router;
  reservationsRouter: Router;
  identityRouter: Router;
  realtimeRouter?: Router;
  chatRouter?: Router;
  searchRouter?: Router;
  metrics?: ApplicationMetrics;
}

export const createApp = (dependencies: AppDependencies): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(helmet());
  app.use(
    cors({
      origin: dependencies.corsOrigin,
      exposedHeaders: ['x-request-id', 'x-trace-id'],
    }),
  );
  app.use(requestIdMiddleware);
  app.use(traceIdMiddleware);

  if (dependencies.enableHttpLogging) {
    app.use(createDevelopmentHttpLogger());
  } else {
    app.use(createProductionHttpLogger(dependencies.logger));
  }

  if (dependencies.metrics !== undefined) {
    app.use(createHttpMetricsMiddleware(dependencies.metrics));
  }

  app.get('/health/live', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.get('/health/version', (_request, response) => {
    response.status(200).json(
      dependencies.buildInfo ?? {
        environment: 'test',
        revision: 'development',
        slot: 'local',
      },
    );
  });

  app.get('/health/ready', async (_request, response) => {
    if (dependencies.isShuttingDown()) {
      response.status(503).json({ status: 'not_ready' });
      return;
    }

    const ready = await dependencies.checkReadiness();
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  app.use('/auth', dependencies.identityRouter);
  app.use('/api/communities', dependencies.communitiesRouter);
  app.use('/api/communities', dependencies.membershipsRouter);
  app.use('/api', dependencies.eventsRouter);
  app.use('/api', dependencies.reservationsRouter);

  if (dependencies.realtimeRouter !== undefined) {
    app.use('/api', dependencies.realtimeRouter);
  }

  if (dependencies.chatRouter !== undefined) {
    app.use('/api', dependencies.chatRouter);
  }

  if (dependencies.searchRouter !== undefined) {
    app.use('/api', dependencies.searchRouter);
  }

  if (dependencies.metrics !== undefined) {
    app.get('/metrics', createMetricsHandler(dependencies.metrics));
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(dependencies.logger));

  return app;
};
