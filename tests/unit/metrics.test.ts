import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  createApplicationMetrics,
  createHttpMetricsMiddleware,
  createMetricsHandler,
} from '../../src/infrastructure/observability/metrics.js';

describe('application metrics', () => {
  it('uses a route template instead of resource IDs and does not count scrapes', async () => {
    const metrics = createApplicationMetrics();
    const app = express();
    app.use(createHttpMetricsMiddleware(metrics));
    app.get('/events/:eventId', (_request, response) => response.sendStatus(204));
    app.get('/metrics', createMetricsHandler(metrics));

    const firstEventId = '772a6b84-1ad6-49b9-9077-f90eb19d5f4c';
    const secondEventId = 'bba66100-891e-4164-bf95-18dc73a91dc8';
    await request(app).get(`/events/${firstEventId}`).expect(204);
    await request(app).get(`/events/${secondEventId}`).expect(204);

    const firstScrape = await request(app).get('/metrics').expect(200);
    const secondScrape = await request(app).get('/metrics').expect(200);

    expect(firstScrape.text).toContain('route="/events/:eventId"');
    expect(firstScrape.text).toContain('status_class="2xx"');
    expect(firstScrape.text).toContain('gatherly_http_requests_total');
    expect(firstScrape.text).not.toContain(firstEventId);
    expect(firstScrape.text).not.toContain(secondEventId);
    expect(secondScrape.text).not.toContain('route="/metrics"');
  });

  it('labels unmatched requests with one bounded value', async () => {
    const metrics = createApplicationMetrics();
    const app = express();
    app.use(createHttpMetricsMiddleware(metrics));
    app.use((_request, response) => response.sendStatus(404));

    await request(app).get('/unknown/one').expect(404);
    await request(app).get('/unknown/two').expect(404);

    const body = await metrics.registry.metrics();
    expect(body).toContain('route="unmatched"');
    expect(body).toContain('status_class="4xx"');
    expect(body).not.toContain('/unknown/one');
    expect(body).not.toContain('/unknown/two');
  });
});
