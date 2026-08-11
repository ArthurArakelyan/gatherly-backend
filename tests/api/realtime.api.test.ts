import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JwtAccessTokens } from '../../src/infrastructure/security/jwt-access-tokens.js';
import { RealtimeRepository } from '../../src/modules/realtime/realtime.repository.js';
import { RealtimeService } from '../../src/modules/realtime/realtime.service.js';
import { aliceId } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { authorizationFor, createTestApp } from '../helpers/test-app.js';

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeAllConnections();
  });
};

const readUntil = async (response: Response, marker: string): Promise<string> => {
  if (response.body === null) throw new Error('Expected a streaming response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (!text.includes(marker)) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error(`Timed out waiting for ${marker}`));
          }, 2_000).unref();
        }),
      ]);
      if (result.done) break;
      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array)) throw new Error('SSE reader returned a non-byte chunk');
      text += decoder.decode(chunk, { stream: true });
    }
    return text;
  } finally {
    await reader.cancel();
  }
};

describe('realtime SSE API', () => {
  let harness: PostgresHarness;
  const servers: Server[] = [];
  const services: RealtimeService[] = [];

  beforeAll(async () => {
    harness = await startPostgresHarness();
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterEach(async () => {
    for (const service of services.splice(0)) service.shutdown();
    await Promise.all(servers.splice(0).map(closeServer));
  });

  afterAll(async () => {
    await harness.stop();
  });

  const startSubject = async (): Promise<{ baseUrl: string; service: RealtimeService }> => {
    const service = new RealtimeService(
      new RealtimeRepository(harness.pool),
      pino({ enabled: false }),
      {
        heartbeatIntervalMs: 25,
        retryMs: 3_000,
        replayBatchSize: 2,
        maxConnectionsPerUser: 2,
        maxConnectionDurationMs: 60_000,
      },
    );
    const server = createServer(createTestApp(harness, { realtimeService: service }));
    services.push(service);
    servers.push(server);
    const port = await listen(server);
    return { baseUrl: `http://127.0.0.1:${String(port)}`, service };
  };

  it.each([
    ['absent', undefined],
    ['malformed', 'Bearer not-a-jwt'],
    [
      'forged',
      `Bearer ${new JwtAccessTokens({
        secret: 'different-test-secret-that-is-long-enough',
        issuer: 'gatherly-test-api',
        audience: 'gatherly-test-client',
        ttlSeconds: 900,
      }).sign(aliceId)}`,
    ],
    [
      'expired',
      `Bearer ${new JwtAccessTokens({
        secret: 'test-only-jwt-secret-that-is-long-enough',
        issuer: 'gatherly-test-api',
        audience: 'gatherly-test-client',
        ttlSeconds: -1,
      }).sign(aliceId)}`,
    ],
  ])('rejects an %s access token before opening SSE', async (_description, authorization) => {
    const { baseUrl } = await startSubject();
    const response = await fetch(`${baseUrl}/api/realtime/stream`, {
      headers: authorization === undefined ? {} : { authorization },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
  });

  it.each(['-1', 'not-a-cursor', '9223372036854775808'])(
    'rejects invalid Last-Event-ID %s before opening SSE',
    async (lastEventId) => {
      const { baseUrl } = await startSubject();
      const response = await fetch(`${baseUrl}/api/realtime/stream`, {
        headers: {
          authorization: authorizationFor(aliceId),
          'Last-Event-ID': lastEventId,
        },
      });

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'INVALID_LAST_EVENT_ID' },
      });
    },
  );

  it('streams headers, retry advice, a named event, and heartbeat framing', async () => {
    const inserted = await harness.pool.query<{ id: string }>(
      `INSERT INTO realtime_events (type, audience_user_id, payload)
       VALUES (
         'notification.created',
         $1,
         jsonb_build_object(
           'notification', jsonb_build_object(
             'id', '10000000-0000-4000-8000-000000000001',
             'type', 'RESERVATION_CONFIRMED',
             'title', 'Reservation confirmed',
             'message', 'Reservation confirmed',
             'data', jsonb_build_object('eventId', '20000000-0000-4000-8000-000000000001'),
             'readAt', NULL,
             'createdAt', '2026-08-12T00:00:00.000Z'
           )
         )
       )
       RETURNING id::text`,
      [aliceId],
    );
    const eventId = inserted.rows[0]?.id;
    if (eventId === undefined) throw new Error('Realtime fixture insert returned no row');
    const { baseUrl } = await startSubject();

    const response = await fetch(`${baseUrl}/api/realtime/stream`, {
      headers: {
        accept: 'text/event-stream',
        authorization: authorizationFor(aliceId),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const wire = await readUntil(response, ': heartbeat');
    expect(wire).toContain('retry: 3000\n\n');
    expect(wire).toContain(`id: ${eventId}\n`);
    expect(wire).toContain('event: notification.created\n');
    expect(wire).toContain('data: {"notification"');
    expect(wire).toContain('\n\n: heartbeat');
  });

  it('replays strictly after Last-Event-ID', async () => {
    const inserted = await harness.pool.query<{ id: string }>(
      `INSERT INTO realtime_events (type, audience_user_id, payload)
       SELECT 'notification.created', $1, jsonb_build_object(
         'notification', jsonb_build_object(
           'id', generated.notification_id,
           'type', 'RESERVATION_CONFIRMED',
           'title', 'Reservation confirmed',
           'message', 'Reservation confirmed',
           'data', '{}'::jsonb,
           'readAt', NULL,
           'createdAt', '2026-08-12T00:00:00.000Z'
         )
       )
       FROM (VALUES
         ('10000000-0000-4000-8000-000000000001'),
         ('10000000-0000-4000-8000-000000000002')
       ) AS generated(notification_id)
       RETURNING id::text`,
      [aliceId],
    );
    const firstId = inserted.rows[0]?.id;
    const secondId = inserted.rows[1]?.id;
    if (firstId === undefined || secondId === undefined) {
      throw new Error('Realtime fixtures did not return two rows');
    }
    const { baseUrl } = await startSubject();

    const response = await fetch(`${baseUrl}/api/realtime/stream`, {
      headers: {
        authorization: authorizationFor(aliceId),
        'Last-Event-ID': firstId,
      },
    });
    const wire = await readUntil(response, ': heartbeat');

    expect(wire).not.toContain(`id: ${firstId}\n`);
    expect(wire).toContain(`id: ${secondId}\n`);
  });
});
