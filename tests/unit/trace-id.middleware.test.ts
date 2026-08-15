import { trace, TraceFlags, type Span } from '@opentelemetry/api';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { traceIdMiddleware } from '../../src/shared/logging/trace-id.middleware.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('traceIdMiddleware', () => {
  it('exposes the active valid trace ID', () => {
    const traceId = 'a'.repeat(32);
    vi.spyOn(trace, 'getSpan').mockReturnValue({
      spanContext: () => ({
        traceId,
        spanId: 'b'.repeat(16),
        traceFlags: TraceFlags.SAMPLED,
      }),
    } as unknown as Span);
    const setHeader = vi.fn();
    const response = {
      locals: {},
      setHeader,
    } as unknown as Response;
    const next = vi.fn();

    traceIdMiddleware({} as Request, response, next);

    expect(response.locals['traceId']).toBe(traceId);
    expect(setHeader).toHaveBeenCalledWith('x-trace-id', traceId);
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not emit a header when tracing has no active span', () => {
    vi.spyOn(trace, 'getSpan').mockReturnValue(undefined);
    const setHeader = vi.fn();
    const response = {
      locals: {},
      setHeader,
    } as unknown as Response;
    const next = vi.fn();

    traceIdMiddleware({} as Request, response, next);

    expect(response.locals).not.toHaveProperty('traceId');
    expect(setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
