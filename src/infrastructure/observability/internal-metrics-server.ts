import { createServer, type Server } from 'node:http';

import type { Logger } from 'pino';

import type { ApplicationMetrics } from './metrics.js';

export const startInternalMetricsServer = (
  metrics: ApplicationMetrics,
  port: number,
  logger: Logger,
): Server => {
  const server = createServer((request, response) => {
    if (request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }

    void metrics.registry
      .metrics()
      .then((body) => {
        response.writeHead(200, { 'content-type': metrics.registry.contentType });
        response.end(body);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Could not render worker metrics');
        response.writeHead(500).end();
      });
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Internal metrics server started');
  });
  return server;
};
