import { context, trace } from '@opentelemetry/api';
import type { RequestHandler } from 'express';
import morgan from 'morgan';
import pino, { type DestinationStream, type Logger } from 'pino';

import { getRequestContext } from './request-context.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  'request.headers.authorization',
  'request.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.ticket',
  '*.invitationCode',
];

export const createLogger = (
  input: NodeJS.ProcessEnv = process.env,
  destination?: DestinationStream,
): Logger => {
  const options: pino.LoggerOptions = {
    level: input['LOG_LEVEL'] ?? (input['NODE_ENV'] === 'production' ? 'info' : 'debug'),
    base: {
      service: input['OTEL_SERVICE_NAME'] ?? 'gatherly-api',
      environment: input['DEPLOYMENT_ENVIRONMENT'] ?? input['NODE_ENV'] ?? 'development',
      version: input['APP_REVISION'] ?? 'development',
      slot: input['DEPLOYMENT_SLOT'] ?? 'local',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    mixin: () => {
      const requestContext = getRequestContext();
      const spanContext = trace.getSpan(context.active())?.spanContext();

      return {
        ...(requestContext === undefined ? {} : { requestId: requestContext.requestId }),
        ...(spanContext === undefined
          ? {}
          : { traceId: spanContext.traceId, spanId: spanContext.spanId }),
      };
    },
    ...(input['NODE_ENV'] === 'development' && destination === undefined
      ? { transport: { target: 'pino-pretty' } }
      : {}),
  };

  return destination === undefined ? pino(options) : pino(options, destination);
};

morgan.token('request-id', (_request, response) => {
  const value = response.getHeader('x-request-id');
  return typeof value === 'string' ? value : '-';
});

morgan.token('trace-id', (_request, response) => {
  const value = response.getHeader('x-trace-id');
  return typeof value === 'string' ? value : '-';
});

export const createDevelopmentHttpLogger = (): RequestHandler =>
  morgan(':method :url :status :response-time ms request=:request-id trace=:trace-id');
