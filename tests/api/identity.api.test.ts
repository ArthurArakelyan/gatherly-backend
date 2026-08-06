import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aliceId } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { authorizationFor, createTestApp } from '../helpers/test-app.js';

const developmentPassword = 'GatherlyTest123';

describe('identity API', () => {
  let harness: PostgresHarness;
  let app: Express;

  beforeAll(async () => {
    harness = await startPostgresHarness();
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
    app = createTestApp(harness);
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('signs up a normalized user, stores only a hash, and returns a usable token', async () => {
    const signedUp = await request(app)
      .post('/auth/sign-up')
      .send({ username: '  New_User  ', password: developmentPassword });

    expect(signedUp.status).toBe(201);
    expect(signedUp.body).toMatchObject({
      data: {
        user: { username: 'new_user', status: 'ACTIVE', platformRole: 'USER' },
        tokenType: 'Bearer',
        expiresIn: 900,
      },
    });
    expect((signedUp.body as { data: { accessToken: string } }).data.accessToken).toEqual(
      expect.any(String),
    );

    const stored = await harness.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE username = $1',
      ['new_user'],
    );
    expect(stored.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.rows[0]?.password_hash).not.toContain(developmentPassword);

    const me = await request(app)
      .get('/auth/me')
      .set(
        'authorization',
        `Bearer ${(signedUp.body as { data: { accessToken: string } }).data.accessToken}`,
      );
    expect(me.status).toBe(200);
    expect((me.body as { data: { user: { username: string } } }).data.user.username).toBe(
      'new_user',
    );
  });

  it('validates credentials and rejects duplicate usernames', async () => {
    const invalid = await request(app)
      .post('/auth/sign-up')
      .send({ username: 'x', password: 'short' });
    expect(invalid.status).toBe(400);
    expect((invalid.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const duplicate = await request(app)
      .post('/auth/sign-up')
      .send({ username: 'ALICE', password: developmentPassword });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { error: { code: string } }).error.code).toBe('USERNAME_TAKEN');
  });

  it('signs in without exposing whether the username or password was wrong', async () => {
    const signedIn = await request(app)
      .post('/auth/sign-in')
      .send({ username: 'ALICE', password: developmentPassword });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toMatchObject({
      data: { user: { id: aliceId, username: 'alice' }, tokenType: 'Bearer', expiresIn: 900 },
    });

    const login = await harness.pool.query<{ last_login_at: Date | null }>(
      'SELECT last_login_at FROM users WHERE id = $1',
      [aliceId],
    );
    expect(login.rows[0]?.last_login_at).toBeInstanceOf(Date);

    for (const credentials of [
      { username: 'alice', password: 'WrongPassword123' },
      { username: 'missing', password: developmentPassword },
    ]) {
      const rejected = await request(app).post('/auth/sign-in').send(credentials);
      expect(rejected.status).toBe(401);
      expect((rejected.body as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('requires a well-formed valid Bearer token and rechecks current account status', async () => {
    for (const authorization of [undefined, 'Basic credentials', 'Bearer invalid-token']) {
      const call = request(app).get('/auth/me');
      if (authorization !== undefined) call.set('authorization', authorization);
      const response = await call;
      expect(response.status).toBe(401);
      expect((response.body as { error: { code: string } }).error.code).toBe(
        'AUTHENTICATION_REQUIRED',
      );
    }

    await harness.pool.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [aliceId]);
    const suspended = await request(app)
      .get('/auth/me')
      .set('authorization', authorizationFor(aliceId));
    expect(suspended.status).toBe(401);
    expect((suspended.body as { error: { code: string } }).error.code).toBe(
      'AUTHENTICATION_REQUIRED',
    );
  });

  it('rate limits repeated sign-up attempts independently from sign-in', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(app)
        .post('/auth/sign-up')
        .send({ username: `rate_user_${String(attempt)}`, password: developmentPassword });
      expect(response.status).toBe(201);
    }

    const limited = await request(app)
      .post('/auth/sign-up')
      .send({ username: 'rate_user_5', password: developmentPassword });
    expect(limited.status).toBe(429);
    expect((limited.body as { error: { code: string } }).error.code).toBe('SIGN_UP_RATE_LIMITED');

    const signInStillAvailable = await request(app)
      .post('/auth/sign-in')
      .send({ username: 'alice', password: developmentPassword });
    expect(signInStillAvailable.status).toBe(200);
  });

  it('rate limits repeated sign-in failures', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(app)
        .post('/auth/sign-in')
        .send({ username: 'missing', password: developmentPassword });
      expect(response.status).toBe(401);
      expect((response.body as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
    }

    const limited = await request(app)
      .post('/auth/sign-in')
      .send({ username: 'missing', password: developmentPassword });
    expect(limited.status).toBe(429);
    expect((limited.body as { error: { code: string } }).error.code).toBe('SIGN_IN_RATE_LIMITED');
  });
});
