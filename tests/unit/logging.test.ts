import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/shared/logging/logger.js';
import { runWithRequestContext } from '../../src/shared/logging/request-context.js';

describe('production logging', () => {
  it('correlates request IDs and redacts credentials', () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write: (line) => {
        lines.push(line);
      },
    };
    const logger = createLogger(
      { NODE_ENV: 'test', OTEL_SERVICE_NAME: 'gatherly-test' },
      destination,
    );

    runWithRequestContext({ requestId: '0f6a5ba4-ff26-47a1-8bf0-a52f03125f64' }, () => {
      logger.info(
        {
          password: 'do-not-log',
          req: { headers: { authorization: 'Bearer secret', cookie: 'sid=secret' } },
        },
        'test record',
      );
    });

    const record = JSON.parse(lines.join('')) as Record<string, unknown>;
    const serialized = JSON.stringify(record);

    expect(record['requestId']).toBe('0f6a5ba4-ff26-47a1-8bf0-a52f03125f64');
    expect(record['service']).toBe('gatherly-test');
    expect(serialized).not.toContain('do-not-log');
    expect(serialized).not.toContain('Bearer secret');
    expect(serialized).not.toContain('sid=secret');
  });

  it('does not invent correlation fields outside a request or trace context', () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write: (line) => {
        lines.push(line);
      },
    };
    const logger = createLogger({ NODE_ENV: 'test' }, destination);

    logger.info('background record');

    const record = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(record).not.toHaveProperty('requestId');
    expect(record).not.toHaveProperty('traceId');
    expect(record).not.toHaveProperty('spanId');
  });
});
