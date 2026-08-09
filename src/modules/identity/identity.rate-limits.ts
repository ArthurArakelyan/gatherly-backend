import type { RateLimitPolicy } from '../../shared/rate-limit/rate-limit.middleware.js';

export const signInRateLimitPolicy: RateLimitPolicy = {
  scope: 'sign-in',
  windowMs: 15 * 60 * 1_000,
  limit: 10,
  errorCode: 'SIGN_IN_RATE_LIMITED',
  errorMessage: 'Try signing in again later',
};

export const signUpRateLimitPolicy: RateLimitPolicy = {
  scope: 'sign-up',
  windowMs: 60 * 60 * 1_000,
  limit: 5,
  errorCode: 'SIGN_UP_RATE_LIMITED',
  errorMessage: 'Try creating an account again later',
};
