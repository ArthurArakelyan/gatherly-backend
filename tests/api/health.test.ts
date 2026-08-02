import request from 'supertest';
import pino from 'pino';
import { Router } from 'express';

import { createApp } from '../../src/app.js';

const app = createApp({
  corsOrigin: 'http://localhost:5173',
  enableHttpLogging: false,
  logger: pino({ enabled: false }),
  checkReadiness: () => Promise.resolve(true),
  communitiesRouter: Router(),
  membershipsRouter: Router(),
  eventsRouter: Router(),
  reservationsRouter: Router(),
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
});
