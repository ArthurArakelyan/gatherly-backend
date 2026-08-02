import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import { createErrorHandler } from './shared/errors/error-handler.js';
import { notFoundHandler } from './shared/errors/not-found-handler.js';
import { createDevelopmentHttpLogger } from './shared/logging/logger.js';
import { requestIdMiddleware } from './shared/logging/request-id.middleware.js';

export interface AppDependencies {
  corsOrigin: string;
  enableHttpLogging: boolean;
  logger: Logger;
  checkReadiness: () => Promise<boolean>;
  communitiesRouter: Router;
  membershipsRouter: Router;
  eventsRouter: Router;
  reservationsRouter: Router;
}

export const createApp = (dependencies: AppDependencies): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: dependencies.corsOrigin }));
  app.use(requestIdMiddleware);

  if (dependencies.enableHttpLogging) app.use(createDevelopmentHttpLogger());

  app.use(express.json({ limit: '1mb' }));

  app.get('/health/live', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });
  app.get('/health/ready', async (_request, response) => {
    const ready = await dependencies.checkReadiness();
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  app.use('/api/communities', dependencies.communitiesRouter);
  app.use('/api/communities', dependencies.membershipsRouter);
  app.use('/api', dependencies.eventsRouter);
  app.use('/api', dependencies.reservationsRouter);

  app.use(notFoundHandler);
  app.use(createErrorHandler(dependencies.logger));

  return app;
};
