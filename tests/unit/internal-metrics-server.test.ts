import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { startInternalMetricsServer } from '../../src/infrastructure/observability/internal-metrics-server.js';
import { createApplicationMetrics } from '../../src/infrastructure/observability/metrics.js';

const openServers: ReturnType<typeof startInternalMetricsServer>[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise, reject) => {
          server.close((error) => {
            if (error === undefined) resolvePromise();
            else reject(error);
          });
        }),
    ),
  );
});

describe('internal metrics server', () => {
  it('serves metrics only on the metrics path', async () => {
    const metrics = createApplicationMetrics();
    metrics.projectionResults.inc({ operation: 'consume', result: 'indexed' });
    const server = startInternalMetricsServer(metrics, 0, pino({ enabled: false }));
    openServers.push(server);
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const metricsResponse = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    const missingResponse = await fetch(`http://127.0.0.1:${String(port)}/health/live`);

    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers.get('content-type')).toContain('text/plain');
    expect(await metricsResponse.text()).toContain('gatherly_search_projection_total');
    expect(missingResponse.status).toBe(404);
  });
});
