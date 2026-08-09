import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import { AppError } from '../errors/app-error.js';
import type { FixedWindowRateLimiter } from './fixed-window-rate-limiter.js';

export interface RateLimitPolicy {
  scope: string;
  windowMs: number;
  limit: number;
  errorCode: string;
  errorMessage: string;
}

const getRateLimitSubject = (request: Request): string =>
  request.ip === undefined ? 'unknown-client' : ipKeyGenerator(request.ip);

export const createLocalRateLimit = (policy: RateLimitPolicy): RequestHandler =>
  rateLimit({
    windowMs: policy.windowMs,
    limit: policy.limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getRateLimitSubject,
    handler: (_request, _response, next) => {
      next(new AppError(429, policy.errorCode, policy.errorMessage));
    },
  });

export const createDistributedRateLimit = (
  limiter: FixedWindowRateLimiter,
  policy: RateLimitPolicy,
): RequestHandler => {
  const localFallback = createLocalRateLimit(policy);

  return async (request, response, next) => {
    const result = await limiter.consume(
      policy.scope,
      getRateLimitSubject(request),
      policy.limit,
      Math.ceil(policy.windowMs / 1_000),
    );

    if (result === null) {
      localFallback(request, response, next);
      return;
    }

    response.setHeader('RateLimit-Limit', result.limit.toString());
    response.setHeader('RateLimit-Remaining', result.remaining.toString());
    response.setHeader('RateLimit-Reset', result.resetAfterSeconds.toString());

    if (!result.allowed) {
      next(new AppError(429, policy.errorCode, policy.errorMessage));
      return;
    }

    next();
  };
};
