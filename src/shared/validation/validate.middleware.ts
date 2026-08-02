import type { RequestHandler, Response } from 'express';
import { type ZodType, z } from 'zod';

import { AppError } from '../errors/app-error.js';

const requestBoundarySchema = z.object({
  body: z.unknown(),
  params: z.unknown(),
  query: z.unknown(),
});

export const validate =
  <T>(schema: ZodType<T>): RequestHandler =>
  (request, response, next) => {
    const boundary = requestBoundarySchema.parse({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      body: request.body,
      params: request.params,
      query: request.query,
    });
    const result = schema.safeParse(boundary);

    if (!result.success) {
      next(
        new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      );
      return;
    }

    response.locals['validated'] = result.data;
    next();
  };

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export const getValidated = <T>(response: Response): T => response.locals['validated'] as T;
