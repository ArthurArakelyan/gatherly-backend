import request from 'supertest';
import pino from 'pino';
import { Router } from 'express';

import { createApp } from '../../src/app.js';

let shuttingDown = false;

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
