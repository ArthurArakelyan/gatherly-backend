# Phase 6 Handbook: Server-Sent Events

This is the second Phase 6 implementation guide. It starts from the repository
after `PHASE_6_POSTGRES_PERFORMANCE_REDIS_HANDBOOK.md` and adds one-way live
delivery for two concrete Gatherly needs:

- personal in-app notifications; and
- reservation and waitlist counters for active community organizers.

The result is still one TypeScript/Node.js modular monolith. PostgreSQL stores
the notification and an append-only replay journal. SSE transports events to a
connected client. Redis Pub/Sub only wakes other application instances so they
check PostgreSQL sooner. Flushing or losing Redis may increase delivery delay,
but it cannot delete an event or corrupt reservation state.

This handbook deliberately stops before WebSockets, chat, Elasticsearch,
Kafka, OpenTelemetry, Nginx, or a frontend framework.

## How to use this handbook

Work through one checkpoint at a time. Each checkpoint has:

1. **Reason:** the engineering lesson.
2. **Implementation:** exact files and copy-pasteable code.
3. **Verification:** a command or manual observation.
4. **Expected result:** the completion condition.

Code blocks labelled **complete file** replace the named file. Smaller blocks
state exactly where they belong. Code blocks do not contain `...` placeholders.
Preserve the completed PostgreSQL/Redis increment in source control first.

Automated test writing is intentionally absent from the implementation
checkpoints. Checkpoint 12 is a separate handoff for an AI coding agent. It
defines what the AI must prove without hiding the SSE implementation lesson
from the learner.

## Phase outcome

At the end of the implementation checkpoints, Gatherly has:

- `GET /api/realtime/stream`, authenticated with the existing bearer token;
- valid `text/event-stream` framing and a client-selected replay cursor through
  `Last-Event-ID`;
- a PostgreSQL `realtime_events` journal written in the same transaction as the
  reservation, waitlist, and notification changes it describes;
- personal `notification.created` events;
- role-filtered `event.attendance.updated` organizer events;
- heartbeat comments, periodic PostgreSQL catch-up, connection limits,
  backpressure handling, and bounded connection lifetime;
- current authorization checks during delivery, not only at connection time;
- Redis Pub/Sub wake-ups across application instances with PostgreSQL replay as
  the recovery path; and
- graceful shutdown which closes SSE streams before waiting for HTTP drain.

The architecture is:

```text
reservation/cancellation request
  -> route -> controller -> ReservationsService
  -> PostgreSQL transaction
       -> reservation/waitlist mutation
       -> durable notification row when applicable
       -> durable realtime_events row(s)
  -> COMMIT
  -> local SSE wake-up
  -> best-effort Redis PUBLISH

every application instance
  -> dedicated Redis subscriber
  -> wake local RealtimeService
  -> query visible realtime_events from PostgreSQL
  -> current authorization filter
  -> SSE frame

Redis unavailable
  -> local wake-up still works
  -> heartbeat catch-up queries PostgreSQL
  -> Last-Event-ID replays after reconnect
```

Two details are fundamental:

1. The journal row is committed atomically with business state. Never publish
   first and then hope the transaction commits.
2. A Redis message contains no trusted business payload. It means only "there
   may be newer PostgreSQL rows."

## Scope and deliberate omissions

Implement now:

- one authenticated stream per user, with a small per-user connection limit;
- named SSE events, IDs, retry advice, heartbeat, replay, and cleanup;
- a monotonic PostgreSQL event ID represented as a decimal string in JSON;
- active-account rechecks and current organizer-role filtering;
- local and cross-instance wake-ups;
- reconnection from a browser `fetch` stream using an Authorization header;
- graceful stream closure during process shutdown.

Do not implement now:

- WebSockets or bidirectional commands over the stream;
- chat, typing indicators, presence, or moderation;
- JWTs in query strings;
- Redis Streams, Redis persistence, or Redis as a replay store;
- Kafka, an outbox publisher, or exactly-once delivery claims;
- one Redis subscription or PostgreSQL polling loop per connected browser;
- Nginx configuration or a production load balancer;
- a general-purpose event sourcing framework.

SSE delivery is **at least once from the client's perspective**. A client can
receive an event, lose its connection before storing the cursor, reconnect with
an older `Last-Event-ID`, and receive the event again. The event ID is the
deduplication key.

---

## Checkpoint 1: Record the boundary and baseline

### Reason

SSE can look successful while silently losing events, leaking authorization,
or preventing shutdown. Record the working Phase 6 baseline before adding a
long-lived HTTP response.

### Verification

Run from the repository root:

```powershell
yarn install --frozen-lockfile
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

Record:

```text
date:
git commit:
PostgreSQL version:
Redis version:
test files / tests passed:
baseline failures:
```

Write down this transport contract before coding:

| SSE event                  | Audience                                                             | Durable source                               | Client reaction                        |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------- |
| `notification.created`     | exactly one user                                                     | `notifications` plus `realtime_events`       | add or refresh the notification        |
| `event.attendance.updated` | current active OWNER, ORGANIZER, or MODERATOR in the event community | reservations/waitlist plus `realtime_events` | replace displayed counts               |
| `stream.refresh-required`  | one live connection                                                  | control frame only                           | refresh the access token and reconnect |
| `stream.closed`            | one live connection                                                  | control frame only                           | reconnect after normal backoff         |

Control frames intentionally have no `id`; they are connection instructions,
not durable business events.

### Expected result

The repository gate passes, and every planned SSE event has a named audience,
durable source, and client behavior.

---

## Checkpoint 2: Add the durable replay journal

### Reason

Redis Pub/Sub drops messages while a subscriber is disconnected. An in-memory
array disappears on restart. Neither can implement replay. A monotonically
increasing PostgreSQL ID provides an opaque SSE `id` and an efficient
`WHERE id > cursor ORDER BY id` query.

The journal is a delivery projection, not event sourcing. Normal Gatherly
tables remain the business model and may be queried to rebuild client state.

### Implementation

Add these relation fields to the existing `User` and `Community` models in
`prisma/schema.prisma`:

```prisma
model User {
  // Keep every existing field and relation.
  realtimeEvents RealtimeEvent[] @relation("RealtimeUserAudience")
}

model Community {
  // Keep every existing field and relation.
  realtimeEvents RealtimeEvent[] @relation("RealtimeCommunityAudience")
}
```

Then add this complete model:

```prisma
model RealtimeEvent {
  id             BigInt     @id @default(autoincrement())
  type           String
  audienceUserId String?    @map("audience_user_id") @db.Uuid
  communityId    String?    @map("community_id") @db.Uuid
  payload        Json       @db.JsonB
  createdAt      DateTime   @default(now()) @map("created_at") @db.Timestamptz(6)
  audienceUser   User?      @relation("RealtimeUserAudience", fields: [audienceUserId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  community      Community? @relation("RealtimeCommunityAudience", fields: [communityId], references: [id], onDelete: NoAction, onUpdate: NoAction)

  @@index([audienceUserId, id], map: "realtime_events_user_id_idx")
  @@index([communityId, id], map: "realtime_events_community_id_idx")
  @@map("realtime_events")
}
```

The comments above mean "insert this field into the existing model"; do not
replace the existing model with those abbreviated blocks.

Create a migration without applying an automatically generated draft:

```powershell
yarn prisma migrate dev --name add_realtime_events --create-only
```

Replace the generated `migration.sql` with this **complete file**:

```sql
CREATE TABLE "realtime_events" (
  "id" BIGSERIAL NOT NULL,
  "type" TEXT NOT NULL,
  "audience_user_id" UUID,
  "community_id" UUID,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "realtime_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "realtime_events_one_audience_check" CHECK (
    (("audience_user_id" IS NOT NULL)::integer
      + ("community_id" IS NOT NULL)::integer) = 1
  ),
  CONSTRAINT "realtime_events_type_check" CHECK (
    "type" IN ('notification.created', 'event.attendance.updated')
  )
);

CREATE INDEX "realtime_events_user_id_idx"
  ON "realtime_events" ("audience_user_id", "id");

CREATE INDEX "realtime_events_community_id_idx"
  ON "realtime_events" ("community_id", "id");

ALTER TABLE "realtime_events"
  ADD CONSTRAINT "realtime_events_audience_user_id_fkey"
  FOREIGN KEY ("audience_user_id") REFERENCES "users"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "realtime_events"
  ADD CONSTRAINT "realtime_events_community_id_fkey"
  FOREIGN KEY ("community_id") REFERENCES "communities"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

Apply and validate it:

```powershell
yarn prisma migrate dev
yarn prisma:generate
yarn prisma:validate
```

`BIGINT` is returned by `pg` as a string. Keep it that way at the API boundary;
JavaScript numbers cannot exactly represent every 64-bit integer.

Do not add a speculative cleanup worker yet. Record journal row growth during
the learning phase. Before a real deployment, choose a measured retention
window, delete in bounded batches, and document that clients offline longer
than the window must refresh canonical REST resources.

### Verification

```powershell
docker compose exec postgres psql -U gatherly -d gatherly -c "\d realtime_events"
```

### Expected result

The table permits exactly one audience scope, accepts only the two implemented
durable event names, and has cursor-friendly audience indexes.

---

## Checkpoint 3: Define module-owned event types and PostgreSQL reads

### Reason

The Redis subscriber, Express controller, and reservation module need a small
contract that does not depend on Express or Redis types. The repository must
apply object-level authorization while selecting each batch. A role checked at
connection time can be revoked while the connection remains open.

### Implementation

Create `src/modules/realtime/realtime.types.ts` with this **complete file**:

```ts
export interface NotificationCreatedEvent {
  id: string;
  type: 'notification.created';
  data: {
    notification: {
      id: string;
      type: string;
      title: string;
      message: string;
      data: Record<string, unknown>;
      readAt: null;
      createdAt: string;
    };
  };
  createdAt: Date;
}

export interface AttendanceUpdatedEvent {
  id: string;
  type: 'event.attendance.updated';
  data: {
    eventId: string;
    confirmedCount: number;
    waitingCount: number;
    capacity: number;
  };
  createdAt: Date;
}

export type RealtimeEvent = NotificationCreatedEvent | AttendanceUpdatedEvent;

export interface RealtimeStreamMessage {
  id?: string;
  event: RealtimeEvent['type'] | 'stream.refresh-required' | 'stream.closed';
  data: unknown;
}

export interface RealtimeStream {
  open(retryMilliseconds: number): void;
  send(message: RealtimeStreamMessage): boolean;
  heartbeat(): boolean;
  onClose(listener: () => void): void;
  close(): void;
}

export interface RealtimeWakeupPublisher {
  wake(): void;
}

export interface RealtimeWakeupTarget {
  wakeAll(): void;
}

export interface RealtimeEventReader {
  isActiveUser(userId: string): Promise<boolean>;
  findVisibleAfter(userId: string, afterId: bigint, limit: number): Promise<RealtimeEvent[]>;
}
```

Create `src/modules/realtime/realtime.schemas.ts` with this **complete file**:

```ts
import { z } from 'zod';

import type { RealtimeEvent, RealtimeEventReader } from './realtime.types.js';

const eventIdSchema = z.string().regex(/^\d+$/);

const notificationCreatedSchema = z.object({
  id: eventIdSchema,
  type: z.literal('notification.created'),
  data: z.object({
    notification: z.object({
      id: z.uuid(),
      type: z.string().min(1),
      title: z.string(),
      message: z.string(),
      data: z.record(z.string(), z.unknown()),
      readAt: z.null(),
      createdAt: z.iso.datetime(),
    }),
  }),
  createdAt: z.date(),
});

const attendanceUpdatedSchema = z.object({
  id: eventIdSchema,
  type: z.literal('event.attendance.updated'),
  data: z.object({
    eventId: z.uuid(),
    confirmedCount: z.number().int().nonnegative(),
    waitingCount: z.number().int().nonnegative(),
    capacity: z.number().int().positive(),
  }),
  createdAt: z.date(),
});

export const realtimeEventSchema: z.ZodType<RealtimeEvent> = z.discriminatedUnion('type', [
  notificationCreatedSchema,
  attendanceUpdatedSchema,
]);
```

Create `src/modules/realtime/realtime.repository.ts` with this **complete file**:

```ts
import type { Pool } from 'pg';

import { realtimeEventSchema } from './realtime.schemas.js';
import type { RealtimeEvent } from './realtime.types.js';

interface RealtimeEventRow {
  id: string;
  type: string;
  payload: unknown;
  created_at: Date;
}

export class RealtimeRepository implements RealtimeEventReader {
  public constructor(private readonly pool: Pool) {}

  public async isActiveUser(userId: string): Promise<boolean> {
    const result = await this.pool.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE'
       ) AS active`,
      [userId],
    );
    return result.rows[0]?.active ?? false;
  }

  public async findVisibleAfter(
    userId: string,
    afterId: bigint,
    limit: number,
  ): Promise<RealtimeEvent[]> {
    const result = await this.pool.query<RealtimeEventRow>(
      `SELECT realtime_event.id::text,
              realtime_event.type,
              realtime_event.payload,
              realtime_event.created_at
       FROM realtime_events AS realtime_event
       WHERE realtime_event.id > $2::bigint
         AND EXISTS (
           SELECT 1 FROM users AS connected_user
           WHERE connected_user.id = $1::uuid
             AND connected_user.status = 'ACTIVE'
         )
         AND (
           realtime_event.audience_user_id = $1::uuid
           OR EXISTS (
             SELECT 1
             FROM community_memberships AS membership
             JOIN communities AS community
               ON community.id = membership.community_id
             WHERE membership.user_id = $1::uuid
               AND membership.community_id = realtime_event.community_id
               AND membership.status = 'ACTIVE'
               AND membership.role IN ('OWNER', 'ORGANIZER', 'MODERATOR')
               AND community.status = 'ACTIVE'
           )
         )
       ORDER BY realtime_event.id ASC
       LIMIT $3`,
      [userId, afterId.toString(), limit],
    );

    return result.rows.map((row) =>
      realtimeEventSchema.parse({
        id: row.id,
        type: row.type,
        data: row.payload,
        createdAt: row.created_at,
      }),
    );
  }
}
```

The query rechecks community status, membership status, and role for every
batch. A demoted organizer cannot keep receiving later restricted counters.
Personal rows still require the matching user ID, and the service will recheck
that the account itself remains active.

### Verification

```powershell
yarn typecheck
yarn lint
```

### Expected result

`realtime.types.ts` contains only TypeScript contracts, runtime boundary
validation lives in `realtime.schemas.ts`, and all community events are
filtered using current PostgreSQL authorization state.

---

## Checkpoint 4: Implement the Express SSE transport

### Reason

SSE is a UTF-8 text protocol over a long-lived HTTP response. Each message ends
with a blank line. Named events use `event:`, replayable messages use `id:`, and
each JSON payload uses `data:`. Comment lines beginning with `:` are useful
heartbeats and are ignored by the browser event dispatcher.

Node signals backpressure when `response.write()` returns `false`. This first
implementation closes that slow connection instead of building an unbounded
application buffer. The client reconnects and replays from PostgreSQL.

### Implementation

Create `src/infrastructure/http/express-sse-stream.ts` with this **complete
file**:

```ts
import type { Response } from 'express';

import type {
  RealtimeStream,
  RealtimeStreamMessage,
} from '../../modules/realtime/realtime.types.js';

const serializeMessage = (message: RealtimeStreamMessage): string => {
  const fields: string[] = [];
  if (message.id !== undefined) fields.push(`id: ${message.id}`);
  fields.push(`event: ${message.event}`);
  fields.push(`data: ${JSON.stringify(message.data)}`);
  return `${fields.join('\n')}\n\n`;
};

export class ExpressSseStream implements RealtimeStream {
  public constructor(private readonly response: Response) {}

  public open(retryMilliseconds: number): void {
    this.response.status(200);
    this.response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    this.response.setHeader('Cache-Control', 'no-cache, no-transform');
    this.response.setHeader('Connection', 'keep-alive');
    this.response.setHeader('X-Accel-Buffering', 'no');
    this.response.flushHeaders();
    this.response.write(`retry: ${String(retryMilliseconds)}\n\n`);
  }

  public send(message: RealtimeStreamMessage): boolean {
    return this.response.write(serializeMessage(message));
  }

  public heartbeat(): boolean {
    return this.response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }

  public onClose(listener: () => void): void {
    this.response.once('close', listener);
  }

  public close(): void {
    if (!this.response.writableEnded) this.response.end();
  }
}
```

`X-Accel-Buffering: no` is harmless in local development and documents the
future Nginx requirement without adding Nginx now. `no-transform` tells
intermediaries not to buffer or rewrite the stream.

### Verification

```powershell
yarn typecheck
yarn lint
```

### Expected result

The adapter owns Express framing and headers, while the realtime module sees
only its `RealtimeStream` interface.

---

## Checkpoint 5: Own replay, heartbeats, authorization, and cleanup

### Reason

A long-lived connection needs lifecycle ownership. One service should track
local connections, serialize each connection's database drain, recheck account
status, bound connection age, and remove timers on every close path.

Heartbeat catch-up is intentionally more than a comment: after checking the
account, it queries PostgreSQL from the last delivered cursor. This repairs a
missed Redis wake-up. The query is shared through the existing PostgreSQL pool;
there is no dedicated poller per database connection.

### Implementation

Create `src/modules/realtime/realtime.service.ts` with this **complete file**:

```ts
import type { Logger } from 'pino';

import { AppError } from '../../shared/errors/app-error.js';
import type {
  RealtimeEvent,
  RealtimeEventReader,
  RealtimeStream,
  RealtimeWakeupTarget,
} from './realtime.types.js';

interface RealtimeConfiguration {
  heartbeatIntervalMs: number;
  retryMs: number;
  replayBatchSize: number;
  maxConnectionsPerUser: number;
  maxConnectionDurationMs: number;
}

interface Session {
  key: symbol;
  userId: string;
  cursor: bigint;
  stream: RealtimeStream;
  openedAt: number;
  timer: NodeJS.Timeout | undefined;
  draining: boolean;
  drainAgain: boolean;
  closed: boolean;
}

export class RealtimeService implements RealtimeWakeupTarget {
  private readonly sessions = new Map<symbol, Session>();
  private readonly pendingConnectionsByUser = new Map<string, number>();
  private acceptingConnections = true;

  public constructor(
    private readonly repository: RealtimeEventReader,
    private readonly logger: Logger,
    private readonly configuration: RealtimeConfiguration,
  ) {}

  public async connect(userId: string, afterId: bigint, stream: RealtimeStream): Promise<void> {
    this.assertAcceptingConnections();

    const connectionCount =
      [...this.sessions.values()].filter((session) => session.userId === userId && !session.closed)
        .length + (this.pendingConnectionsByUser.get(userId) ?? 0);
    if (connectionCount >= this.configuration.maxConnectionsPerUser) {
      throw new AppError(429, 'SSE_CONNECTION_LIMIT', 'Too many live connections');
    }

    this.pendingConnectionsByUser.set(userId, (this.pendingConnectionsByUser.get(userId) ?? 0) + 1);

    let initialEvents: RealtimeEvent[];
    try {
      if (!(await this.repository.isActiveUser(userId))) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
      }
      initialEvents = await this.repository.findVisibleAfter(
        userId,
        afterId,
        this.configuration.replayBatchSize,
      );
      this.assertAcceptingConnections();
    } finally {
      const remaining = (this.pendingConnectionsByUser.get(userId) ?? 1) - 1;
      if (remaining === 0) this.pendingConnectionsByUser.delete(userId);
      else this.pendingConnectionsByUser.set(userId, remaining);
    }

    const session: Session = {
      key: Symbol(userId),
      userId,
      cursor: afterId,
      stream,
      openedAt: Date.now(),
      timer: undefined,
      draining: false,
      drainAgain: false,
      closed: false,
    };

    stream.onClose(() => {
      this.removeSession(session);
    });
    stream.open(this.configuration.retryMs);
    this.sessions.set(session.key, session);

    if (!this.sendEvents(session, initialEvents)) return;

    session.timer = setInterval(() => {
      void this.onHeartbeat(session);
    }, this.configuration.heartbeatIntervalMs);
    session.timer.unref();

    // Closes the small race between the initial query and session registration.
    void this.drain(session);
  }

  public wakeAll(): void {
    for (const session of this.sessions.values()) void this.drain(session);
  }

  public shutdown(): void {
    this.acceptingConnections = false;
    for (const session of [...this.sessions.values()]) {
      session.stream.send({
        event: 'stream.closed',
        data: { reason: 'server_shutdown' },
      });
      this.removeSession(session);
    }
  }

  private sendEvents(session: Session, events: RealtimeEvent[]): boolean {
    if (this.isSessionClosed(session)) return false;

    for (const event of events) {
      const writable = session.stream.send({
        id: event.id,
        event: event.type,
        data: event.data,
      });
      if (!writable) {
        this.logger.warn({ userId: session.userId }, 'Closing backpressured SSE connection');
        this.removeSession(session);
        return false;
      }
      session.cursor = BigInt(event.id);
    }
    return true;
  }

  private async drain(session: Session): Promise<void> {
    if (session.closed) return;
    if (session.draining) {
      session.drainAgain = true;
      return;
    }

    session.draining = true;
    try {
      do {
        session.drainAgain = false;
        let events: RealtimeEvent[];
        do {
          events = await this.repository.findVisibleAfter(
            session.userId,
            session.cursor,
            this.configuration.replayBatchSize,
          );
          if (!this.sendEvents(session, events)) return;
        } while (
          events.length === this.configuration.replayBatchSize &&
          !this.isSessionClosed(session)
        );
      } while (this.shouldDrainAgain(session) && !this.isSessionClosed(session));
    } catch (error) {
      this.logger.warn(
        { err: error, userId: session.userId },
        'SSE catch-up failed; the next heartbeat will retry',
      );
    } finally {
      session.draining = false;
    }
  }

  private async onHeartbeat(session: Session): Promise<void> {
    if (session.closed) return;

    if (Date.now() - session.openedAt >= this.configuration.maxConnectionDurationMs) {
      session.stream.send({
        event: 'stream.refresh-required',
        data: { reason: 'connection_age_limit' },
      });
      this.removeSession(session);
      return;
    }

    try {
      if (!(await this.repository.isActiveUser(session.userId))) {
        session.stream.send({
          event: 'stream.closed',
          data: { reason: 'authorization_revoked' },
        });
        this.removeSession(session);
        return;
      }
    } catch (error) {
      this.logger.warn({ err: error, userId: session.userId }, 'SSE authorization recheck failed');
      this.removeSession(session);
      return;
    }

    if (!session.stream.heartbeat()) {
      this.removeSession(session);
      return;
    }
    await this.drain(session);
  }

  private removeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (session.timer !== undefined) clearInterval(session.timer);
    this.sessions.delete(session.key);
    session.stream.close();
  }

  private assertAcceptingConnections(): void {
    if (!this.acceptingConnections) {
      throw new AppError(503, 'SERVER_DRAINING', 'The server is shutting down');
    }
  }

  private isSessionClosed(session: Session): boolean {
    return session.closed;
  }

  private shouldDrainAgain(session: Session): boolean {
    return session.drainAgain;
  }
}
```

The maximum connection age does not replace JWT validation. The token is
validated when the request opens; the bound limits how long that single
authenticated request can remain open and periodically forces a fresh HTTP
handshake. Account status is checked separately on every heartbeat. A later
increment may carry the verified JWT expiry in the authentication context and
close at that exact instant; do not decode an unverified token in this module.

### Verification

```powershell
yarn typecheck
yarn lint
```

### Expected result

Each local connection has one cursor, at most one active drain, one timer, and
one idempotent cleanup path. Redis loss cannot permanently strand committed
events because the heartbeat drains PostgreSQL.

---

## Checkpoint 6: Expose one authenticated stream route

### Reason

The existing authentication mechanism is `Authorization: Bearer <token>`.
Native browser `EventSource` cannot attach that header. Do not work around it
by putting a JWT in the URL, where browser history, access logs, monitoring,
and referrer handling can expose it. Use a streaming `fetch` client instead.

`Last-Event-ID` is an opaque protocol value to clients, but this server expects
the decimal PostgreSQL cursor it previously sent. Validate it before opening
the response so ordinary JSON error middleware can still respond.

### Implementation

Create `src/modules/realtime/realtime.controller.ts` with this **complete file**:

```ts
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { ExpressSseStream } from '../../infrastructure/http/express-sse-stream.js';
import { getAuthenticatedUser } from '../../shared/auth/authentication.middleware.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { RealtimeService } from './realtime.service.js';

const lastEventIdSchema = z.string().regex(/^\d{1,19}$/);
const maximumEventId = 9_223_372_036_854_775_807n;

const parseLastEventId = (value: string | undefined): bigint => {
  if (value === undefined || value === '') return 0n;
  const parsed = lastEventIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, 'INVALID_LAST_EVENT_ID', 'Last-Event-ID is invalid');
  }
  const eventId = BigInt(parsed.data);
  if (eventId > maximumEventId) {
    throw new AppError(400, 'INVALID_LAST_EVENT_ID', 'Last-Event-ID is invalid');
  }
  return eventId;
};

export class RealtimeController {
  public constructor(private readonly service: RealtimeService) {}

  public readonly stream: RequestHandler = async (request, response) => {
    const afterId = parseLastEventId(request.header('Last-Event-ID'));
    const userId = getAuthenticatedUser(response).id;
    await this.service.connect(userId, afterId, new ExpressSseStream(response));
  };
}
```

Create `src/modules/realtime/realtime.routes.ts` with this **complete file**:

```ts
import { type RequestHandler, Router } from 'express';

import type { RealtimeController } from './realtime.controller.js';

export const createRealtimeRouter = (
  controller: RealtimeController,
  requireAuthenticatedUser: RequestHandler,
): Router => {
  const router = Router();
  router.get('/realtime/stream', requireAuthenticatedUser, controller.stream);
  return router;
};
```

In `src/app.ts`, import no realtime implementation. Add an optional router to
`AppDependencies` so existing test composition continues compiling until the AI
test checkpoint wires a test instance:

```ts
export interface AppDependencies {
  corsOrigin: string;
  enableHttpLogging: boolean;
  logger: Logger;
  checkReadiness: () => Promise<boolean>;
  isShuttingDown: () => boolean;
  communitiesRouter: Router;
  membershipsRouter: Router;
  eventsRouter: Router;
  reservationsRouter: Router;
  identityRouter: Router;
  realtimeRouter?: Router;
}
```

Mount it after the authenticated domain routers and before `notFoundHandler`:

```ts
if (dependencies.realtimeRouter !== undefined) {
  app.use('/api', dependencies.realtimeRouter);
}
```

Do not place `express.json()` after this route. It already appears earlier and
does not buffer an empty GET body; response compression is not installed.

### Verification

```powershell
yarn typecheck
yarn lint
```

### Expected result

Missing or invalid authentication receives the existing safe JSON `401` before
SSE headers are sent. A malformed replay cursor receives JSON `400`. A valid
request switches to `text/event-stream` and remains open.

---

## Checkpoint 7: Add Redis wake-ups without moving truth to Redis

### Reason

A Redis connection in subscriber mode must be dedicated to subscription work.
Use `duplicate()` once at startup, never once per HTTP request. Every instance
subscribes to the same versioned channel. A publication contains no user data
and tells the instance only to drain visible PostgreSQL events for its local
clients.

Local wake-up happens before best-effort publication. This gives low latency on
one instance even when Redis is unavailable. Heartbeat replay remains the
fallback for every instance.

### Implementation

Create `src/infrastructure/redis/realtime-bus.ts` with this **complete file**:

```ts
import type { Logger } from 'pino';

import type {
  RealtimeWakeupPublisher,
  RealtimeWakeupTarget,
} from '../../modules/realtime/realtime.types.js';
import { closeRedisClient, type GatherlyRedisClient } from './client.js';

const realtimeChannel = 'gatherly:realtime:wakeup:v1';

export class RedisRealtimeBus implements RealtimeWakeupPublisher {
  private started = false;

  public constructor(
    private readonly publisher: GatherlyRedisClient,
    private readonly subscriber: GatherlyRedisClient,
    private readonly realtimeTarget: RealtimeWakeupTarget,
    private readonly logger: Logger,
  ) {}

  public start(): void {
    if (this.started) return;
    this.started = true;

    void this.subscriber
      .connect()
      .then(() =>
        this.subscriber.subscribe(realtimeChannel, () => {
          this.realtimeTarget.wakeAll();
        }),
      )
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error },
          'Realtime Redis subscription unavailable; heartbeat replay remains active',
        );
      });
  }

  public wake(): void {
    this.realtimeTarget.wakeAll();
    if (!this.publisher.isReady) return;

    void this.publisher.publish(realtimeChannel, 'wake').catch((error: unknown) => {
      this.logger.warn(
        { err: error },
        'Realtime Redis publish failed; heartbeat replay remains active',
      );
    });
  }

  public async close(): Promise<void> {
    if (this.subscriber.isReady) await this.subscriber.unsubscribe(realtimeChannel);
    await closeRedisClient(this.subscriber);
  }
}

export const createRealtimeSubscriber = (
  publisher: GatherlyRedisClient,
  logger: Logger,
): GatherlyRedisClient => {
  const subscriber = publisher.duplicate();
  subscriber.on('error', (error) => {
    logger.warn({ err: error }, 'Realtime Redis subscriber error');
  });
  return subscriber;
};
```

Do not include the event ID or serialized notification as a source of truth in
the Redis message. A content-free wake-up also coalesces naturally: ten quick
messages may cause redundant reads, but one later read fetches every row after
the connection cursor in order.

### Verification

```powershell
yarn typecheck
yarn lint
```

### Expected result

The process owns one ordinary Redis client and one dedicated subscriber. Local
delivery works without Redis, and cross-instance delivery becomes faster when
Redis is healthy.

---

## Checkpoint 8: Append journal rows inside reservation transactions

### Reason

The journal must describe only committed truth. Insert personal and community
events using the same `PoolClient` and transaction already protecting capacity
and waitlist promotion. Then call `wake()` only after `inTransaction` resolves.

An idempotent reservation replay may issue an unnecessary wake-up, but it must
not insert another journal row. The replay branch performs no inserts, so the
client sees no duplicate durable effect.

### Implementation

In `ReservationTransactionRepository` in
`src/modules/reservations/reservations.repository.ts`, replace
`insertNotification` with these methods:

```ts
  public async insertNotification(
    userId: string,
    eventId: string,
    type: 'RESERVATION_CONFIRMED' | 'WAITLIST_JOINED',
  ): Promise<void> {
    const title = type === 'RESERVATION_CONFIRMED' ? 'Reservation confirmed' : 'Added to waitlist';
    const result = await this.client.query<{
      id: string;
      type: string;
      title: string;
      message: string;
      data: Record<string, unknown>;
      created_at: Date;
    }>(
      `INSERT INTO notifications (user_id, type, title, message, data)
       VALUES ($1, $2, $3, $3, jsonb_build_object('eventId', $4::text))
       RETURNING id, type, title, message, data, created_at`,
      [userId, type, title, eventId],
    );
    const notification = result.rows[0];
    if (notification === undefined) throw new Error('Notification insert returned no row');

    await this.insertNotificationRealtimeEvent(userId, notification);
  }

  private async insertNotificationRealtimeEvent(
    userId: string,
    notification: {
      id: string;
      type: string;
      title: string;
      message: string;
      data: Record<string, unknown>;
      created_at: Date;
    },
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO realtime_events (type, audience_user_id, payload)
       VALUES ('notification.created', $1, $2::jsonb)`,
      [
        userId,
        JSON.stringify({
          notification: {
            id: notification.id,
            type: notification.type,
            title: notification.title,
            message: notification.message,
            data: notification.data,
            readAt: null,
            createdAt: notification.created_at.toISOString(),
          },
        }),
      ],
    );
  }

  public async insertAttendanceRealtimeEvent(
    communityId: string,
    eventId: string,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO realtime_events (type, community_id, payload)
       SELECT 'event.attendance.updated', $1::uuid,
              jsonb_build_object(
                'eventId', event_record.id::text,
                'confirmedCount', (
                  SELECT count(*)::integer
                  FROM reservations
                  WHERE event_id = event_record.id AND status = 'CONFIRMED'
                ),
                'waitingCount', (
                  SELECT count(*)::integer
                  FROM waitlist_entries
                  WHERE event_id = event_record.id AND status = 'WAITING'
                ),
                'capacity', event_record.capacity
              )
       FROM events AS event_record
       WHERE event_record.id = $2::uuid`,
      [communityId, eventId],
    );
  }
```

Replace `insertPromotionNotification` with this complete method so promotion
also gets a personal SSE event:

```ts
  public async insertPromotionNotification(userId: string, eventId: string): Promise<void> {
    const result = await this.client.query<{
      id: string;
      type: string;
      title: string;
      message: string;
      data: Record<string, unknown>;
      created_at: Date;
    }>(
      `INSERT INTO notifications (user_id, type, title, message, data)
       VALUES ($1, 'WAITLIST_PROMOTED', 'Reservation confirmed',
               'A place became available', jsonb_build_object('eventId', $2::text))
       RETURNING id, type, title, message, data, created_at`,
      [userId, eventId],
    );
    const notification = result.rows[0];
    if (notification === undefined) throw new Error('Notification insert returned no row');
    await this.insertNotificationRealtimeEvent(userId, notification);
  }
```

Move waitlist cancellation into the transaction repository by adding:

```ts
  public async cancelWaiting(eventId: string, userId: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE waitlist_entries
       SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
       WHERE event_id = $1 AND user_id = $2 AND status = 'WAITING'
       RETURNING id`,
      [eventId, userId],
    );
    return result.rowCount === 1;
  }
```

Delete the old public `ReservationsRepository.cancelWaiting` method; callers
will now use `inTransaction`.

Replace `src/modules/reservations/reservations.service.ts` with this **complete
file**:

```ts
import { createHash } from 'node:crypto';

import type { RealtimeWakeupPublisher } from '../realtime/realtime.types.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  type ReservationsRepository,
  type ReservationTransactionRepository,
} from './reservations.repository.js';
import type {
  AttendanceOutcome,
  LockedEvent,
  ReservationCommandResult,
  ReservationSummary,
  WaitlistSummary,
} from './reservations.types.js';

const hashRequest = (eventId: string, userId: string): string =>
  createHash('sha256')
    .update(JSON.stringify({ operation: 'reserve', eventId, userId }))
    .digest('hex');

export class ReservationsService {
  public constructor(
    private readonly repository: ReservationsRepository,
    private readonly realtime?: RealtimeWakeupPublisher,
  ) {}

  private async createAttendance(
    transaction: ReservationTransactionRepository,
    event: LockedEvent,
    userId: string,
  ): Promise<AttendanceOutcome> {
    if (event.status !== 'PUBLISHED' || event.startsAt <= new Date()) {
      throw new AppError(409, 'EVENT_NOT_RESERVABLE', 'This event cannot be reserved');
    }
    if ((await transaction.findMembershipStatus(event.communityId, userId)) !== 'ACTIVE') {
      throw new AppError(403, 'COMMUNITY_PERMISSION_DENIED', 'Active membership is required');
    }

    const state = await transaction.findActiveState(event.id, userId);
    if (state.reserved) {
      throw new AppError(409, 'ALREADY_RESERVED', 'You already have a reservation');
    }
    if (state.waiting) {
      throw new AppError(409, 'ALREADY_WAITLISTED', 'You are already waiting');
    }

    let outcome: AttendanceOutcome;
    if ((await transaction.countConfirmed(event.id)) < event.capacity) {
      const reservationId = await transaction.insertConfirmed(event.id, userId);
      await transaction.insertNotification(userId, event.id, 'RESERVATION_CONFIRMED');
      outcome = { attendanceStatus: 'CONFIRMED', reservationId };
    } else {
      const entry = await transaction.insertWaiting(event.id, userId);
      const position = await transaction.calculatePosition(event.id, entry.joinedAt, entry.id);
      await transaction.insertNotification(userId, event.id, 'WAITLIST_JOINED');
      outcome = { attendanceStatus: 'WAITLISTED', waitlistEntryId: entry.id, position };
    }

    await transaction.insertAttendanceRealtimeEvent(event.communityId, event.id);
    return outcome;
  }

  public async reserve(
    eventId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<ReservationCommandResult> {
    const result = await this.repository.inTransaction(async (transaction) => {
      const event = await transaction.lockEvent(eventId);
      if (event === null) {
        throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
      }

      const claim = await transaction.claimIdempotency(
        userId,
        `reserve:${eventId}`,
        idempotencyKey,
        hashRequest(eventId, userId),
      );
      if (claim.kind === 'CONFLICT') {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused');
      }
      if (claim.kind === 'INCOMPLETE') {
        throw new AppError(409, 'REQUEST_IN_PROGRESS', 'The original request is incomplete');
      }
      if (claim.kind === 'REPLAY') return { status: claim.status, body: claim.body };

      const commandResult = {
        status: 201,
        body: await this.createAttendance(transaction, event, userId),
      };
      await transaction.completeIdempotency(claim.id, commandResult);
      return commandResult;
    });

    this.realtime?.wake();
    return result;
  }

  public async getReservation(eventId: string, userId: string): Promise<ReservationSummary> {
    const reservation = await this.repository.findReservation(eventId, userId);
    if (reservation === null) {
      throw new AppError(404, 'RESERVATION_NOT_FOUND', 'No active reservation exists');
    }
    return reservation;
  }

  public async getWaitlistEntry(eventId: string, userId: string): Promise<WaitlistSummary> {
    const entry = await this.repository.findWaitlistEntry(eventId, userId);
    if (entry === null) {
      throw new AppError(404, 'WAITLIST_ENTRY_NOT_FOUND', 'No active waitlist entry exists');
    }
    return entry;
  }

  public async cancelReservation(eventId: string, userId: string): Promise<void> {
    await this.repository.inTransaction(async (transaction) => {
      const event = await transaction.lockEvent(eventId);
      if (event === null) {
        throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
      }
      if (!(await transaction.cancelConfirmed(eventId, userId))) {
        throw new AppError(404, 'RESERVATION_NOT_FOUND', 'No active reservation exists');
      }

      const entry = await transaction.findFirstWaiting(eventId);
      if (entry !== null) {
        await transaction.promoteWaitlistEntry(entry.id);
        await transaction.insertPromotedReservation(eventId, entry.userId);
        await transaction.insertPromotionNotification(entry.userId, eventId);
      }
      await transaction.insertAttendanceRealtimeEvent(event.communityId, event.id);
    });

    this.realtime?.wake();
  }

  public async cancelWaitlist(eventId: string, userId: string): Promise<void> {
    await this.repository.inTransaction(async (transaction) => {
      const event = await transaction.lockEvent(eventId);
      if (event === null) {
        throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
      }
      if (!(await transaction.cancelWaiting(eventId, userId))) {
        throw new AppError(404, 'WAITLIST_ENTRY_NOT_FOUND', 'No active waitlist entry exists');
      }
      await transaction.insertAttendanceRealtimeEvent(event.communityId, event.id);
    });

    this.realtime?.wake();
  }
}
```

The optional publisher keeps existing unit/API composition valid during the
learning checkpoints. Production wiring in Checkpoint 10 passes the concrete
bus. The AI test step should inject a fake explicitly where wake-up behavior is
under test.

### Verification

```powershell
yarn typecheck
yarn lint
```

Inspect the transaction boundary: every `realtime_events` insert uses the
transaction's `PoolClient`, while `wake()` runs only after the transaction
promise resolves.

### Expected result

A rollback removes the business mutation, notification, and journal rows
together. A commit makes all of them visible before any live wake-up occurs.

---

## Checkpoint 9: Close long-lived streams before HTTP drain

### Reason

`server.close()` stops accepting new connections but waits for existing
responses. An SSE response can remain open forever, so the current graceful
shutdown would reach its force-close timeout on every deployment. Close known
long-lived transports immediately after readiness turns false and before
waiting for ordinary requests.

### Implementation

Replace `src/infrastructure/http/graceful-shutdown.ts` with this **complete
file**:

```ts
import type { Server } from 'node:http';

import type { Logger } from 'pino';

export interface ShutdownState {
  started: boolean;
}

interface GracefulShutdownDependencies {
  server: Server;
  state: ShutdownState;
  logger: Logger;
  timeoutMs: number;
  closeLongLivedConnections?: () => Promise<void> | void;
  closeDependencies: () => Promise<void>;
}

export interface ShutdownResult {
  forced: boolean;
}

export interface GracefulShutdown {
  shutdown: (signal: NodeJS.Signals) => Promise<ShutdownResult>;
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });

export const createGracefulShutdown = (
  dependencies: GracefulShutdownDependencies,
): GracefulShutdown => {
  let shutdownPromise: Promise<ShutdownResult> | undefined;

  return {
    shutdown: (signal) => {
      if (shutdownPromise !== undefined) return shutdownPromise;

      dependencies.state.started = true;
      dependencies.logger.info({ signal }, 'Graceful shutdown started');

      shutdownPromise = (async () => {
        let forced = false;
        const timeout = setTimeout(() => {
          forced = true;
          dependencies.logger.error('Graceful shutdown timed out');
          dependencies.server.closeAllConnections();
        }, dependencies.timeoutMs);
        timeout.unref();

        try {
          const closeLongLivedConnections = dependencies.closeLongLivedConnections?.();
          if (closeLongLivedConnections !== undefined) await closeLongLivedConnections;
          await closeServer(dependencies.server);
          await dependencies.closeDependencies();
          dependencies.logger.info({ forced }, 'Graceful shutdown completed');
          return { forced };
        } finally {
          clearTimeout(timeout);
        }
      })();

      return shutdownPromise;
    },
  };
};
```

The new hook is optional so existing tests continue compiling before the AI
checkpoint extends their assertions. It runs inside the same idempotent
shutdown promise.

### Verification

```powershell
yarn typecheck
yarn lint
```

### Expected result

Shutdown order is: fail readiness, send SSE close controls and end streams,
drain normal HTTP requests, then close Redis, Prisma, and PostgreSQL clients.

---

## Checkpoint 10: Validate configuration and wire the composition root

### Reason

Heartbeat, retry, batch, and connection bounds are operational choices. Parse
them once at startup. The composition root should create concrete adapters and
make their startup/shutdown ownership obvious.

Redis remains absent from readiness: heartbeat replay and local delivery make a
Redis outage degraded, not not-ready. PostgreSQL remains authoritative and is
still part of readiness.

### Implementation

Add these fields to `environmentSchema` in `src/config/env.ts`:

```ts
  SSE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(5_000).max(60_000).default(15_000),
  SSE_RETRY_MS: z.coerce.number().int().min(500).max(30_000).default(3_000),
  SSE_REPLAY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  SSE_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().min(1).max(10).default(3),
  SSE_MAX_CONNECTION_DURATION_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(600_000),
```

Add to `.env.example`:

```dotenv
# Server-Sent Events
SSE_HEARTBEAT_INTERVAL_MS=15000
SSE_RETRY_MS=3000
SSE_REPLAY_BATCH_SIZE=100
SSE_MAX_CONNECTIONS_PER_USER=3
SSE_MAX_CONNECTION_DURATION_MS=600000
```

Add the same five variables to the `app.environment` map in `compose.yaml`,
using these defaults:

```yaml
SSE_HEARTBEAT_INTERVAL_MS: ${SSE_HEARTBEAT_INTERVAL_MS:-15000}
SSE_RETRY_MS: ${SSE_RETRY_MS:-3000}
SSE_REPLAY_BATCH_SIZE: ${SSE_REPLAY_BATCH_SIZE:-100}
SSE_MAX_CONNECTIONS_PER_USER: ${SSE_MAX_CONNECTIONS_PER_USER:-3}
SSE_MAX_CONNECTION_DURATION_MS: ${SSE_MAX_CONNECTION_DURATION_MS:-600000}
```

Add these imports to `src/server.ts`:

```ts
import { RedisRealtimeBus, createRealtimeSubscriber } from './infrastructure/redis/realtime-bus.js';
import { RealtimeController } from './modules/realtime/realtime.controller.js';
import { RealtimeRepository } from './modules/realtime/realtime.repository.js';
import { createRealtimeRouter } from './modules/realtime/realtime.routes.js';
import { RealtimeService } from './modules/realtime/realtime.service.js';
```

After creating the ordinary Redis client, create the realtime objects:

```ts
const realtimeRepository = new RealtimeRepository(pool);
const realtimeService = new RealtimeService(realtimeRepository, logger, {
  heartbeatIntervalMs: environment.SSE_HEARTBEAT_INTERVAL_MS,
  retryMs: environment.SSE_RETRY_MS,
  replayBatchSize: environment.SSE_REPLAY_BATCH_SIZE,
  maxConnectionsPerUser: environment.SSE_MAX_CONNECTIONS_PER_USER,
  maxConnectionDurationMs: environment.SSE_MAX_CONNECTION_DURATION_MS,
});
const realtimeSubscriber = createRealtimeSubscriber(redis, logger);
const realtimeBus = new RedisRealtimeBus(redis, realtimeSubscriber, realtimeService, logger);
realtimeBus.start();
```

Construct `ReservationsService` with the bus:

```ts
const reservationsRepository = new ReservationsRepository(pool);
const reservationsService = new ReservationsService(reservationsRepository, realtimeBus);
```

Create the realtime router after `requireAuthenticatedUser` exists:

```ts
const realtimeRouter = createRealtimeRouter(
  new RealtimeController(realtimeService),
  requireAuthenticatedUser,
);
```

Pass it to `createApp`:

```ts
  realtimeRouter,
```

Finally update graceful shutdown:

```ts
const gracefulShutdown = createGracefulShutdown({
  server,
  state: shutdownState,
  logger,
  timeoutMs: 10_000,
  closeLongLivedConnections: () => realtimeService.shutdown(),
  closeDependencies: async () => {
    await Promise.all([
      realtimeBus.close(),
      closeRedisClient(redis),
      prisma.$disconnect(),
      pool.end(),
    ]);
  },
});
```

Do not add Redis to `checkReadiness`. Do not create the subscriber inside a
route or controller.

### Verification

```powershell
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

### Expected result

The composition root owns one realtime service, one publisher, one subscriber,
one router, and an explicit shutdown order. Invalid SSE configuration prevents
startup with a Zod error.

---

## Checkpoint 11: Document and manually exercise the protocol

### Reason

OpenAPI cannot fully express timing and reconnect behavior, but it should still
document authentication, headers, media type, event names, and replay. A manual
stream makes framing visible before automated tests abstract it away.

### Implementation

Add a `Realtime` tag to `docs/openapi.yaml`:

```yaml
- name: Realtime
  description: Authenticated one-way notification and organizer updates over SSE.
```

Add this path before `components:`:

```yaml
/api/realtime/stream:
  get:
    tags: [Realtime]
    summary: Open the authenticated realtime event stream
    description: |
      Sends UTF-8 Server-Sent Events. Use the bearer token in the
      Authorization header. Reconnect with the last processed SSE `id` in
      `Last-Event-ID`. Durable event names are `notification.created` and
      `event.attendance.updated`; control events have no id.
    security: [{ bearerAuth: [] }]
    parameters:
      - name: Last-Event-ID
        in: header
        required: false
        description: Decimal event id last processed by the client.
        schema: { type: string, pattern: '^\d{1,19}$' }
    responses:
      '200':
        description: Long-lived SSE stream. Each durable event contains `id`, `event`, and JSON `data` fields.
        headers:
          Cache-Control:
            schema: { type: string, example: 'no-cache, no-transform' }
        content:
          text/event-stream:
            schema: { type: string }
            example: |
              retry: 3000

              id: 42
              event: notification.created
              data: {"notification":{"id":"b9d1ef65-d5d2-4f52-bb7c-173819b739e4","type":"RESERVATION_CONFIRMED","title":"Reservation confirmed","message":"Reservation confirmed","data":{"eventId":"6a85187e-953a-46ac-b95f-44967f2615ba"},"readAt":null,"createdAt":"2026-08-10T10:00:00.000Z"}}

      '400': { $ref: '#/components/responses/Error' }
      '401': { $ref: '#/components/responses/AuthenticationRequired' }
      '429': { $ref: '#/components/responses/Error' }
      '503': { $ref: '#/components/responses/Error' }
```

Create `docs/openapi/realtime/paths.yaml` with the same path item and add
`realtime/` to `docs/openapi/README.md`. The canonical file remains
`docs/openapi.yaml`.

Use this complete browser-side example as protocol documentation. It is not a
new backend file and does not require a frontend framework:

```ts
interface StreamOptions {
  url: string;
  accessToken: () => Promise<string>;
  onEvent: (event: { id: string; type: string; data: unknown }) => void;
  signal: AbortSignal;
}

const waitForRetry = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = (): void => {
      window.clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });

export const consumeGatherlyStream = async (options: StreamOptions): Promise<void> => {
  let lastEventId = localStorage.getItem('gatherly:last-event-id') ?? '';
  let retryMs = 3_000;

  while (!options.signal.aborted) {
    const token = await options.accessToken();
    const response = await fetch(options.url, {
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        ...(lastEventId === '' ? {} : { 'Last-Event-ID': lastEventId }),
      },
      signal: options.signal,
    });

    if (!response.ok || response.body === null) {
      throw new Error(`SSE connection failed with ${String(response.status)}`);
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let reconnectRequired = false;

    while (!options.signal.aborted && !reconnectRequired) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value.replaceAll('\r\n', '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        let id = '';
        let type = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('retry:')) retryMs = Number(line.slice(6).trim());
          if (line.startsWith('id:')) id = line.slice(3).trim();
          if (line.startsWith('event:')) type = line.slice(6).trim();
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }

        if (dataLines.length === 0) continue;
        const data: unknown = JSON.parse(dataLines.join('\n'));
        if (id !== '') {
          options.onEvent({ id, type, data });
          localStorage.setItem('gatherly:last-event-id', id);
          lastEventId = id;
        }
        if (type === 'stream.refresh-required' || type === 'stream.closed') {
          reconnectRequired = true;
          break;
        }
      }
    }

    await reader.cancel();
    await waitForRetry(retryMs, options.signal);
  }
};
```

In a PowerShell terminal, sign in and copy the access token, then run:

```powershell
curl.exe -N `
  -H "Accept: text/event-stream" `
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" `
  http://127.0.0.1:3000/api/realtime/stream
```

In another terminal, make a reservation using the existing endpoint. Observe
`notification.created` for that user and `event.attendance.updated` for a
separately connected organizer. Stop Redis and repeat: local clients should be
woken immediately; clients on another instance catch up on heartbeat. Restart
the app and reconnect with:

```powershell
curl.exe -N `
  -H "Accept: text/event-stream" `
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" `
  -H "Last-Event-ID: 42" `
  http://127.0.0.1:3000/api/realtime/stream
```

Replace `42` with the last ID actually observed.

### Expected result

The response exposes valid framing, heartbeat comments arrive within the
configured interval, durable IDs increase, replay starts strictly after the
cursor, and no token appears in the URL or logs.

---

## Checkpoint 12: Hand automated test implementation to AI

### Why this step is separate

The learner should implement and manually inspect the transport before tests
encode it. At this checkpoint, ask an AI coding agent to add the tests. The AI
must not redesign the feature, weaken production behavior to simplify a test,
or replace real PostgreSQL/Redis boundaries with mocks where integration
behavior is the subject.

No test code is supplied in this handbook on purpose.

**Current repository status:** this AI handoff has been completed. The
realtime unit, HTTP streaming, PostgreSQL, Redis, reservation regression, and
graceful-shutdown tests described below now exist under `tests/`. Keep the
requirements in this checkpoint as the behavioral contract when those tests
are maintained.

### Instructions for the AI coding agent

Give the AI this task:

> Read `AGENTS.md`, `README.md`,
> `PHASE_6_POSTGRES_PERFORMANCE_REDIS_HANDBOOK.md`, and
> `PHASE_6_SSE_HANDBOOK.md`, then inspect the implemented source and existing
> test helpers. Implement the smallest behavioral test suite that proves the
> SSE contract below. Do not add product features or weaken authorization,
> transaction boundaries, replay, backpressure, heartbeat, or shutdown code.
> Use Yarn Classic. Preserve unrelated user changes. Run the proportional
> quality gate and report exact commands and results.

The AI should first update `tests/helpers/test-app.ts` with optional realtime
composition, without forcing unrelated API tests to start Redis or long-lived
timers. It should prefer a small fake implementing `RealtimeStream` for service
unit tests and a real Node HTTP server plus streaming `fetch` for protocol
tests. Supertest often buffers a response until it ends and is therefore a poor
choice for the open-stream assertions.

### Required behavioral coverage

The AI must cover all of these behaviors:

1. An absent, malformed, forged, or expired bearer token never opens SSE.
2. A malformed, negative, or overflowing `Last-Event-ID` returns the safe JSON
   `INVALID_LAST_EVENT_ID` response before SSE headers.
3. A valid stream emits `retry`, correct SSE headers, heartbeat comments, named
   JSON events, blank-line framing, and monotonically increasing decimal IDs.
4. Replay returns only visible rows with `id > Last-Event-ID`, in ascending
   order, across more than one configured batch.
5. A user never receives another user's personal notification.
6. Only a current active OWNER, ORGANIZER, or MODERATOR receives community
   attendance counters; a member does not.
7. Demotion, membership suspension, community archival, and account suspension
   take effect during a live connection. Account suspension closes the stream;
   role loss prevents later restricted rows.
8. Reservation, waitlist, cancellation, and promotion journal rows commit with
   their business changes. An injected mid-transaction failure leaves no
   journal or notification residue.
9. Reusing a completed idempotency key does not add notification or journal
   rows and does not duplicate a durable SSE event.
10. Two concurrent requests for the final place preserve capacity and produce
    journal payloads matching committed reservation/waitlist counts.
11. Local wake-up delivers promptly when Redis is unavailable. Missed remote
    wake-up is recovered by heartbeat or reconnect replay from PostgreSQL.
12. A real Redis Testcontainer propagates a wake-up between two independently
    constructed realtime service instances; Redis carries no business payload.
13. A backpressured stream is closed and removed instead of accumulating an
    unbounded queue. Reconnection can replay the undelivered event.
14. The per-user connection limit returns `SSE_CONNECTION_LIMIT`; closing a
    stream releases the slot and clears its timer.
15. Maximum connection age sends `stream.refresh-required` and closes.
16. Repeated shutdown calls remain idempotent. Shutdown sends `stream.closed`,
    closes SSE before `server.close()` waits, drains an ordinary active request,
    and closes each dependency once.

### Suggested test placement

The AI may adjust names after inspecting existing conventions, but the
responsibilities should be separated approximately as follows:

```text
tests/unit/realtime.service.test.ts
  replay batching, serialized drain, authorization recheck, connection limit,
  backpressure, timer cleanup, maximum age, idempotent service shutdown

tests/api/realtime.api.test.ts
  authentication, Last-Event-ID validation, headers and wire framing

tests/integration/realtime-postgres.integration.test.ts
  audience filtering, ordering, transaction rollback, reservation lifecycle,
  idempotency, concurrency, permission changes

tests/integration/realtime-redis.integration.test.ts
  two service instances, real Pub/Sub wake-up, Redis outage and catch-up

tests/integration/graceful-shutdown.test.ts
  extend the existing file with live SSE closure ordering
```

Use fake timers only for pure service timing. Use real disposable PostgreSQL
and Redis for SQL visibility and Pub/Sub claims. Every opened stream, timer,
server, Redis client, Prisma client, and pool must close in `afterEach` or
`afterAll`, including failure paths, so Vitest exits without forced termination.

### AI acceptance gate

The AI is finished only when all relevant commands pass:

```powershell
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn vitest run tests/unit/realtime.service.test.ts
yarn vitest run tests/api/realtime.api.test.ts
yarn vitest run tests/integration/realtime-postgres.integration.test.ts
yarn vitest run tests/integration/realtime-redis.integration.test.ts
yarn vitest run tests/integration/graceful-shutdown.test.ts
yarn test
yarn build
```

If an exact suggested filename changes, the AI must report the actual command.
It must also summarize which tests use fakes, PostgreSQL Testcontainers, Redis
Testcontainers, or a real HTTP socket and why.

### Expected result

The test suite proves replay and failure behavior at the smallest useful level,
without moving the implementation work or design decisions into the AI step.

---

## Failure drills

### Redis absent at startup

Expected:

- the process starts when PostgreSQL is healthy;
- `/health/live` and `/health/ready` remain 200;
- a safe Redis subscriber warning is logged;
- local wake-up and heartbeat replay still deliver committed events.

### Redis stops after clients connect

Expected:

- reservation HTTP behavior remains correct;
- the local instance delivers immediately;
- other instances receive the row on their next PostgreSQL catch-up;
- no published command waits indefinitely because the ordinary Redis client
  has its existing disabled offline queue.

### PostgreSQL becomes unavailable

Expected:

- readiness becomes 503;
- new durable mutations fail without partial state;
- active streams log bounded catch-up failures and do not invent data;
- authorization recheck failure closes the affected stream safely.

### Permission changes while connected

Demote or suspend an organizer, then create another attendance change. The old
connection must not receive the restricted community row. Suspend the account;
the next heartbeat must close the stream.

### Slow client

Make the transport report backpressure. The server closes it instead of
buffering indefinitely. A reconnect with the last processed ID recovers rows
from PostgreSQL.

### Application shutdown

Expected ordering:

```text
readiness false
-> stream.closed control
-> SSE responses end
-> ordinary HTTP requests drain
-> Redis subscriber and publisher close
-> Prisma and pg pools close
```

## Common mistakes

- Treating Redis Pub/Sub as replayable storage.
- Publishing before PostgreSQL commit.
- Writing the notification row and replay row in separate transactions.
- Sending a JWT in a query string so native `EventSource` can be used.
- Checking organizer permission only when the connection opens.
- Sending every community event to every authenticated connection and relying
  on the browser to filter it.
- Converting a PostgreSQL `BIGINT` cursor to a JavaScript number.
- Assuming delivery is exactly once.
- Advancing the client cursor before the event is applied locally.
- Omitting blank lines between SSE frames.
- Using application data as heartbeat payload.
- Ignoring `response.write()` backpressure.
- Starting a timer, Redis connection, or subscription per browser connection.
- Making Redis a readiness dependency.
- Letting `server.close()` wait forever for SSE.
- Logging Authorization headers, query tokens, notification bodies, or private
  payloads.
- Using Supertest alone to claim that a never-ending response streams in real
  time.
- Adding WebSockets because the project now has a realtime module.

## Suggested commit sequence

Keep the journal, transport, integration, and tests reviewable:

1. `docs: add phase 6 sse handbook`
2. `feat: add durable realtime replay journal`
3. `feat: add authenticated sse transport and replay service`
4. `feat: append reservation notification and counter events transactionally`
5. `feat: add redis realtime wakeups and graceful stream shutdown`
6. `docs: document sse contract and client reconnection`
7. `test: prove sse replay authorization and failure behavior` (AI checkpoint)

Do not combine WebSockets, chat, Kafka, or Nginx with this increment.

## Final examination

The SSE increment is complete when you can answer these without guessing:

1. Which table owns replay, and why is Redis not sufficient?
2. Why is the replay ID a decimal string rather than a JavaScript number?
3. What transaction guarantees that a notification event never describes a
   rolled-back reservation?
4. What happens if commit succeeds and Redis publication fails?
5. How does a connected client recover a missed wake-up?
6. Why can an event be delivered more than once?
7. When may the client safely persist `Last-Event-ID`?
8. How is another user's notification excluded?
9. How does organizer demotion affect an already-open stream?
10. Why is the access token not placed in the URL?
11. What does the heartbeat prove, and what does it not prove?
12. What happens when `response.write()` returns `false`?
13. Why does the process need a dedicated Redis subscriber?
14. Why does Redis remain absent from readiness?
15. In what order are streams, HTTP requests, and dependencies closed?
16. Which behaviors required a real HTTP socket, PostgreSQL, or Redis test?
17. Why is this still a modular monolith rather than a realtime service?

## Completion commands

After the AI testing checkpoint is complete, run:

```powershell
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

The deliverable is one authenticated, replayable, one-way transport for an
existing product flow. PostgreSQL remains authoritative, Redis remains
disposable acceleration, and WebSockets remain deferred until bidirectional
chat creates a concrete need.

## Official references

- WHATWG HTML, [Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- MDN, [Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- Node.js, [`http.ServerResponse`](https://nodejs.org/api/http.html#class-httpserverresponse)
- Express, [Response API](https://expressjs.com/en/5x/api.html#res)
- PostgreSQL 17, [Transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html)
- Redis, [Pub/Sub](https://redis.io/docs/latest/develop/pubsub/)
- Node Redis, [Pub/Sub guide](https://github.com/redis/node-redis/blob/master/docs/pub-sub.md)
