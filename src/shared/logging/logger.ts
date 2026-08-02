import type { RequestHandler } from 'express';
import morgan from 'morgan';

morgan.token('request-id', (_request, response) => {
  const value = response.getHeader('x-request-id');
  return typeof value === 'string' ? value : '-';
});

export const createDevelopmentHttpLogger = (): RequestHandler =>
  morgan(':method :url :status :response-time ms request=:request-id');
