import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

import { AppError } from './app-error.js';

const isMalformedJson = (error: unknown): boolean =>
  error instanceof SyntaxError &&
  'type' in error &&
  (error as { type?: unknown }).type === 'entity.parse.failed';

export const createErrorHandler =
  (logger: Logger): ErrorRequestHandler =>
  (error, request, response, next) => {
    // Express identifies error middleware by its four-parameter runtime arity.
    void next;

    const requestId =
      typeof response.locals['requestId'] === 'string' ? response.locals['requestId'] : 'unknown';

    const appError = isMalformedJson(error)
      ? new AppError(400, 'MALFORMED_JSON', 'Request body contains invalid JSON')
      : error instanceof AppError
        ? error
        : new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');

    if (appError.status >= 500) {
      logger.error(
        { err: error, requestId, method: request.method, path: request.path },
        'Request failed',
      );
    }

    response.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        requestId,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      },
    });
  };
