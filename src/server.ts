import 'dotenv/config';

import { createServer } from 'node:http';

import pino from 'pino';
import { z } from 'zod';

import { requestListener } from './app.js';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

const environment = environmentSchema.parse(process.env);
const logger = pino(
  environment.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {},
);
const server = createServer(requestListener);

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
    clearTimeout(forcedShutdown);

    if (error) {
      logger.error({ error }, 'HTTP server failed to close cleanly');
      process.exitCode = 1;
      return;
    }

    logger.info('Graceful shutdown completed');
  });
};

process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
