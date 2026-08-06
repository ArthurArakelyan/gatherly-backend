# Phase 6 Handbook: PostgreSQL Performance and Redis

This is a build-it-yourself guide for the repository as it exists after Phase 5. It begins with query measurement and targeted PostgreSQL indexes, then adds
Redis for two concrete purposes: disposable public-event caching and shared
authentication throttling.

This is the first increment of Phase 6, not the whole advanced-infrastructure
roadmap. SSE, WebSockets, Elasticsearch, Kafka, OpenTelemetry, CI/CD, and Nginx
remain separate later increments. Redis Pub/Sub is deliberately not used as a
notification database, and no reservation invariant moves out of PostgreSQL.

## How to use this handbook

Work through one checkpoint at a time. Each checkpoint contains:

1. **Reason:** the engineering lesson.
2. **Implementation:** exact files and copy-pasteable code.
3. **Verification:** commands or tests that produce evidence.
4. **Expected result:** the condition that makes the checkpoint complete.

Code blocks labelled **complete file** replace the named file. Smaller blocks
say exactly where they belong. Preserve the completed Phase 5 work in source
control before beginning.

Do not treat every example index as mandatory. The measurement checkpoints are
a gate: create an index only when the realistic query plan shows that it solves
a measured problem. In contrast, the Redis checkpoints form one coherent
implementation and should be completed together.

## Phase outcome

At the end of this handbook, Gatherly has:

- repeatable realistic PostgreSQL data for performance experiments;
- saved `EXPLAIN (ANALYZE, BUFFERS)` evidence for important query shapes;
- only measured, documented indexes, including their write/storage cost;
- a Redis 8 service in Compose with bounded memory and no durable-data claim;
- one Node Redis client owned by the composition root;
- a cache-aside public-event detail cache with schema validation and TTL;
- atomic shared sign-up and sign-in throttling with an in-process fallback;
- startup, readiness, shutdown, integration, and outage behavior that makes
  Redis optional acceleration rather than authoritative storage.

The essential architecture is:

```text
public event GET
  -> EventsService
     -> Redis cache hit ----------------------> response
     -> Redis miss -> PostgreSQL -> cache SET -> response

sign-up/sign-in
  -> Redis fixed-window limiter (atomic Lua script)
     -> allowed -> validation -> controller -> PostgreSQL
     -> Redis unavailable -> local memory limiter -> same route

reservations / waitlists / authorization
  -> PostgreSQL exactly as before
```

Deleting every Redis key must make requests slower and reset temporary rate
limit counters; it must not delete a user, event, membership, reservation,
waitlist entry, notification, or idempotency result.

## Scope and deliberate omissions

Implement now:

- measurement of the existing public-event list/detail and reservation query
  shapes;
- an index only after the before-plan proves it is useful;
- cache-aside reads for `GET /api/events/:eventId`;
- distributed fixed-window throttling for sign-up and sign-in;
- real Redis integration tests and an outage drill.

Do not implement now:

- caching authorization, membership status, reservation capacity, waitlist
  position, or idempotency results;
- Redis locks around reservations or promotion;
- caching every paginated event-list combination;
- sessions, refresh tokens, email codes, or email delivery;
- Pub/Sub until SSE/WebSocket fan-out has a concrete consumer;
- Redis persistence as a substitute for PostgreSQL;
- Redis Cluster, Sentinel, Kubernetes, or a separate cache microservice.

The event-detail endpoint is a good first cache because it is public,
read-heavy, keyed by one stable ID, small, and tolerant of a short TTL. The
event list is a poor first cache: filters and pages create many keys, mutation
invalidation fans out, and the current dataset may not justify it.

---

## Checkpoint 1: Prove and record the Phase 5 baseline

### Reason

Performance changes are comparisons. Without a clean functional baseline, a
faster query that returns the wrong rows is not an improvement.

### Verification

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
Redis package version from yarn.lock:
test count:
baseline failures:
```

The `redis` and `@testcontainers/redis` packages are already installed and
locked. Use Yarn Classic; do not run `npm install` or create another lockfile.

### Expected result

The Phase 5 quality gate passes before a performance index or Redis dependency
is wired into application behavior.

---

## Checkpoint 2: Learn what an execution plan actually says

### Reason

PostgreSQL chooses a plan from table statistics and cost estimates. An index
that looks plausible from a Prisma query can be ignored because the table is
small, the predicate matches most rows, statistics are stale, or another index
is cheaper.

Use:

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)
SELECT ...;
```

Important fields:

- `cost=a..b` is the planner's estimate, not milliseconds;
- `actual time=a..b` and `loops` are observed execution data;
- `rows` beside the estimate and actual row count reveals estimation quality;
- `Seq Scan` is not automatically bad; it is often correct for a small table
  or a low-selectivity predicate;
- `Index Scan` reads heap rows through an index;
- `Index Only Scan` can avoid heap reads only when visibility and selected
  columns allow it;
- `Bitmap Index Scan` plus `Bitmap Heap Scan` batches many heap visits;
- `Buffers: shared hit` means pages were already in PostgreSQL's buffer cache;
- `shared read` means pages had to be read into that cache;
- `Rows Removed by Filter` can expose wasted work;
- planning time and execution time are separate.

`ANALYZE` inside `EXPLAIN` really executes the statement. Use it freely for
`SELECT`; use a transaction and `ROLLBACK` for mutation experiments. Never run
an analyzed destructive statement against important data merely to see a plan.

### Verification

Start the development database and inspect the current indexes:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up --detach postgres
docker compose exec postgres psql -U gatherly -d gatherly -c "SELECT version();"
docker compose exec postgres psql -U gatherly -d gatherly -c "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname;"
```

### Expected result

You can explain why plan choice, selectivity, estimated rows, actual rows, and
buffer activity matter more than the mere presence of an index.

---

## Checkpoint 3: Create realistic, disposable measurement data

### Reason

The deterministic development seed is designed for behavior, not planner
experiments. PostgreSQL will correctly scan a tiny table, which teaches nothing
about the query shape at realistic cardinality.

Performance data must be disposable and must not enter the normal development
seed. Use a separate database or isolated Compose project. The following SQL
creates communities and public events with varied statuses and dates while
preserving all foreign keys.

### Implementation

Open `psql` in an isolated local database after applying migrations and adding
the normal development seed. Then run this workload generator:

```sql
-- Run only in a disposable performance database.
INSERT INTO communities (
  id, name, slug, description, visibility, join_policy, status,
  created_by_user_id, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  'Performance Community ' || number,
  'performance-community-' || number,
  'Disposable Phase 6 measurement data',
  'PUBLIC',
  'OPEN',
  CASE WHEN number % 25 = 0 THEN 'ARCHIVED' ELSE 'ACTIVE' END,
  '00000000-0000-4000-8000-000000000001'::uuid,
  now() - make_interval(days => number % 365),
  now()
FROM generate_series(1, 500) AS series(number);

INSERT INTO events (
  id, community_id, created_by_user_id, title, slug, description,
  format, status, visibility, starts_at, ends_at, timezone, capacity,
  created_at, updated_at
)
SELECT
  gen_random_uuid(),
  community.id,
  community.created_by_user_id,
  'Performance Event ' || event_number,
  'performance-event-' || event_number,
  repeat('Measured event description. ', 4),
  CASE event_number % 3
    WHEN 0 THEN 'IN_PERSON'
    WHEN 1 THEN 'ONLINE'
    ELSE 'HYBRID'
  END,
  CASE
    WHEN event_number % 20 = 0 THEN 'CANCELLED'
    WHEN event_number % 17 = 0 THEN 'COMPLETED'
    ELSE 'PUBLISHED'
  END,
  CASE WHEN event_number % 10 = 0 THEN 'COMMUNITY_ONLY' ELSE 'PUBLIC' END,
  now() + make_interval(hours => event_number - 25000),
  now() + make_interval(hours => event_number - 24998),
  'Europe/Moscow',
  10 + event_number % 90,
  now() - make_interval(days => event_number % 365),
  now()
FROM generate_series(1, 50000) AS series(event_number)
CROSS JOIN LATERAL (
  SELECT id, created_by_user_id
  FROM communities
  WHERE slug = 'performance-community-' || ((event_number - 1) % 500 + 1)
) AS community;

ANALYZE communities;
ANALYZE events;
```

Verify cardinality and distribution:

```sql
SELECT count(*) FROM communities;
SELECT status, visibility, count(*)
FROM events
GROUP BY status, visibility
ORDER BY status, visibility;
```

The UUID used as `created_by_user_id` is Alice's deterministic seed ID. If that
seed is not present in the disposable database, seed it first rather than
disabling the foreign key.

### Expected result

The measurement database contains roughly 50,000 varied events, statistics
are current, and no normal test or development database was polluted.

---

## Checkpoint 4: Capture the public-event query plans before indexing

### Reason

The application currently has two important public read shapes:

- detail by event ID, public visibility, visible status, and active community;
- filtered list ordered by `starts_at ASC, id ASC`.

Measure the SQL shape, not an imagined simplified query. Prisma can log the
generated query temporarily, but the reviewed SQL below expresses the same
predicates clearly enough for a focused experiment.

### Verification

Choose an active community ID and a public event ID from the disposable data,
then run:

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)
SELECT
  e.id, e.community_id, e.created_by_user_id, e.title, e.slug,
  e.description, e.format, e.status, e.visibility, e.starts_at,
  e.ends_at, e.timezone, e.capacity, e.created_at, e.updated_at
FROM events AS e
JOIN communities AS c ON c.id = e.community_id
WHERE e.id = '<event-id>'::uuid
  AND e.visibility = 'PUBLIC'
  AND e.status IN ('PUBLISHED', 'CANCELLED', 'COMPLETED')
  AND c.status = 'ACTIVE';

EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)
SELECT
  e.id, e.community_id, e.created_by_user_id, e.title, e.slug,
  e.description, e.format, e.status, e.visibility, e.starts_at,
  e.ends_at, e.timezone, e.capacity, e.created_at, e.updated_at
FROM events AS e
JOIN communities AS c ON c.id = e.community_id
WHERE e.visibility = 'PUBLIC'
  AND e.status IN ('PUBLISHED', 'CANCELLED', 'COMPLETED')
  AND c.status = 'ACTIVE'
  AND e.community_id = '<community-id>'::uuid
  AND e.starts_at >= now()
ORDER BY e.starts_at ASC, e.id ASC
LIMIT 20 OFFSET 0;
```

Run each plan several times. Save the SQL, parameters, row counts, plan text,
PostgreSQL version, warm/cold condition, and median result. Do not report only
the fastest run.

For the count query used by page-number pagination, measure separately:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*)
FROM events AS e
JOIN communities AS c ON c.id = e.community_id
WHERE e.visibility = 'PUBLIC'
  AND e.status IN ('PUBLISHED', 'CANCELLED', 'COMPLETED')
  AND c.status = 'ACTIVE'
  AND e.community_id = '<community-id>'::uuid
  AND e.starts_at >= now();
```

Also inspect, but do not redesign casually, the correctness-critical
reservation shapes from `reservations.repository.ts`:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*)::integer
FROM reservations
WHERE event_id = '<event-id>'::uuid AND status = 'CONFIRMED';

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, user_id
FROM waitlist_entries
WHERE event_id = '<event-id>'::uuid AND status = 'WAITING'
ORDER BY joined_at ASC, id ASC
LIMIT 1;
```

The existing `reservations_event_status_idx` and
`waitlist_entries_event_order_idx` were created for these shapes. Confirm that
realistic per-event cardinality uses them. The production query adds
`FOR UPDATE`; omit it for the read-only plan inspection unless you deliberately
run inside a transaction and understand the lock. Any index/query change on
this path must rerun the final-place race and concurrent promotion tests; a
lower execution time cannot compensate for broken locking semantics.

### Expected result

You have before-plans for event detail, list/count, reservation count, and
waitlist head selection. The detail query should normally use the primary key.
The plans identify whether an index, query change, or no change is justified,
without weakening transaction/lock correctness.

---

## Checkpoint 5: Add one index only if the plan earns it

### Reason

An index accelerates selected reads by adding storage, cache pressure, migration
time, and work to every relevant insert/update/delete. Gatherly's rule is to
document both sides.

For the measured community-filtered public-event query, a plausible candidate
is:

```text
(community_id, visibility, starts_at, id, status)
```

It is not automatically the right index. The low-selectivity
`status IN (...)` predicate, data distribution, and the sort can change planner
choices. Keeping `starts_at, id` together after the equality columns gives
PostgreSQL a path matching the requested order; trailing `status` can be
checked from the index. The existing
`events_status_starts_idx(status, starts_at, id)` may already be sufficient for
some filters.

### Implementation

If and only if the before-plan shows material wasted work, add this line to the
`Event` model in `prisma/schema.prisma`:

```prisma
@@index([communityId, visibility, startsAt, id, status], map: "events_public_community_starts_idx")
```

Generate a reviewable migration:

```powershell
yarn prisma migrate dev --name add_measured_public_event_index --create-only
```

Review the generated SQL. For the current learning/local deployment it should
contain only:

```sql
CREATE INDEX "events_public_community_starts_idx"
ON "events"("community_id", "visibility", "starts_at", "id", "status");
```

Apply it, refresh statistics, and repeat the exact before query:

```powershell
yarn db:migrate:dev
docker compose exec postgres psql -U gatherly -d gatherly -c "ANALYZE events;"
```

Do not casually rewrite this Prisma migration to `CREATE INDEX CONCURRENTLY`.
Concurrent index creation cannot run inside a transaction, while migration
tools often wrap migration SQL. A future large deployed database needs a
separately designed online-index procedure, failure recovery for invalid
indexes, and deployment coordination. This pet/local stage can use the normal
reviewed migration during a maintenance window.

Document the result next to your performance notes:

```text
query and parameters:
rows/table distribution:
before plan and median execution time:
after plan and median execution time:
shared hit/read buffers before and after:
index size from pg_relation_size:
write path affected:
decision: keep or remove
```

Inspect size and usage:

```sql
SELECT
  indexrelname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS size,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE relname = 'events'
ORDER BY indexrelname;
```

If the index does not materially improve the measured query, remove the schema
line and discard the unapplied migration, or create a forward migration to
drop it if it has already been shared/applied. Never edit an applied shared
migration's history.

### Expected result

Every retained index has before/after evidence and an explicit write/storage
cost. No index is retained merely because its columns look reasonable.

---

## Checkpoint 6: Measure pagination before caching it

### Reason

The current event list uses `OFFSET` plus a total `COUNT`. Deep pages make
PostgreSQL walk and discard earlier rows, and count work remains even when only
20 rows are returned. Redis does not repair this query model.

### Verification

Compare the same list query using `OFFSET 0`, `OFFSET 1000`, and a deep offset.
Then compare a keyset form:

```sql
SELECT
  e.id, e.community_id, e.title, e.starts_at
FROM events AS e
JOIN communities AS c ON c.id = e.community_id
WHERE e.visibility = 'PUBLIC'
  AND e.status IN ('PUBLISHED', 'CANCELLED', 'COMPLETED')
  AND c.status = 'ACTIVE'
  AND (e.starts_at, e.id) > ('<cursor-starts-at>'::timestamptz, '<cursor-id>'::uuid)
ORDER BY e.starts_at ASC, e.id ASC
LIMIT 20;
```

Do not change the API contract in this handbook unless the measurement proves
deep pagination is a real requirement. If it does, keyset pagination should be
a documented API change with validation and OpenAPI updates, not a hidden
repository optimization.

### Expected result

You can distinguish a database/query-model problem from a cache use case. The
first Redis implementation remains event detail, not a combinatorial list
cache.

---

## Checkpoint 7: Define Redis ownership and failure semantics

### Reason

Before code, classify every proposed key:

| Key                             | Source of truth                   |    TTL | Loss behavior                               |
| ------------------------------- | --------------------------------- | -----: | ------------------------------------------- |
| `gatherly:v1:event:{id}`        | PostgreSQL `events`/`communities` |   60 s | next read reloads PostgreSQL                |
| `gatherly:v1:rate:sign-in:{ip}` | temporary attempt counter         |  900 s | counter resets; local fallback still limits |
| `gatherly:v1:rate:sign-up:{ip}` | temporary attempt counter         | 3600 s | counter resets; local fallback still limits |

Do not put passwords, JWTs, authorization headers, private messages, or full
request bodies in keys or values. IP-derived rate-limit keys are operational
data; give them TTLs and never log the raw key.

The prefix contains an application name and schema version. If the serialized
event shape changes incompatibly, increment `v1` and let old keys expire. Do
not run `KEYS *` followed by mass deletion in request handling.

Redis availability is not part of `/health/ready` in this increment. The app
can serve authoritative reads and writes through PostgreSQL without Redis.
Expose/cache metrics later in the observability increment; for now, safe logs
and tests demonstrate degradation.

### Expected result

Every key has a bounded lifetime, a named PostgreSQL or transient owner, and a
safe answer to “what happens if Redis is flushed?”

---

## Checkpoint 8: Add Redis to Compose as disposable infrastructure

### Reason

The container configuration should make the ownership decision visible. This
Redis service has no named volume and disables RDB/AOF persistence. A restart
may lose everything, by design.

`noeviction` is chosen instead of an eviction policy that might silently drop
rate-limit counters under memory pressure. When the bounded instance is full,
cache writes and limiter scripts fail visibly; application code then skips the
cache and uses the local limiter fallback.

### Implementation

Add this service after `postgres` in `compose.yaml`:

```yaml
redis:
  image: redis:8.2-bookworm
  command:
    [
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
      '--maxmemory',
      '128mb',
      '--maxmemory-policy',
      'noeviction',
    ]
  ports:
    - '127.0.0.1:${REDIS_PORT:-6379}:6379'
  healthcheck:
    test: ['CMD', 'redis-cli', 'ping']
    interval: 5s
    timeout: 3s
    retries: 10
    start_period: 5s
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL
  read_only: true
  tmpfs:
    - /data:size=16m,mode=0700
  pids_limit: 50
  mem_limit: 192m
```

Add these variables to the `app.environment` map:

```yaml
REDIS_URL: redis://redis:6379
REDIS_CONNECT_TIMEOUT_MS: ${REDIS_CONNECT_TIMEOUT_MS:-1000}
EVENT_CACHE_TTL_SECONDS: ${EVENT_CACHE_TTL_SECONDS:-60}
```

Do **not** add Redis to the migration service. Prisma migrations need
PostgreSQL, not Redis. Do **not** make app startup wait for
`condition: service_healthy` on Redis. Redis is an optional accelerator, so a
Redis startup failure must not block the authoritative API.

Add host-development values to `.env.example`:

```dotenv
REDIS_PORT=6379
REDIS_URL=redis://127.0.0.1:6379
REDIS_CONNECT_TIMEOUT_MS=1000
EVENT_CACHE_TTL_SECONDS=60
```

The Compose `app` overrides the host URL with the service hostname `redis`.
Host-run `yarn dev` uses `127.0.0.1`. Never use `localhost` from one container
to reach another container.

### Verification

```powershell
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose -f compose.yaml -f compose.dev.yaml up --detach redis
docker compose -f compose.yaml -f compose.dev.yaml ps redis
docker compose -f compose.yaml -f compose.dev.yaml exec redis redis-cli PING
docker compose -f compose.yaml -f compose.dev.yaml exec redis redis-cli CONFIG GET appendonly
docker compose -f compose.yaml -f compose.dev.yaml exec redis redis-cli CONFIG GET maxmemory-policy
```

### Expected result

`PING` returns `PONG`, persistence is off, policy is `noeviction`, and
`docker volume ls` shows no new Redis data volume.

---

## Checkpoint 9: Validate Redis configuration

### Reason

Configuration is an untrusted process boundary. A misspelled URL or negative
TTL should fail at startup rather than create unpredictable cache behavior.

### Implementation

Add these fields to the object in `src/config/env.ts`:

```ts
  REDIS_URL: z.url().refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol), {
    message: 'REDIS_URL must use redis:// or rediss://',
  }),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(1_000),
  EVENT_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
```

Do not give `REDIS_URL` a source-code default. `.env.example`, Compose, and the
deployment environment must make the dependency explicit. The test application
constructs its dependencies directly and therefore does not need to parse the
real process environment.

Add tests beside the existing environment-parser tests, or create
`tests/unit/env.test.ts` with a valid base environment and these assertions:

```ts
import { describe, expect, it } from 'vitest';

import { parseEnvironment } from '../../src/config/env.js';

const validEnvironment = {
  NODE_ENV: 'test',
  PGHOST: '127.0.0.1',
  PGDATABASE: 'gatherly',
  PGUSER: 'gatherly',
  PGPASSWORD: 'test-password',
  DATABASE_URL: 'postgresql://gatherly:test-password@127.0.0.1:5432/gatherly',
  JWT_SECRET: 'test-only-jwt-secret-that-is-long-enough',
  REDIS_URL: 'redis://127.0.0.1:6379',
};

describe('environment', () => {
  it('parses bounded Redis defaults', () => {
    const parsed = parseEnvironment(validEnvironment);
    expect(parsed.REDIS_CONNECT_TIMEOUT_MS).toBe(1_000);
    expect(parsed.EVENT_CACHE_TTL_SECONDS).toBe(60);
  });

  it('rejects a non-Redis URL', () => {
    expect(() =>
      parseEnvironment({ ...validEnvironment, REDIS_URL: 'https://example.com' }),
    ).toThrow();
  });
});
```

### Verification

```powershell
yarn vitest run tests/unit/env.test.ts
yarn typecheck
```

### Expected result

Only `redis://` and `rediss://` URLs are accepted, and both connection timeout
and cache TTL have conservative bounds.

---

## Checkpoint 10: Create one Redis client and own its lifecycle

### Reason

Like the PostgreSQL pool and Prisma client, the Redis client belongs in the
composition root. Creating a client in each repository or request would waste
connections, duplicate event listeners, and make shutdown unreliable.

Node Redis requires an `error` listener; without one, an emitted error can
terminate the process. Commands also need a readiness check and an offline
queue policy. Gatherly disables the offline queue because stale cache commands
should not accumulate while Redis is disconnected.

### Implementation

Create `src/infrastructure/redis/client.ts` with this **complete file**:

```ts
import type { Logger } from 'pino';
import { createClient } from 'redis';

export type GatherlyRedisClient = ReturnType<typeof createClient>;

interface RedisClientConfiguration {
  REDIS_URL: string;
  REDIS_CONNECT_TIMEOUT_MS: number;
}

export const createRedisClient = (
  configuration: RedisClientConfiguration,
  logger: Logger,
): GatherlyRedisClient => {
  const client = createClient({
    url: configuration.REDIS_URL,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: configuration.REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 3_000),
    },
  });

  client.on('error', (error) => {
    logger.warn({ err: error }, 'Redis client error; disposable features are degraded');
  });
  client.on('ready', () => {
    logger.info('Redis client ready');
  });
  client.on('reconnecting', () => {
    logger.warn('Redis client reconnecting');
  });

  return client;
};

export const startRedisClient = (client: GatherlyRedisClient, logger: Logger): void => {
  void client.connect().catch((error: unknown) => {
    logger.warn({ err: error }, 'Initial Redis connection failed; continuing without Redis');
  });
};

export const closeRedisClient = async (client: GatherlyRedisClient): Promise<void> => {
  if (client.isOpen) await client.close();
};
```

`startRedisClient` intentionally does not delay HTTP startup. The connection
continues in the background and Node Redis reconnects after an established
connection is interrupted. `disableOfflineQueue` ensures application commands
fail promptly during that interval; adapters catch those failures and degrade.

Never log `REDIS_URL`. A deployed URL can contain a username/password. The
error logger records the error object but no explicit connection string.

### Verification

```powershell
yarn typecheck
yarn lint
```

### Expected result

There is one reusable client factory, it always has an error listener, command
queueing while offline is disabled, and shutdown has one explicit close path.

---

## Checkpoint 11: Define a module-owned event cache port

### Reason

`EventsService` should know that it can load/store cached `Event` values, but
it should not know Node Redis commands or serialization. That keeps domain
logic independently testable and prevents infrastructure types from spreading
through the module.

### Implementation

Create `src/modules/events/events.cache.ts` with this **complete file**:

```ts
import type { Event } from './events.types.js';

export interface EventCache {
  get(eventId: string): Promise<Event | null>;
  set(event: Event): Promise<void>;
  delete(eventId: string): Promise<void>;
}

export class NoopEventCache implements EventCache {
  public get(_eventId: string): Promise<null> {
    return Promise.resolve(null);
  }

  public set(_event: Event): Promise<void> {
    return Promise.resolve();
  }

  public delete(_eventId: string): Promise<void> {
    return Promise.resolve();
  }
}
```

The no-op implementation is useful for unit/API tests that are not about
Redis. Tests should not need a Redis container merely because an optional cache
port exists.

### Expected result

The events module owns a small technology-neutral interface; no Redis import
appears in `events.service.ts`, controllers, routes, or domain types.

---

## Checkpoint 12: Implement a validated Redis event cache

### Reason

Redis values are serialized bytes, not trusted `Event` objects. Dates become
strings, old deployments may leave incompatible values, and developers can
manually corrupt a key. Validate on read just like any other external boundary.

Cache failures must never replace a successful PostgreSQL response with a 500.
The adapter therefore logs and returns a miss on read failure, and logs/ignores
write/delete failure.

### Implementation

Create `src/infrastructure/redis/redis-event-cache.ts` with this **complete
file**:

```ts
import type { Logger } from 'pino';
import { z } from 'zod';

import type { EventCache } from '../../modules/events/events.cache.js';
import type { Event } from '../../modules/events/events.types.js';
import type { GatherlyRedisClient } from './client.js';

const cachedEventSchema = z.object({
  id: z.uuid(),
  communityId: z.uuid(),
  createdByUserId: z.uuid(),
  title: z.string(),
  slug: z.string(),
  description: z.string(),
  format: z.enum(['IN_PERSON', 'ONLINE', 'HYBRID']),
  status: z.string(),
  visibility: z.enum(['PUBLIC', 'COMMUNITY_ONLY', 'INVITE_ONLY']),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  timezone: z.string(),
  capacity: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

type CachedEvent = z.infer<typeof cachedEventSchema>;

const keyFor = (eventId: string): string => `gatherly:v1:event:${eventId}`;

const serialize = (event: Event): CachedEvent => ({
  ...event,
  startsAt: event.startsAt.toISOString(),
  endsAt: event.endsAt.toISOString(),
  createdAt: event.createdAt.toISOString(),
  updatedAt: event.updatedAt.toISOString(),
});

const deserialize = (event: CachedEvent): Event => ({
  ...event,
  startsAt: new Date(event.startsAt),
  endsAt: new Date(event.endsAt),
  createdAt: new Date(event.createdAt),
  updatedAt: new Date(event.updatedAt),
});

export class RedisEventCache implements EventCache {
  public constructor(
    private readonly client: GatherlyRedisClient,
    private readonly ttlSeconds: number,
    private readonly logger: Logger,
  ) {}

  public async get(eventId: string): Promise<Event | null> {
    if (!this.client.isReady) return null;

    const key = keyFor(eventId);
    try {
      const value = await this.client.get(key);
      if (value === null) return null;

      const parsedJson: unknown = JSON.parse(value);
      const parsedEvent = cachedEventSchema.safeParse(parsedJson);
      if (!parsedEvent.success) {
        this.logger.warn({ eventId }, 'Discarding invalid cached event');
        await this.client.del(key);
        return null;
      }

      return deserialize(parsedEvent.data);
    } catch (error) {
      this.logger.warn({ err: error, eventId }, 'Redis event-cache read failed');
      if (error instanceof SyntaxError) await this.delete(eventId);
      return null;
    }
  }

  public async set(event: Event): Promise<void> {
    if (!this.client.isReady) return;

    try {
      await this.client.set(keyFor(event.id), JSON.stringify(serialize(event)), {
        EX: this.ttlSeconds,
      });
    } catch (error) {
      this.logger.warn({ err: error, eventId: event.id }, 'Redis event-cache write failed');
    }
  }

  public async delete(eventId: string): Promise<void> {
    if (!this.client.isReady) return;

    try {
      await this.client.del(keyFor(eventId));
    } catch (error) {
      this.logger.warn({ err: error, eventId }, 'Redis event-cache deletion failed');
    }
  }
}
```

Do not cache not-found responses in the first implementation. Negative caching
can reduce repeated probes, but it also introduces a new stale-not-found case
and needs a deliberately short TTL.

### Verification

```powershell
yarn typecheck
yarn lint
```

### Expected result

Cache data is versioned, bounded by TTL, parsed through Zod, restored to real
`Date` objects, and incapable of turning a Redis fault into a failed event
detail request.

---

## Checkpoint 13: Use cache-aside in `EventsService`

### Reason

Cache-aside keeps PostgreSQL as the loader:

1. ask Redis for the event;
2. on a hit, return it;
3. on a miss/failure, query PostgreSQL;
4. cache only the successful public event;
5. return the PostgreSQL result even if cache population fails.

The repository remains unaware of caching. The service owns the use-case
decision because it knows which result is safe to cache.

### Implementation

Add this import to `src/modules/events/events.service.ts`:

```ts
import type { EventCache } from './events.cache.js';
```

Replace the constructor with:

```ts
  public constructor(
    private readonly repository: EventsRepository,
    private readonly cache: EventCache,
  ) {}
```

Replace `get` with:

```ts
  public async get(eventId: string): Promise<Event> {
    const cachedEvent = await this.cache.get(eventId);
    if (cachedEvent !== null) return cachedEvent;

    const event = await this.repository.findPublicById(eventId);
    if (event === null) {
      throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
    }

    await this.cache.set(event);
    return event;
  }
```

Update every existing construction of `EventsService` outside `server.ts` to
pass `new NoopEventCache()`. Import it from `events.cache.ts`. This includes
`tests/helpers/test-app.ts` and direct unit-test construction.

When an event update/cancel/archive endpoint is later implemented, write
PostgreSQL first and then invalidate:

```ts
const updated = await this.repository.updateAuthorized(...);
await this.cache.delete(updated.id);
return updated;
```

Never delete the cache before a database transaction commits. If the database
write fails, the old cache value is still valid. If post-commit invalidation
fails, the short TTL bounds staleness; later observability should count that
failure.

Do not use this cache result for reservation capacity or authorization. An
event-detail response being briefly stale is tolerable; granting a suspended
member access or overbooking is not.

### Verification

Add these cases to `tests/unit/events.service.test.ts` using small fakes:

```ts
it('returns a cached public event without querying PostgreSQL', async () => {
  const event = makeEvent();
  const repository = {
    findPublicById: vi.fn(),
  };
  const cache = {
    get: vi.fn().mockResolvedValue(event),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const service = new EventsService(repository as unknown as EventsRepository, cache);

  await expect(service.get(event.id)).resolves.toEqual(event);
  expect(repository.findPublicById).not.toHaveBeenCalled();
  expect(cache.set).not.toHaveBeenCalled();
});

it('loads a cache miss from PostgreSQL and populates Redis', async () => {
  const event = makeEvent();
  const repository = {
    findPublicById: vi.fn().mockResolvedValue(event),
  };
  const cache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(),
  };
  const service = new EventsService(repository as unknown as EventsRepository, cache);

  await expect(service.get(event.id)).resolves.toEqual(event);
  expect(repository.findPublicById).toHaveBeenCalledWith(event.id);
  expect(cache.set).toHaveBeenCalledWith(event);
});
```

Use the existing event fixture/helper shape in this test file rather than
creating a second inconsistent domain object merely to copy the snippet.

### Expected result

A cache hit avoids PostgreSQL, a miss loads and populates, and the service has
no Redis imports.

---

## Checkpoint 14: Build an atomic Redis fixed-window limiter

### Reason

The Phase 4 limiter stores counters in one Node process. Two replicas would
each allow the full limit. Redis gives them a shared counter, but `INCR`
followed by `EXPIRE` as separate application calls has a failure window: a
process can stop after incrementing and leave a key without TTL.

A Lua script runs atomically inside Redis. It increments, attaches expiry only
to the first count, reads the remaining TTL, and returns one result.

This limiter protects temporary abuse counters; it does not authorize users
and it does not own account state.

### Implementation

Create `src/shared/rate-limit/fixed-window-rate-limiter.ts` with this
**complete file**:

```ts
export interface FixedWindowResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterSeconds: number;
}

export interface FixedWindowRateLimiter {
  consume(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<FixedWindowResult | null>;
}
```

Create `src/infrastructure/redis/redis-fixed-window-rate-limiter.ts` with this
**complete file**:

```ts
import { createHash } from 'node:crypto';

import type { Logger } from 'pino';

import type {
  FixedWindowRateLimiter,
  FixedWindowResult,
} from '../../shared/rate-limit/fixed-window-rate-limiter.js';
import type { GatherlyRedisClient } from './client.js';

const consumeScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { current, ttl }
`;

const hashSubject = (subject: string): string => createHash('sha256').update(subject).digest('hex');

export class RedisFixedWindowRateLimiter implements FixedWindowRateLimiter {
  public constructor(
    private readonly client: GatherlyRedisClient,
    private readonly logger: Logger,
  ) {}

  public async consume(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<FixedWindowResult | null> {
    if (!this.client.isReady) return null;

    const key = `gatherly:v1:rate:${scope}:${hashSubject(subject)}`;
    try {
      const reply: unknown = await this.client.eval(consumeScript, {
        keys: [key],
        arguments: [windowSeconds.toString()],
      });
      if (!Array.isArray(reply) || reply.length !== 2) {
        throw new Error('Unexpected Redis limiter reply');
      }

      const count = Number(reply[0]);
      const ttl = Number(reply[1]);
      if (!Number.isInteger(count) || !Number.isInteger(ttl) || ttl < 0) {
        throw new Error('Invalid Redis limiter reply');
      }

      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetAfterSeconds: ttl,
      };
    } catch (error) {
      this.logger.warn({ err: error, scope }, 'Redis rate limiter failed');
      return null;
    }
  }
}
```

The subject is hashed so raw IP text does not appear in Redis keys. The hash is
not encryption or anonymization against brute force; the TTL and operational
access controls still matter.

Fixed windows allow bursts around a boundary (for example, ten requests at the
end of one window and ten at the start of the next). That is acceptable for
this learning phase. A sliding-window log/token bucket is more precise but
costs more state and complexity.

### Expected result

One atomic Redis operation increments and expires a shared counter. Any
connection, script, reply-shape, or memory error produces `null`, signaling the
caller to use a safe fallback.

---

## Checkpoint 15: Adapt the limiter to Express with a local fallback

### Reason

Redis being optional must not mean “unlimited sign-in attempts whenever Redis
is down.” Retain an in-process limiter as a fallback. It is weaker across
multiple replicas, but it preserves a local safety boundary and keeps the API
available.

### Implementation

Create `src/shared/rate-limit/rate-limit.middleware.ts` with this **complete
file**:

```ts
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { AppError } from '../errors/app-error.js';
import type { FixedWindowRateLimiter } from './fixed-window-rate-limiter.js';

export interface RateLimitPolicy {
  scope: string;
  windowMs: number;
  limit: number;
  errorCode: string;
  errorMessage: string;
}

export const createLocalRateLimit = (policy: RateLimitPolicy): RequestHandler =>
  rateLimit({
    windowMs: policy.windowMs,
    limit: policy.limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, _response, next) => {
      next(new AppError(429, policy.errorCode, policy.errorMessage));
    },
  });

export const createDistributedRateLimit = (
  limiter: FixedWindowRateLimiter,
  policy: RateLimitPolicy,
): RequestHandler => {
  const localFallback = createLocalRateLimit(policy);

  return async (request, response, next) => {
    const result = await limiter.consume(
      policy.scope,
      request.ip,
      policy.limit,
      Math.ceil(policy.windowMs / 1_000),
    );

    if (result === null) {
      localFallback(request, response, next);
      return;
    }

    response.setHeader('RateLimit-Limit', result.limit.toString());
    response.setHeader('RateLimit-Remaining', result.remaining.toString());
    response.setHeader('RateLimit-Reset', result.resetAfterSeconds.toString());

    if (!result.allowed) {
      next(new AppError(429, policy.errorCode, policy.errorMessage));
      return;
    }

    next();
  };
};
```

In `src/modules/identity/identity.routes.ts`, remove the direct
`express-rate-limit` and `AppError` imports. Add this exported interface:

```ts
export interface IdentityRateLimiters {
  signUp: RequestHandler;
  signIn: RequestHandler;
}
```

Change the router factory signature to:

```ts
export const createIdentityRouter = (
  controller: IdentityController,
  requireAuthenticatedUser: RequestHandler,
  rateLimiters: IdentityRateLimiters,
): Router => {
```

Delete the two limiter definitions inside the factory and wire the provided
middleware:

```ts
router.post('/sign-up', rateLimiters.signUp, validate(signUpRequestSchema), controller.signUp);
router.post('/sign-in', rateLimiters.signIn, validate(signInRequestSchema), controller.signIn);
```

For tests that do not target distributed throttling, provide a limiter fake
whose `consume` resolves to an allowed result, or build ordinary local
middleware with the same policies. Keep the existing Phase 4 API tests for 429
error codes; update their composition, not their behavioral expectation.

Define policies once in `src/modules/identity/identity.rate-limits.ts`:

```ts
import type { RateLimitPolicy } from '../../shared/rate-limit/rate-limit.middleware.js';

export const signInRateLimitPolicy: RateLimitPolicy = {
  scope: 'sign-in',
  windowMs: 15 * 60 * 1_000,
  limit: 10,
  errorCode: 'SIGN_IN_RATE_LIMITED',
  errorMessage: 'Try signing in again later',
};

export const signUpRateLimitPolicy: RateLimitPolicy = {
  scope: 'sign-up',
  windowMs: 60 * 60 * 1_000,
  limit: 5,
  errorCode: 'SIGN_UP_RATE_LIMITED',
  errorMessage: 'Try creating an account again later',
};
```

Proxy warning: `request.ip` is correct only when Express's `trust proxy`
setting matches the actual deployment topology. Do not set `trust proxy` to
`true` during local development just to make headers convenient. When Nginx is
introduced, configure one trusted proxy hop and add spoofed
`X-Forwarded-For` tests.

### Verification

```powershell
yarn typecheck
yarn lint
yarn vitest run tests/api/identity.api.test.ts
```

### Expected result

Normal operation shares a Redis counter across processes. Redis failure uses
the original in-memory safety boundary and returns the same stable 429 error
contract when that fallback limit is exceeded.

---

## Checkpoint 16: Wire Redis in the composition root

### Reason

`server.ts` is where concrete infrastructure is chosen. It should create one
client, start its connection, inject Redis adapters into services/middleware,
and close it during the existing bounded shutdown sequence.

Redis must not be added to the authoritative readiness query. A Redis warning
is degradation; PostgreSQL failure is not-ready.

### Implementation

Add these imports to `src/server.ts`:

```ts
import {
  closeRedisClient,
  createRedisClient,
  startRedisClient,
} from './infrastructure/redis/client.js';
import { RedisEventCache } from './infrastructure/redis/redis-event-cache.js';
import { RedisFixedWindowRateLimiter } from './infrastructure/redis/redis-fixed-window-rate-limiter.js';
import {
  signInRateLimitPolicy,
  signUpRateLimitPolicy,
} from './modules/identity/identity.rate-limits.js';
import { createDistributedRateLimit } from './shared/rate-limit/rate-limit.middleware.js';
```

After creating `logger`, `pool`, and `prisma`, create/start Redis:

```ts
const redis = createRedisClient(environment, logger);
startRedisClient(redis, logger);
```

Construct the event service with the concrete cache:

```ts
const eventsRepository = new EventsRepository(prisma);
const eventCache = new RedisEventCache(redis, environment.EVENT_CACHE_TTL_SECONDS, logger);
const eventsService = new EventsService(eventsRepository, eventCache);
```

Before constructing the identity router, create the limiter and middleware:

```ts
const fixedWindowRateLimiter = new RedisFixedWindowRateLimiter(redis, logger);
const identityRateLimiters = {
  signIn: createDistributedRateLimit(fixedWindowRateLimiter, signInRateLimitPolicy),
  signUp: createDistributedRateLimit(fixedWindowRateLimiter, signUpRateLimitPolicy),
};
```

Pass it as the third router-factory argument:

```ts
const identityRouter = createIdentityRouter(
  new IdentityController(identityService),
  requireAuthenticatedUser,
  identityRateLimiters,
);
```

Keep readiness authoritative and unchanged in meaning:

```ts
const checkReadiness = async (): Promise<boolean> => {
  if (shutdownState.started) return false;

  try {
    await Promise.all([pool.query('SELECT 1'), prisma.$queryRaw`SELECT 1`]);
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'PostgreSQL readiness check failed');
    return false;
  }
};
```

Finally extend shutdown dependency closure:

```ts
  closeDependencies: async () => {
    await Promise.all([
      closeRedisClient(redis),
      prisma.$disconnect(),
      pool.end(),
    ]);
  },
```

`closeRedisClient` is safe when Redis never connected. Keeping it in the same
bounded shutdown coordinator prevents reconnect timers or open sockets from
holding the process alive.

In `tests/helpers/test-app.ts`, import `NoopEventCache` and construct:

```ts
new EventsService(new EventsRepository(prisma), new NoopEventCache());
```

For identity routes in API tests, preserve the exact Phase 4 behavior with a
fresh local limiter each time `createTestApp` is called:

```ts
const testIdentityRateLimiters = {
  signIn: createLocalRateLimit(signInRateLimitPolicy),
  signUp: createLocalRateLimit(signUpRateLimitPolicy),
};
```

Pass `testIdentityRateLimiters` to `createIdentityRouter`. Because
`tests/api/identity.api.test.ts` creates a new app in `beforeEach`, counters do
not leak between tests, while its five/ten-attempt 429 assertions remain
unchanged. Do not weaken or delete those behavioral assertions to simplify
composition.

### Verification

```powershell
yarn typecheck
yarn lint
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

### Expected result

The process has one Redis client. PostgreSQL remains the only readiness
dependency, and graceful shutdown closes Redis, Prisma, and the raw pg pool.

---

## Checkpoint 17: Test Redis with a real disposable container

### Reason

A mocked `get`/`set` cannot prove TTL, Lua atomicity, serialization, malformed
value cleanup, or client/server compatibility. Use the already-installed Redis
Testcontainers module.

### Implementation

Create `tests/helpers/redis.ts` with this **complete file**:

```ts
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import pino from 'pino';

import {
  closeRedisClient,
  createRedisClient,
  type GatherlyRedisClient,
} from '../../src/infrastructure/redis/client.js';

export interface RedisHarness {
  client: GatherlyRedisClient;
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

export const startRedisHarness = async (): Promise<RedisHarness> => {
  const container: StartedRedisContainer = await new RedisContainer('redis:8.2-bookworm').start();
  const client = createRedisClient(
    {
      REDIS_URL: container.getConnectionUrl(),
      REDIS_CONNECT_TIMEOUT_MS: 1_000,
    },
    pino({ enabled: false }),
  );
  await client.connect();

  return {
    client,
    reset: async () => {
      await client.flushDb();
    },
    stop: async () => {
      await closeRedisClient(client);
      await container.stop();
    },
  };
};
```

Create `tests/integration/redis.integration.test.ts` with this **complete
file**. Adapt only the `event` values if the domain type has changed by the
time this checkpoint is reached.

```ts
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RedisEventCache } from '../../src/infrastructure/redis/redis-event-cache.js';
import { RedisFixedWindowRateLimiter } from '../../src/infrastructure/redis/redis-fixed-window-rate-limiter.js';
import type { Event } from '../../src/modules/events/events.types.js';
import { type RedisHarness, startRedisHarness } from '../helpers/redis.js';

const event: Event = {
  id: '10000000-0000-4000-8000-000000000001',
  communityId: '20000000-0000-4000-8000-000000000001',
  createdByUserId: '30000000-0000-4000-8000-000000000001',
  title: 'Cached board games',
  slug: 'cached-board-games',
  description: 'A disposable cache value',
  format: 'IN_PERSON',
  status: 'PUBLISHED',
  visibility: 'PUBLIC',
  startsAt: new Date('2030-08-03T18:00:00.000Z'),
  endsAt: new Date('2030-08-03T21:00:00.000Z'),
  timezone: 'Europe/Moscow',
  capacity: 10,
  createdAt: new Date('2026-08-07T00:00:00.000Z'),
  updatedAt: new Date('2026-08-07T00:00:00.000Z'),
};

describe('Redis infrastructure', () => {
  let harness: RedisHarness;

  beforeAll(async () => {
    harness = await startRedisHarness();
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('round-trips an event with real dates and a bounded TTL', async () => {
    const cache = new RedisEventCache(harness.client, 60, pino({ enabled: false }));

    await cache.set(event);
    await expect(cache.get(event.id)).resolves.toEqual(event);

    const ttl = await harness.client.ttl(`gatherly:v1:event:${event.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('deletes an invalid cached value and treats it as a miss', async () => {
    const key = `gatherly:v1:event:${event.id}`;
    const cache = new RedisEventCache(harness.client, 60, pino({ enabled: false }));
    await harness.client.set(key, '{"id":"not-a-valid-cached-event"}', { EX: 60 });

    await expect(cache.get(event.id)).resolves.toBeNull();
    await expect(harness.client.exists(key)).resolves.toBe(0);
  });

  it('increments one shared fixed window atomically and preserves its TTL', async () => {
    const limiter = new RedisFixedWindowRateLimiter(harness.client, pino({ enabled: false }));

    const results = await Promise.all(
      Array.from({ length: 12 }, () => limiter.consume('sign-in', '127.0.0.1', 10, 900)),
    );

    expect(results.filter((result) => result?.allowed === true)).toHaveLength(10);
    expect(results.filter((result) => result?.allowed === false)).toHaveLength(2);

    const [key] = await harness.client.keys('gatherly:v1:rate:sign-in:*');
    expect(key).toBeDefined();
    const ttl = await harness.client.ttl(key!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });
});
```

`KEYS` is acceptable only in this isolated test database containing one known
key. Production code must use known keys or incremental `SCAN`, never `KEYS *`.

### Verification

```powershell
yarn vitest run tests/integration/redis.integration.test.ts
```

### Expected result

The real server proves TTL, valid date round-trip, malformed cache eviction,
and exactly ten allowed results under twelve concurrent limiter calls.

---

## Checkpoint 18: Prove cache behavior through the API

### Reason

Adapter tests prove Redis mechanics; an API/integration test must prove the
application uses cache-aside without changing its HTTP DTO.

### Implementation

Create a Redis-enabled variant of the existing test composition helper. It
should accept an `EventCache` and `IdentityRateLimiters`, while the default
`createTestApp` continues using no-op/local dependencies. Avoid duplicating the
entire composition root; add optional dependency parameters.

Then add a test that:

1. creates a public event in PostgreSQL;
2. calls `GET /api/events/:eventId` once;
3. verifies the versioned Redis key exists and has a TTL;
4. calls the endpoint again and verifies the same DTO;
5. deletes only the Redis key;
6. calls again and verifies PostgreSQL repopulates it.

The key assertion is behavioral:

```ts
const first = await request(app).get(`/api/events/${eventId}`);
expect(first.status).toBe(200);

const key = `gatherly:v1:event:${eventId}`;
expect(await redis.client.exists(key)).toBe(1);

const second = await request(app).get(`/api/events/${eventId}`);
expect(second.body).toEqual(first.body);

await redis.client.del(key);
const afterFlush = await request(app).get(`/api/events/${eventId}`);
expect(afterFlush.body).toEqual(first.body);
expect(await redis.client.exists(key)).toBe(1);
```

Do not assert performance in this test. Container scheduling makes tiny timing
assertions flaky. Prove behavior here and measure latency separately with a
repeatable load experiment later.

### Expected result

Cache population, hit, deletion, and reconstruction do not change the event
detail response contract.

---

## Checkpoint 19: Prove Redis loss does not lose business truth

### Reason

The most important Redis test is not “Redis works.” It is “the application
remains correct when Redis does not work.”

### Implementation

Create `scripts/phase6-redis-outage.ps1` with this **complete file**:

```powershell
$ErrorActionPreference = 'Stop'

$project = 'gatherly-phase6-redis-outage'
$compose = @('-p', $project, '-f', 'compose.yaml')
$appPort = if ([string]::IsNullOrWhiteSpace($env:APP_PORT)) { '3000' } else { $env:APP_PORT }
$baseUrl = "http://127.0.0.1:$appPort"

function Assert-LastExitCode([string]$message) {
  if ($LASTEXITCODE -ne 0) { throw $message }
}

function Get-HttpStatus([string]$uri) {
  try {
    return (Invoke-WebRequest -Uri $uri).StatusCode
  }
  catch {
    if ($null -ne $_.Exception.Response) {
      return [int]$_.Exception.Response.StatusCode
    }
    return 0
  }
}

try {
  docker compose @compose up --detach --build
  Assert-LastExitCode 'Compose startup failed'

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Seconds 1
    if ((Get-HttpStatus "$baseUrl/health/ready") -eq 200) {
      $ready = $true
      break
    }
  }
  if (-not $ready) { throw 'Application did not become ready within 30 seconds' }

  $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $passwordBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
  $password = [Convert]::ToBase64String($passwordBytes)
  $credentials = @{
    username = "redis_drill_$suffix"
    password = $password
  } | ConvertTo-Json

  $signUp = Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/sign-up" `
    -ContentType 'application/json' -Body $credentials
  $headers = @{ Authorization = "Bearer $($signUp.data.accessToken)" }

  $communityBody = @{
    name = "Redis Drill $suffix"
    slug = "redis-drill-$suffix"
  } | ConvertTo-Json
  $community = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/communities" `
    -Headers $headers -ContentType 'application/json' -Body $communityBody

  $eventBody = @{
    title = 'Redis outage event'
    slug = 'redis-outage-event'
    startsAt = '2030-08-03T18:00:00.000Z'
    endsAt = '2030-08-03T21:00:00.000Z'
    timezone = 'Europe/Moscow'
    capacity = 10
  } | ConvertTo-Json
  $event = Invoke-RestMethod -Method Post `
    -Uri "$baseUrl/api/communities/$($community.data.id)/events" `
    -Headers $headers -ContentType 'application/json' -Body $eventBody

  $eventUri = "$baseUrl/api/events/$($event.data.id)"
  $warm = Invoke-RestMethod -Method Get -Uri $eventUri
  if ($warm.data.id -ne $event.data.id) { throw 'Could not warm the event cache' }

  docker compose @compose exec -T redis redis-cli EXISTS "gatherly:v1:event:$($event.data.id)"
  Assert-LastExitCode 'Could not inspect the event cache key'

  docker compose @compose stop redis
  Assert-LastExitCode 'Could not stop Redis'

  if ((Get-HttpStatus "$baseUrl/health/live") -ne 200) { throw 'Liveness failed' }
  if ((Get-HttpStatus "$baseUrl/health/ready") -ne 200) {
    throw 'Readiness must remain 200 during an optional Redis outage'
  }

  $duringOutage = Invoke-RestMethod -Method Get -Uri $eventUri
  if ($duringOutage.data.id -ne $event.data.id) {
    throw 'PostgreSQL event read failed during Redis outage'
  }

  $reservation = Invoke-WebRequest -Method Post `
    -Uri "$baseUrl/api/events/$($event.data.id)/reservations" `
    -Headers ($headers + @{ 'Idempotency-Key' = "redis-outage-$suffix" }) `
    -ContentType 'application/json' -Body '{}'
  if ($reservation.StatusCode -notin @(200, 201)) {
    throw "Reservation returned $($reservation.StatusCode) during Redis outage"
  }

  docker compose @compose start redis
  Assert-LastExitCode 'Could not restart Redis'

  $redisHealthy = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Seconds 1
    docker compose @compose exec -T redis redis-cli PING | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $redisHealthy = $true
      break
    }
  }
  if (-not $redisHealthy) { throw 'Redis did not recover within 30 seconds' }

  Start-Sleep -Seconds 2
  $afterRecovery = Invoke-RestMethod -Method Get -Uri $eventUri
  if ($afterRecovery.data.id -ne $event.data.id) { throw 'Event read failed after recovery' }

  docker compose @compose logs app
  Write-Host 'Phase 6 Redis outage drill passed'
}
finally {
  # Safe because this project name belongs only to this disposable drill.
  docker compose @compose down --volumes
}
```

Run this with no conflicting stack on `APP_PORT`/`REDIS_PORT`. The script does
not print the bearer token or password. Its PostgreSQL volume is isolated by
the Compose project name and removed in `finally`.

### Verification

```powershell
powershell -ExecutionPolicy Bypass -File scripts/phase6-redis-outage.ps1
```

Inspect logs for reconnection warnings, but verify they contain no Redis URL,
password, JWT, authorization header, or request body.

### Expected result

During the outage:

```text
/health/live                    200
/health/ready                   200
public event detail             served from PostgreSQL
reservation mutation            succeeds transactionally in PostgreSQL
rate limiting                   falls back to the local process
permanent data after recovery   unchanged
```

After Redis returns, the client reconnects and later event reads can populate
the disposable cache again.

---

## Checkpoint 20: Measure the cache instead of assuming it helps

### Reason

A functioning cache adds a network round trip, serialization, memory, failure
modes, and invalidation work. Keep it only if the measured read workload
benefits. A local single-row primary-key query may already be so fast that
Redis adds little value; the learning is still useful, but the evidence should
say so honestly.

### Verification

Choose one public event in the realistic dataset and define three experiments:

```text
A: Redis empty, first request loads PostgreSQL and writes cache
B: Redis warm, repeated detail requests
C: Redis stopped, repeated detail requests fall back to PostgreSQL
```

For each, record:

```text
tool and command:
concurrency:
duration/request count:
p50 / p95 / p99 latency:
requests per second:
HTTP errors:
PostgreSQL query count or observed load:
Redis command errors/reconnections:
host/container resource conditions:
```

Do not benchmark while `tsx watch`, test containers, image builds, or unrelated
workloads are competing for the same machine. Use the production-style image
for a runtime comparison. Run enough requests to reduce startup noise, but do
not claim internet-scale capacity from a laptop result.

Inspect Redis without dumping values:

```powershell
docker compose exec redis redis-cli INFO memory
docker compose exec redis redis-cli INFO stats
docker compose exec redis redis-cli DBSIZE
docker compose exec redis redis-cli --scan --pattern 'gatherly:v1:event:*'
```

Do not use `MONITOR` on a shared or production system: it exposes every command
and can include sensitive values. Do not use `FLUSHALL` outside an explicitly
isolated disposable environment.

### Expected result

The Phase 6 notes state whether warm-cache reads reduce database work and tail
latency enough to justify this cache. They also record the cold-miss and outage
cost rather than reporting only the best case.

---

## Checkpoint 21: Understand invalidation, stampedes, and consistency

### Reason

Cache-aside trades strict freshness for speed and resilience. The first
implementation uses three controls:

- cache only public display data;
- invalidate after a successful database mutation;
- bound stale data with a short TTL.

It does not solve every cache problem.

### Cache invalidation matrix

| PostgreSQL change                          | Cache action                                                       | Why                                                  |
| ------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------- |
| event title/time/status/visibility changes | delete event key after commit                                      | public DTO may be stale or no longer public          |
| community becomes archived/suspended       | invalidate each affected event or use a namespace/version strategy | public-event eligibility depends on community status |
| reservation count changes                  | no action for current DTO                                          | current detail DTO does not include availability     |
| membership/user status changes             | never use event cache for authorization                            | authorization reloads PostgreSQL                     |

Community-wide invalidation can become expensive. Do not introduce wildcard
deletion in a request. When event mutation endpoints exist, choose among:

- short TTL only, if bounded staleness is acceptable;
- maintain a bounded set of event IDs per community and delete known keys;
- include a community cache-version in event keys;
- publish best-effort invalidation after the database commits.

Each choice adds state and failure modes. Measure the real mutation/read ratio
first.

### Cache stampede

When a popular key expires, many requests can miss together and query
PostgreSQL. Do not use a Redis distributed lock to protect reservation logic.
For read-cache stampedes, safer progressive options are:

1. accept duplicate primary-key reads at the current scale;
2. add in-process promise coalescing for identical event IDs;
3. add small TTL jitter so many keys do not expire simultaneously;
4. only then consider a short cache-fill lease with strict timeouts.

Never wait indefinitely for another cache filler, and always retain the direct
PostgreSQL fallback.

### Expected result

You can name every source of permitted staleness and explain why Redis is not a
correctness mechanism for capacity, waitlist order, bans, or idempotency.

---

## Checkpoint 22: Run Redis security and operational checks

### Reason

The local Compose port is bound to `127.0.0.1`; it is not an internet-facing
deployment design. A later deployment should place Redis on a private network,
authenticate/encrypt where the environment requires it, and avoid publishing
its port to the public host.

### Verification

Check the actual container and application behavior:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up --detach --build
docker compose ps redis app
docker compose exec redis redis-cli INFO server
docker compose exec redis redis-cli CONFIG GET maxmemory
docker compose exec redis redis-cli CONFIG GET maxmemory-policy

$redisContainerId = docker compose ps -q redis
docker inspect $redisContainerId --format '{{json .HostConfig.CapDrop}}'
docker inspect $redisContainerId --format '{{json .HostConfig.SecurityOpt}}'
docker inspect $redisContainerId --format '{{.HostConfig.ReadonlyRootfs}}'
```

Review code/logs for:

- one error listener on every client;
- no `REDIS_URL` logging;
- no passwords, JWTs, cookies, private messages, or request bodies in Redis;
- all application keys beginning with `gatherly:v1:`;
- TTL on every cache/counter key;
- no readiness dependence on Redis;
- no Redis calls inside reservation/waitlist PostgreSQL transactions;
- bounded reconnect delay and graceful client closure.

The local Redis service intentionally has no password because it is bound to
loopback for host access and isolated on the Compose network. Do not copy that
decision into an exposed remote environment. Use a secret-injected `rediss://`
URL there and do not commit credentials.

### Expected result

The actual container is bounded and non-privileged, key contents are safe and
temporary, and logs reveal degradation without revealing credentials.

---

## Failure drills

Complete these after the happy-path tests:

### Redis absent at process startup

Start PostgreSQL but not Redis, then start the app. Expected:

- the process starts and serves authoritative routes;
- `/health/live` and `/health/ready` are 200 when PostgreSQL is healthy;
- one safe Redis warning appears, and reconnect attempts use bounded backoff;
- event detail uses PostgreSQL;
- auth endpoints use local counters.

### Redis stops after a cache hit

Warm an event key, stop Redis, and read again. The client may briefly be in a
reconnecting state, but `disableOfflineQueue` prevents unbounded queued cache
commands. Expected HTTP result remains 200 from PostgreSQL.

### Malformed cache value

Write invalid JSON and then a structurally invalid JSON object under a known
event key. Both become misses; the key is deleted; the public API still loads
PostgreSQL.

### Redis reaches max memory

In an isolated environment only, fill memory with expiring dummy values until
`noeviction` rejects writes. Expected:

- cache population logs and skips;
- Redis limiter returns `null` and local limiter applies;
- PostgreSQL writes continue;
- the process remains live/ready.

Do not perform a memory-fill drill against a shared Redis instance.

### Flush and restart

In the isolated Testcontainers/Compose drill, run `FLUSHDB` or restart Redis.
Expected permanent PostgreSQL rows remain intact. The next event read rebuilds
the cache; rate-limit counters restart because they are deliberately temporary.

### Duplicate limiter requests

Run more concurrent `consume` calls than the limit. Exactly the first `limit`
calls are allowed in that window, one TTL exists, and no counter is created
without expiry.

---

## Common mistakes

- Adding indexes from intuition without realistic cardinality and before/after
  plans.
- Calling every sequential scan a bug.
- Comparing a warm after-plan with a cold before-plan.
- Hiding a slow `OFFSET`/`COUNT` API behind a large list cache.
- Caching Prisma records directly without a stable serialized schema.
- Returning a 500 because a cache `GET` or `SET` failed.
- Caching membership/ban decisions and delaying permission revocation.
- Counting reservations in Redis or using Redis locks instead of PostgreSQL row
  locking and constraints.
- Making Redis a readiness dependency when the app is explicitly designed to
  degrade without it.
- Creating one Redis connection per request.
- Forgetting the mandatory client `error` listener.
- Letting offline commands queue without a bound.
- Running `INCR` and `EXPIRE` separately for a limiter.
- Falling fully open on limiter failure instead of retaining a local fallback.
- Trusting `X-Forwarded-For` without a precise Express proxy configuration.
- Using `KEYS *`, `MONITOR`, or `FLUSHALL` in a shared environment.
- Adding a Redis named volume and then accidentally describing the cache as
  durable truth.
- Adding Pub/Sub before a live transport and replay design exist.

---

## Suggested commit sequence

Keep measurement evidence and implementation reviewable:

1. `docs: add phase 6 postgres and redis handbook`
2. `perf: add measured public-event index` (only if evidence earns it)
3. `infra: add disposable redis compose service`
4. `feat: add validated public-event cache-aside adapter`
5. `feat: add shared redis auth throttling with local fallback`
6. `test: prove redis ttl atomicity and graceful degradation`
7. `docs: record phase 6 plans measurements and outage results`

Do not combine an unmeasured index, Redis wiring, and unrelated product changes
in one commit. A reviewer should be able to revert the cache without reverting
a database migration.

---

## Final examination

Phase 6's PostgreSQL-and-Redis increment is complete when you can answer these
without guessing:

1. What were the actual and estimated rows in each before-plan?
2. Why was each retained index chosen, and what writes/storage does it cost?
3. Why can a sequential scan be the correct plan?
4. Why does deep offset pagination degrade, and when would keyset pagination
   change the API?
5. Which exact Redis keys exist, who owns their truth, and what are their TTLs?
6. What happens if Redis is flushed, full, absent at startup, or lost after
   connection?
7. Why is public event detail safe to cache while authorization and capacity
   are not?
8. Where are cached values validated and dates reconstructed?
9. When must event keys be invalidated, and why only after PostgreSQL commits?
10. Why does the limiter use Lua rather than separate `INCR` and `EXPIRE`
    calls?
11. What weakness does a fixed window have at its boundary?
12. Why is a local limiter retained during Redis failure?
13. Why is Redis omitted from readiness but included in graceful shutdown?
14. How does the real-container test prove behavior mocks cannot?
15. Why are SSE, WebSockets, Elasticsearch, and Kafka still absent?

## Phase completion commands

```powershell
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
yarn vitest run tests/integration/redis.integration.test.ts
powershell -ExecutionPolicy Bypass -File scripts/phase6-redis-outage.ps1
```

Also attach the PostgreSQL before/after plan notes and cache benchmark notes to
the learning record. Passing tests without measurement does not complete the
performance lesson.

The deliverable is still one modular monolith. Redis is a disposable helper
beside it, not a new service boundary and not a second database of record.

## Official references

- PostgreSQL 17, [Using EXPLAIN](https://www.postgresql.org/docs/17/using-explain.html)
- PostgreSQL 17, [Indexes](https://www.postgresql.org/docs/17/indexes.html)
- PostgreSQL 17, [Routine vacuuming and ANALYZE](https://www.postgresql.org/docs/17/routine-vacuuming.html)
- Redis, [Key expiration](https://redis.io/docs/latest/develop/data-types/strings/)
- Redis, [Lua scripting with EVAL](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/)
- Redis, [Eviction policies](https://redis.io/docs/latest/develop/reference/eviction/)
- Redis, [Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- Node Redis, [official client repository and guide](https://github.com/redis/node-redis)
- Testcontainers for Node.js, [Redis module](https://node.testcontainers.org/modules/redis/)
