export interface FixedWindowResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterSeconds: number;
}

export interface FixedWindowRateLimiter {
  consume(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<FixedWindowResult | null>;
}
