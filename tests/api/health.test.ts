import request from 'supertest';
import pino from 'pino';
import { Router } from 'express';

import { createApp } from '../../src/app.js';
import { createApplicationMetrics } from '../../src/infrastructure/observability/metrics.js';

let shuttingDown = false;
const metrics = createApplicationMetrics();

const app = createApp({
  corsOrigin: 'http://localhost:5173',
  enableHttpLogging: false,
  logger: pino({ enabled: false }),
  checkReadiness: () => Promise.resolve(true),
  isShuttingDown: () => shuttingDown,
  communitiesRouter: Router(),
  membershipsRouter: Router(),
  eventsRouter: Router(),
  reservationsRouter: Router(),
  identityRouter: Router(),
  metrics,
});

describe('GET /health/live', () => {
  it('reports that the process is healthy and includes a request ID', async () => {
    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('allows the configured browser origin', async () => {
    const response = await request(app).get('/health/live').set('origin', 'http://localhost:5173');

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-expose-headers']).toBe('x-request-id,x-trace-id');
  });

  it('reports only safe build metadata', async () => {
    const response = await request(app).get('/health/version');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      environment: 'test',
      revision: 'development',
      slot: 'local',
    });
    expect(JSON.stringify(response.body)).not.toContain('DATABASE_URL');
    expect(JSON.stringify(response.body)).not.toContain('JWT_SECRET');
  });

  it('accepts only bounded trusted request IDs from callers', async () => {
    const trustedRequestId = '0f6a5ba4-ff26-47a1-8bf0-a52f03125f64';
    const trusted = await request(app).get('/health/live').set('x-request-id', trustedRequestId);
    const untrusted = await request(app).get('/health/live').set('x-request-id', 'private-data');

    expect(trusted.headers['x-request-id']).toBe(trustedRequestId);
    expect(untrusted.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(untrusted.headers['x-request-id']).not.toBe('private-data');
  });

  it('exposes metrics and records handled route templates', async () => {
    await request(app).get('/health/ready').expect(200);

    const response = await request(app).get('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('route="/health/ready"');
    expect(response.text).not.toContain('route="/metrics"');
  });

  it('stops reporting readiness after shutdown begins without failing liveness', async () => {
    shuttingDown = true;

    try {
      const ready = await request(app).get('/health/ready');
      const live = await request(app).get('/health/live');

      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({ status: 'not_ready' });
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ status: 'ok' });
    } finally {
      shuttingDown = false;
    }
  });
});
