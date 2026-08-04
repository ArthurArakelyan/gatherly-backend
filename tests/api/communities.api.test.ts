import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aliceId } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { createTestApp } from '../helpers/test-app.js';

describe('communities API', () => {
  let harness: PostgresHarness;
  let app: Express;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    app = createTestApp(harness);
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('validates, creates, lists, and retrieves communities', async () => {
    const invalid = await request(app)
      .post('/api/communities')
      .set('x-user-id', aliceId)
      .send({ name: 'x', slug: 'not valid' });
    expect(invalid.status).toBe(400);
    expect((invalid.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const created = await request(app)
      .post('/api/communities')
      .set('x-user-id', aliceId)
      .send({ name: 'Chess Club', slug: 'chess-club' });
    expect(created.status).toBe(201);
    expect(created.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const communityId = (created.body as { data: { id: string } }).data.id;
    const listed = await request(app).get('/api/communities?page=1&limit=10');
    expect(listed.status).toBe(200);
    expect((listed.body as { pagination: { total: number } }).pagination.total).toBe(1);

    const fetched = await request(app).get(`/api/communities/${communityId}`);
    expect(fetched.status).toBe(200);
    expect((fetched.body as { data: { slug: string } }).data.slug).toBe('chess-club');
  });
});
