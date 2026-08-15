import { performance } from 'node:perf_hooks';

import type { Request, RequestHandler } from 'express';
import type { Logger } from 'pino';

const routeTemplate = (request: Request): string => {
  const route = request.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string' ? `${request.baseUrl}${route.path}` : 'unmatched';
};

const shouldSkip = (request: Request): boolean =>
  request.path === '/health/live' || request.path === '/metrics';

export const createProductionHttpLogger =
  (logger: Logger): RequestHandler =>
  (request, response, next) => {
    if (shouldSkip(request)) {
      next();
      return;
    }

    const startedAt = performance.now();
    response.once('finish', () => {
      const requestId: unknown = response.locals['requestId'];
      const traceId: unknown = response.locals['traceId'];
      const statusClass = `${String(Math.floor(response.statusCode / 100))}xx`;
      const fields = {
        ...(typeof requestId === 'string' ? { requestId } : {}),
        ...(typeof traceId === 'string' ? { traceId } : {}),
        method: request.method,
        route: routeTemplate(request),
        statusCode: response.statusCode,
        statusClass,
        durationMs: Number((performance.now() - startedAt).toFixed(3)),
      };

      if (response.statusCode >= 500) logger.error(fields, 'HTTP request completed');
      else if (response.statusCode >= 400) logger.warn(fields, 'HTTP request completed');
      else logger.info(fields, 'HTTP request completed');
    });

    next();
  };
