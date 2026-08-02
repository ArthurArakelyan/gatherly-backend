# Phase 2 Handbook: Express, PostgreSQL, and Handwritten SQL

Phase 2 replaces the native `node:http` request routing with Express and builds Gatherly’s first real API directly on PostgreSQL through `pg`.

There is no temporary in-memory repository and no Prisma in this phase. Every route follows:

```text
route → controller → service → repository → pg → PostgreSQL
```

This is a build-it-yourself handbook. Work one checkpoint at a time, keep tests passing, and do not copy the final structure without understanding why each boundary exists.

## Phase outcome

By the end, this automated scenario must work:

```text
Seed user A and user B
→ user A creates a community and becomes OWNER
→ user B joins the community
→ user A creates a capacity-1 event
→ user A reserves the final place
→ user B attempts to reserve and enters the waitlist
→ user A cancels
→ user B is promoted to a confirmed reservation
→ user B receives an in-app notification
```

You will learn:

- Express application and router composition
- Middleware ordering
- Validation with Zod
- Consistent HTTP errors
- Request IDs and HTTP logging
- PostgreSQL pools and parameterized SQL
- Forward-only SQL migrations
- Table constraints and partial unique indexes
- Repository mapping between SQL rows and domain types
- Transactions using one checked-out client
- Row locking and concurrency correctness
- API, repository, integration, and concurrency tests
- Liveness, readiness, database failure, and graceful shutdown
- Pagination, filtering, and an initial OpenAPI contract

## Scope for this phase

Build these modules:

```text
communities
memberships
events
reservations
waitlists
notifications (promotion notification only)
```

Use a minimal `users` table only to support foreign keys and temporary identities. Real sign-up/sign-in belongs to Phase 4.

Do not add:

```text
Prisma
Redis
Kafka
Elasticsearch
WebSockets
SSE
email
Nginx
recurring events
real authentication
```

## Step 1: Prove the Phase 1 baseline

Before changing application code:

```powershell
docker compose config --quiet
docker compose up --detach --build
docker compose ps
Invoke-RestMethod -Uri http://127.0.0.1:3000/health
yarn typecheck
yarn lint
yarn test
yarn build
```

Confirm both containers are healthy. If the baseline is broken, fix it before mixing Docker problems with Express or SQL problems.

Make a Git commit at this point. It gives you a clean comparison point for Phase 2.

Checkpoint:

```text
Phase 1 works and I can return to a known-good commit.
```

## Step 2: Add a fast Docker development workflow

Your current image compiles an immutable production artifact. Preserve that target, but add a development target so TypeScript changes do not require rebuilding on every edit.

Refactor the Dockerfile into these conceptual stages:

```dockerfile
FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM dependencies AS development

ENV NODE_ENV=development
COPY tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests
USER node
CMD ["yarn", "dev"]

FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true && yarn cache clean
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node db ./db
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

The `db` copy will work after you create that directory. Until then, either create `db/migrations` before rebuilding or temporarily omit that line.

Create `compose.dev.yaml` as a development override:

```yaml
services:
  app:
    build:
      target: development
    environment:
      NODE_ENV: development
    command: yarn dev
    volumes:
      - ./src:/app/src:ro
      - ./tests:/app/tests:ro
      - ./db:/app/db:ro
      - ./tsconfig.json:/app/tsconfig.json:ro
      - ./tsconfig.build.json:/app/tsconfig.build.json:ro
      - ./vitest.config.ts:/app/vitest.config.ts:ro
```

Run the development stack with both files:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

Edit `src/app.ts`. `tsx watch` should restart Node without rebuilding the image.

Rebuild only when changing:

```text
package.json
yarn.lock
Dockerfile
system dependencies
```

Recreate the container when changing Compose environment, ports, volumes, health checks, or commands.

Checkpoint:

```text
An ordinary TypeScript source edit restarts Node without rebuilding dependencies.
```

## Step 3: Create the Phase 2 directories

Build the structure gradually:

```text
db/
  migrations/
  seeds/

docs/
  openapi.yaml

src/
  app.ts
  server.ts

  config/
    env.ts

  shared/
    errors/
      app-error.ts
      error-handler.ts
      not-found-handler.ts
    logging/
      logger.ts
      request-id.middleware.ts
    validation/
      validate.middleware.ts
    http/
      request-user.middleware.ts
    database/
      transaction.ts

  infrastructure/
    postgres/
      pool.ts
      migrate.ts
      seed.ts

  modules/
    communities/
    memberships/
    events/
    reservations/
    waitlists/
    notifications/

tests/
  fixtures/
  helpers/
  api/
  integration/
  e2e/
```

Do not create empty files for the entire final architecture at once. Create a file when the current checkpoint needs it.

## Step 4: Centralize environment validation

Move environment parsing out of `server.ts` into `src/config/env.ts`.

Required values:

```text
NODE_ENV
PORT
PGHOST
PGPORT
PGDATABASE
PGUSER
PGPASSWORD
PGPOOL_MAX
```

Suggested validation:

```ts
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  PGDATABASE: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  PGPOOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
});

export type Environment = z.infer<typeof environmentSchema>;

export const parseEnvironment = (input: NodeJS.ProcessEnv): Environment =>
  environmentSchema.parse(input);
```

Why export a function rather than parsing immediately at module import?

- Tests can provide controlled values.
- Importing a module does not unexpectedly terminate a test before setup.
- Configuration parsing remains explicit in the composition root.

Add `PGPOOL_MAX=10` to `.env.example` and pass it into the app service in Compose.

Test invalid and defaulted environment values as a small unit test.

Checkpoint:

```text
The application fails at startup—not during the first request—when database configuration is invalid.
```

## Step 5: Create one PostgreSQL pool

Create `src/infrastructure/postgres/pool.ts`.

Responsibilities:

- Construct one `pg.Pool` for the process.
- Apply explicit connection settings.
- Limit pool size.
- Set a connection timeout.
- Listen for background errors from idle clients.
- Expose a database readiness query.
- Allow graceful pool shutdown.

Conceptual implementation:

```ts
import pg from 'pg';

import type { Environment } from '../../config/env.js';

const { Pool } = pg;

export const createPool = (environment: Environment): pg.Pool => {
  const pool = new Pool({
    host: environment.PGHOST,
    port: environment.PGPORT,
    database: environment.PGDATABASE,
    user: environment.PGUSER,
    password: environment.PGPASSWORD,
    max: environment.PGPOOL_MAX,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  pool.on('error', (error) => {
    // Log the error; do not silently ignore an idle-client failure.
  });

  return pool;
};
```

Rules:

- Create one pool during process startup, not one pool per request.
- Use `pool.query()` for isolated single statements.
- Check out a client with `pool.connect()` for a transaction.
- Always release checked-out clients.
- Call `pool.end()` during shutdown.

Test connectivity from the running development app container:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec app node --input-type=module -e "import pg from 'pg'; const pool = new pg.Pool(); console.log((await pool.query('SELECT current_database(), now()')).rows); await pool.end()"
```

The default `pg` constructor recognizes the `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` variables you passed through Compose.

Checkpoint question:

> Why would creating a new pool inside every controller eventually exhaust PostgreSQL connections?

## Step 6: Write a transaction helper

Node-postgres does not create a high-level transaction abstraction for you. A transaction must use the same checked-out client for `BEGIN`, every statement, and `COMMIT`/`ROLLBACK`.

Create `src/shared/database/transaction.ts`:

```ts
import type { Pool, PoolClient } from 'pg';

export const withTransaction = async <T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
```

Later you may add isolation-level or retry options. Do not abstract them before you understand the actual SQL.

Write an integration test that:

1. Inserts a row inside `withTransaction`.
2. Throws before completion.
3. Verifies the row does not exist.

Checkpoint:

```text
I can explain why pool.query('BEGIN') followed by another pool.query(...) is incorrect.
```

## Step 7: Design forward-only migrations

Create:

```text
db/migrations/001_initial_schema.sql
db/seeds/development.sql
```

A migration is a versioned database change, not application startup code that repeatedly runs arbitrary `CREATE TABLE IF NOT EXISTS` statements.

Your migration runner should eventually:

1. Connect using one client.
2. Acquire a PostgreSQL advisory lock so two runners cannot migrate simultaneously.
3. Create `schema_migrations(name, applied_at)` if needed.
4. Read `.sql` files in lexical order.
5. Skip names already recorded.
6. For each pending file, start a transaction.
7. Execute the complete SQL file.
8. Record its name.
9. Commit, or roll back on failure.
10. Release the advisory lock and client.

Useful migration table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

Use a stable advisory-lock key chosen for this project. Understand that an advisory lock coordinates cooperating migration processes; it does not replace migration history.

Do not modify an already-applied migration after sharing it. Create `002_...sql`, `003_...sql`, and so on.

For early local experimentation, resetting a disposable volume is possible, but it is not a migration strategy.

## Step 8: Write the initial SQL schema

Use text statuses with named `CHECK` constraints in this learning phase. PostgreSQL enum types are valid, but changing them introduces extra migration lessons that distract from the initial model.

A reasonable first migration is:

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_username_key UNIQUE (username),
  CONSTRAINT users_username_format_check
    CHECK (username ~ '^[a-z0-9_]{3,30}$'),
  CONSTRAINT users_status_check
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED'))
);

CREATE TABLE communities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  city text,
  country text,
  visibility text NOT NULL DEFAULT 'PUBLIC',
  join_policy text NOT NULL DEFAULT 'OPEN',
  status text NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT communities_slug_key UNIQUE (slug),
  CONSTRAINT communities_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT communities_slug_format_check
    CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT communities_visibility_check
    CHECK (visibility IN ('PUBLIC', 'UNLISTED', 'PRIVATE')),
  CONSTRAINT communities_join_policy_check
    CHECK (join_policy IN ('OPEN', 'APPROVAL_REQUIRED', 'INVITE_ONLY')),
  CONSTRAINT communities_status_check
    CHECK (status IN ('ACTIVE', 'ARCHIVED', 'SUSPENDED'))
);

CREATE TABLE community_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL DEFAULT 'MEMBER',
  status text NOT NULL DEFAULT 'ACTIVE',
  joined_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT community_memberships_user_community_key
    UNIQUE (community_id, user_id),
  CONSTRAINT community_memberships_role_check
    CHECK (role IN ('MEMBER', 'MODERATOR', 'ORGANIZER', 'OWNER')),
  CONSTRAINT community_memberships_status_check
    CHECK (status IN ('PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'BANNED', 'LEFT'))
);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  format text NOT NULL DEFAULT 'IN_PERSON',
  status text NOT NULL DEFAULT 'PUBLISHED',
  visibility text NOT NULL DEFAULT 'PUBLIC',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  capacity integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT events_community_slug_key UNIQUE (community_id, slug),
  CONSTRAINT events_title_not_blank_check CHECK (btrim(title) <> ''),
  CONSTRAINT events_time_order_check CHECK (starts_at < ends_at),
  CONSTRAINT events_capacity_positive_check CHECK (capacity > 0),
  CONSTRAINT events_format_check CHECK (format IN ('IN_PERSON', 'ONLINE', 'HYBRID')),
  CONSTRAINT events_status_check
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED', 'ARCHIVED')),
  CONSTRAINT events_visibility_check
    CHECK (visibility IN ('PUBLIC', 'COMMUNITY_ONLY', 'INVITE_ONLY'))
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'CONFIRMED',
  reserved_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reservations_status_check
    CHECK (status IN ('CONFIRMED', 'CANCELLED_BY_USER', 'CANCELLED_BY_ORGANIZER')),
  CONSTRAINT reservations_cancellation_time_check CHECK (
    (status = 'CONFIRMED' AND cancelled_at IS NULL)
    OR
    (status IN ('CANCELLED_BY_USER', 'CANCELLED_BY_ORGANIZER') AND cancelled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX reservations_active_user_event_uidx
  ON reservations (event_id, user_id)
  WHERE status = 'CONFIRMED';

CREATE INDEX reservations_event_status_idx
  ON reservations (event_id, status);

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'WAITING',
  joined_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT waitlist_entries_status_check
    CHECK (status IN ('WAITING', 'PROMOTED', 'CANCELLED', 'REMOVED'))
);

CREATE UNIQUE INDEX waitlist_entries_waiting_user_event_uidx
  ON waitlist_entries (event_id, user_id)
  WHERE status = 'WAITING';

CREATE INDEX waitlist_entries_event_order_idx
  ON waitlist_entries (event_id, joined_at, id)
  WHERE status = 'WAITING';

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notifications_type_check CHECK (
    type IN (
      'RESERVATION_CONFIRMED',
      'RESERVATION_CANCELLED',
      'WAITLIST_JOINED',
      'WAITLIST_PROMOTED',
      'EVENT_UPDATED',
      'EVENT_CANCELLED',
      'MEMBERSHIP_APPROVED'
    )
  )
);

CREATE INDEX communities_status_created_idx
  ON communities (status, created_at DESC, id DESC);

CREATE INDEX events_status_starts_idx
  ON events (status, starts_at, id);

CREATE INDEX community_memberships_user_idx
  ON community_memberships (user_id, community_id);
```

Questions to answer for every table:

- What is the primary key?
- Which columns are nullable, and why?
- What protects referential integrity?
- Which business rule is encoded by each constraint?
- Which rule cannot be expressed as an ordinary row constraint?
- Which query justifies each non-unique index?

Important limitation:

```text
A normal CHECK constraint cannot compare reservation counts with events.capacity
or enforce exclusivity across reservations and waitlist_entries.
```

Those cross-row/cross-table rules require a consistent transaction and locking protocol.

## Step 9: Add deterministic development users

Until Phase 4, use fixed users so foreign keys and ownership are real without building authentication.

Example `db/seeds/development.sql`:

```sql
INSERT INTO users (id, username)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'alice'),
  ('00000000-0000-4000-8000-000000000002', 'bob'),
  ('00000000-0000-4000-8000-000000000003', 'carol')
ON CONFLICT (id) DO NOTHING;
```

The seed must be safe to repeat locally. Seeds create development data; migrations create required structure. Do not mix them.

## Step 10: Implement migration and seed commands

Add scripts after writing the runners:

```json
{
  "scripts": {
    "db:migrate": "tsx src/infrastructure/postgres/migrate.ts",
    "db:migrate:prod": "node dist/infrastructure/postgres/migrate.js",
    "db:seed": "tsx src/infrastructure/postgres/seed.ts",
    "db:seed:prod": "node dist/infrastructure/postgres/seed.js"
  }
}
```

Run inside the development app container so `PGHOST=postgres` works:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn db:migrate
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn db:seed
```

Inspect history and tables:

```powershell
docker compose exec postgres psql -U gatherly -d gatherly -c "TABLE schema_migrations;"
docker compose exec postgres psql -U gatherly -d gatherly -c "\dt"
docker compose exec postgres psql -U gatherly -d gatherly -c "TABLE users;"
```

Use your actual `.env` names if they differ.

Run the migration command twice. The second run should report nothing pending and make no schema changes.

Deliberately introduce invalid SQL in a new temporary migration, verify rollback/no history entry, then remove that unapplied file.

Checkpoint:

```text
Migrations are ordered, repeatable as a process, transactional per file, recorded, and protected against concurrent runners.
```

## Step 11: Replace `requestListener` with an Express app factory

Refactor `src/app.ts` so it exports an Express application rather than a native request listener.

Prefer a factory:

```ts
import express, { type Express } from 'express';

export interface AppDependencies {
  // Add services and readiness checks as you build them.
}

export const createApp = (dependencies: AppDependencies): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health/live', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  return app;
};
```

Why a factory?

- Production can inject the real pool/services.
- Tests can inject test dependencies.
- Importing the app does not start a port.
- Module initialization becomes explicit.

Update `server.ts`:

```text
parse environment
→ create logger
→ create PostgreSQL pool
→ create repositories
→ create services
→ create Express app
→ createServer(app)
→ listen
```

Keep `createServer(app)` instead of hiding startup in `app.listen()` because you already have explicit connection shutdown behavior.

Update the Compose application health check from `/health` to `/health/live` temporarily. Later in this phase decide whether Compose should use liveness or readiness and be able to explain the tradeoff.

Update the existing health API test to call `createApp(...)` and `/health/live`.

Checkpoint:

```text
Express handles requests, but importing createApp still does not open a port.
```

## Step 12: Assemble middleware in the correct order

Add middleware one piece at a time:

```text
1. Helmet
2. CORS configuration
3. Request ID
4. Development HTTP logging with Morgan
5. JSON body parser
6. Temporary request-user middleware
7. API routers
8. Not-found middleware
9. Error middleware
```

Middleware order is execution order. A middleware that neither ends the response nor calls `next()` leaves the request hanging.

### Request IDs

Use `crypto.randomUUID()` when an incoming trusted request ID is absent. Return it in an `x-request-id` response header and include it in logs/errors.

Do not blindly trust an arbitrarily long incoming header. Validate its length/format or always create your own ID.

### Morgan

Use Morgan during this learning phase to observe request middleware:

```text
POST /api/events/... 201 34 ms request=<id>
```

Avoid logging request bodies, credentials, tokens, or private content.

### Helmet and CORS

Helmet adds defensive response headers. CORS controls which browser origins may read API responses; it is not authentication and does not stop non-browser clients.

### JSON limits

Keep an explicit JSON body limit. An API should not accept arbitrarily large bodies by default.

Checkpoint tests:

- JSON responses include an `x-request-id` header.
- A malformed JSON body returns a controlled JSON error.
- An unknown path reaches your JSON 404 handler.

## Step 13: Define one consistent error contract

Create an `AppError` carrying:

```text
HTTP status
stable machine code
safe client message
optional safe details
```

Example response:

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "The requested event does not exist",
    "requestId": "7053fcbb-..."
  }
}
```

Suggested mappings:

```text
400 VALIDATION_ERROR
400 INVALID_EVENT_TIME
401 USER_REQUIRED
403 COMMUNITY_PERMISSION_DENIED
404 COMMUNITY_NOT_FOUND
404 EVENT_NOT_FOUND
404 RESERVATION_NOT_FOUND
409 COMMUNITY_SLUG_TAKEN
409 ALREADY_RESERVED
409 ALREADY_WAITLISTED
409 IDEMPOTENCY_KEY_REUSED
500 INTERNAL_ERROR
503 DATABASE_UNAVAILABLE
```

Express error middleware must use four parameters:

```ts
(error, request, response, next) => { ... }
```

Place it after routers. Express 5 forwards rejected route-handler promises to error middleware, but you must still return/await promises correctly and handle errors outside the request lifecycle separately.

Log internal errors with context, but never return SQL messages, stack traces, constraint details, or secrets to clients.

Checkpoint:

```text
Every expected failure has a stable code; unexpected failures become a safe 500 response and a detailed internal log.
```

## Step 14: Build reusable Zod validation

Validate all untrusted boundaries:

```text
request body
path parameters
query parameters
temporary user header
environment variables
```

For each route, define a schema describing the relevant combination:

```ts
const createCommunityRequestSchema = z.object({
  body: z.object({
    name: z.string().trim().min(3).max(100),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().max(2_000).default(''),
    city: z.string().trim().min(1).max(100).optional(),
    country: z.string().trim().min(2).max(100).optional(),
  }),
});
```

Do not validate only in TypeScript types. Types disappear at runtime and do not protect the API from malformed JSON.

Use parsed data—not the original body—after validation so trimming, coercion, defaults, and rejected unknown fields behave deliberately.

Decide whether request objects are `.strict()` or strip unknown keys, document the choice, and test it.

Checkpoint:

```text
Controllers receive already-validated input and do not contain repeated ad hoc typeof checks.
```

## Step 15: Add temporary identity without building authentication

For Phase 2 only, read a seeded UUID from:

```text
x-user-id: 00000000-0000-4000-8000-000000000001
```

The middleware should:

1. Require exactly one header value on protected routes.
2. Validate UUID syntax.
3. Make the user ID available to controllers/services.
4. Return `401 USER_REQUIRED` when missing or invalid.

Repositories should still rely on the user foreign key. Optionally check that the user exists and is `ACTIVE` at the start of protected use cases.

Clearly mark this middleware as temporary. Never treat `x-user-id` as real security; any client can change it.

Checkpoint test:

- Missing header is rejected.
- Invalid UUID is rejected.
- A seeded user succeeds.
- An unknown UUID cannot create foreign-key-owned data.

## Step 16: Build the communities vertical slice

Create:

```text
src/modules/communities/
  communities.routes.ts
  communities.controller.ts
  communities.service.ts
  communities.repository.ts
  communities.schemas.ts
  communities.types.ts
```

Implement only:

```text
POST /api/communities
GET  /api/communities
GET  /api/communities/:communityId
```

### Responsibilities

Route:

```text
method + path + temporary identity + validation + controller
```

Controller:

```text
read validated HTTP input
→ call service
→ serialize DTO
→ choose status code
```

Service:

```text
enforce use-case rules
→ coordinate community and membership persistence
```

Repository:

```text
parameterized SQL
→ map snake_case rows into domain records
```

Creating a community must atomically:

1. Insert the community.
2. Insert an `ACTIVE OWNER` membership for its creator.
3. Commit both or neither.

Use a transaction. Do not insert the community and owner membership as independent operations.

SQL values must be parameters:

```sql
INSERT INTO communities (name, slug, description, city, country, created_by_user_id)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, name, slug, description, city, country, visibility,
          join_policy, status, created_by_user_id, created_at, updated_at;
```

Never build this:

```ts
`INSERT INTO communities (name) VALUES ('${name}')`;
```

Map the named slug uniqueness violation to `409 COMMUNITY_SLUG_TAKEN`. Keep PostgreSQL error-code translation near the persistence boundary.

For listing:

- Default to active public communities.
- Validate `page` and `limit`.
- Cap `limit`, for example at 100.
- Use deterministic ordering such as `created_at DESC, id DESC`.
- Return pagination metadata.

Tests:

- Valid creation returns `201`.
- Creator becomes owner in the same transaction.
- Duplicate slug returns `409`.
- Invalid slug returns `400` before SQL.
- Failed membership insertion rolls back community creation.
- List and get map timestamps/field names consistently.
- Missing community returns `404`.

Checkpoint:

```text
I can trace POST /api/communities through every layer and identify where the transaction begins and ends.
```

## Step 17: Add open-community membership

Implement:

```text
POST /api/communities/:communityId/join
POST /api/communities/:communityId/leave
```

Phase 2 behavior:

- `OPEN` communities create/reactivate an `ACTIVE MEMBER` membership.
- `APPROVAL_REQUIRED` and `INVITE_ONLY` return a clear not-yet-supported/domain response rather than silently joining.
- Existing `ACTIVE` membership returns a consistent result or `409`; choose and document one behavior.
- `BANNED` membership must not be reactivated by joining.
- Leaving changes status to `LEFT`; it does not delete the history row.
- The owner cannot leave without an ownership-transfer rule; reject it for now.

Because `(community_id, user_id)` is unique, rejoining updates the existing row rather than inserting a duplicate.

Tests:

- Open join succeeds.
- Duplicate join behavior matches the documented contract.
- Banned user cannot rejoin.
- Leaving changes status.
- Owner cannot leave.
- Nonexistent community returns `404`.

## Step 18: Build the events vertical slice

Implement:

```text
POST /api/communities/:communityId/events
GET  /api/events
GET  /api/events/:eventId
```

Phase 2 creation rules:

- Community exists and is `ACTIVE`.
- Caller has an `ACTIVE` membership.
- Role is `OWNER`, `ORGANIZER`, or `MODERATOR` according to your chosen policy. Document the policy.
- Title and slug are valid.
- `startsAt < endsAt` in both Zod/service logic and the database constraint.
- Capacity is a positive integer.
- Time-zone identifier is preserved as supplied after validation.
- Start/end instants are stored as `timestamptz`.

The database constraint is still necessary even though Zod rejects invalid input: SQL may be called by a future worker, migration, administrator, or buggy code path.

Listing filters for this phase:

```text
communityId
status
startsAfter
startsBefore
page
limit
```

Build SQL from a fixed set of known clauses while keeping every value parameterized. Never accept a raw column name or SQL fragment from the client.

Use an explicit mapping function:

```text
database row: created_by_user_id, starts_at
domain/API:    createdByUserId, startsAt
```

Do not return `SELECT *` rows directly from controllers.

Tests:

- Owner can create an event.
- Ordinary member cannot create an event.
- Organizer from another community cannot create here.
- Invalid time order is rejected.
- Zero/negative capacity is rejected.
- Duplicate event slug within one community conflicts.
- Same slug in another community is allowed.
- Filters and pagination are deterministic.

## Step 19: Design the reservation transaction before coding

The incorrect algorithm is:

```text
read confirmed count
→ if below capacity
→ insert reservation
```

Two requests can read the same final free place before either inserts.

Use one event row as the serialization point for all capacity-changing operations:

```text
BEGIN
→ SELECT event ... FOR UPDATE
→ validate event and membership state
→ check existing active reservation/waitlist state
→ count confirmed reservations
→ insert confirmed reservation OR waiting entry
→ insert relevant in-app notification if needed
COMMIT
```

Every reservation and cancellation path for an event must lock the event row first. If different paths acquire locks in different orders, you can create deadlocks or bypass the correctness argument.

Under PostgreSQL’s default `READ COMMITTED` isolation:

1. Request A locks the event row.
2. Request B waits for that row.
3. Request A inserts the final reservation and commits.
4. Request B obtains the lock.
5. Request B’s later count sees A’s committed reservation.
6. Request B joins the waitlist instead of overbooking.

The partial unique indexes remain defense-in-depth against duplicate active state within each table. The transaction checks both tables because a normal constraint cannot enforce exclusivity across two separate tables.

Write this argument in a code comment near the transaction and in its concurrency test—not as a comment on every simple query.

## Step 20: Implement reservation or waitlist creation

Implement:

```text
POST /api/events/:eventId/reservations
GET  /api/events/:eventId/reservations/me
GET  /api/events/:eventId/waitlist/me
```

Require `x-user-id` temporarily.

Inside one checked-out client and transaction:

```sql
SELECT id, community_id, status, starts_at, capacity
FROM events
WHERE id = $1
FOR UPDATE;
```

Then verify:

- Event exists and is `PUBLISHED`.
- Event has not already started.
- User has an `ACTIVE` community membership.
- User has no confirmed reservation.
- User has no waiting entry.
- User is not banned/suspended.

Count only active confirmed reservations:

```sql
SELECT count(*)::integer AS confirmed_count
FROM reservations
WHERE event_id = $1
  AND status = 'CONFIRMED';
```

If `confirmed_count < capacity`, insert a confirmed reservation. Otherwise insert a waiting entry.

Example response shape:

```json
{
  "data": {
    "attendanceStatus": "CONFIRMED",
    "reservationId": "..."
  }
}
```

or:

```json
{
  "data": {
    "attendanceStatus": "WAITLISTED",
    "waitlistEntryId": "...",
    "position": 3
  }
}
```

Both outcomes created a resource, so `201` is reasonable. Document your chosen contract.

Calculate waitlist position from ordered waiting entries. Do not store a mutable integer position unless you are prepared to renumber and synchronize it.

Tests:

- Available place creates confirmed reservation.
- Full event creates waiting entry.
- Duplicate confirmed attempt conflicts.
- Duplicate waiting attempt conflicts.
- Confirmed user cannot also waitlist.
- Waiting user cannot also reserve through another code path.
- Non-member and banned user are rejected.
- Cancelled/unpublished/past event is rejected.

## Step 21: Implement cancellation and atomic promotion

Implement:

```text
DELETE /api/events/:eventId/reservations/me
DELETE /api/events/:eventId/waitlist/me
```

Reservation cancellation transaction:

```text
BEGIN
→ lock event row FOR UPDATE
→ update caller’s CONFIRMED reservation to CANCELLED_BY_USER
→ select first WAITING entry ordered by joined_at, id FOR UPDATE
→ if found, mark it PROMOTED
→ insert its CONFIRMED reservation
→ insert WAITLIST_PROMOTED notification
COMMIT
```

Select the next entry deterministically:

```sql
SELECT id, user_id
FROM waitlist_entries
WHERE event_id = $1
  AND status = 'WAITING'
ORDER BY joined_at ASC, id ASC
LIMIT 1
FOR UPDATE;
```

Because the event row is already locked consistently, only one promotion transaction for that event proceeds at a time. `FOR UPDATE` on the waitlist row makes the selected-row mutation explicit and protects against future workers that follow the protocol.

All four state changes—cancellation, waitlist update, promoted reservation, notification—must commit or roll back together.

Waitlist cancellation only changes a caller’s `WAITING` entry to `CANCELLED`; it does not affect capacity.

Tests:

- Cancelling a confirmed reservation marks it cancelled.
- Oldest waiting user is promoted.
- Tied timestamps are resolved by ID.
- Exactly one user is promoted.
- Notification belongs to promoted user.
- Failure while inserting notification rolls back promotion and cancellation.
- Cancelling without an active reservation returns `404` or your documented idempotent result.
- Cancelling a waitlist entry does not promote anyone.

## Step 22: Prove the final-place race

This is the defining Phase 2 test.

Arrange:

1. Create one active community.
2. Add two active users/members.
3. Create a published capacity-1 event.

Act:

```ts
const [first, second] = await Promise.all([
  reservationService.reserve(eventId, userAId),
  reservationService.reserve(eventId, userBId),
]);
```

Assert directly in PostgreSQL:

```text
confirmed reservation count = 1
waiting entry count = 1
no user appears in both active states
```

Run it repeatedly to increase confidence:

```powershell
1..50 | ForEach-Object { yarn test tests/integration/reservations.concurrent.test.ts }
```

Do not make the test pass by placing a JavaScript mutex around the service. That would only coordinate one Node process and would fail after horizontal scaling or another worker is introduced.

Temporarily remove `FOR UPDATE`, run the repeated race, and observe whether the test can expose overbooking. Restore the lock immediately afterward.

Checkpoint:

```text
I can explain the exact database wait order that prevents two confirmed reservations for capacity 1.
```

## Step 23: Add idempotency as a second migration

Create `db/migrations/002_idempotency_keys.sql` rather than editing `001`:

```sql
CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,

  CONSTRAINT idempotency_keys_user_scope_key_key
    UNIQUE (user_id, scope, key),
  CONSTRAINT idempotency_keys_http_status_check
    CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 599)
);
```

For reservation creation:

- Require or accept an `Idempotency-Key` header according to the API contract.
- Scope it to the operation and event, such as `reserve:<eventId>`.
- Hash the normalized request identity/body.
- A repeated key with the same request returns the stored result.
- A repeated key with a different request returns `409 IDEMPOTENCY_KEY_REUSED`.
- The idempotency record and reservation/waitlist mutation belong to one transaction.
- Concurrent identical requests cannot create duplicate effects because of the unique constraint.

Do not store an unbounded response forever. Retention/cleanup is a later operational concern; note it explicitly.

Tests:

- Same key and request returns same outcome.
- Same key with conflicting request returns `409`.
- Concurrent repeated key creates one effect.
- Mid-transaction failure does not leave a completed idempotency response.

## Step 24: Implement readiness and graceful database shutdown

Health endpoints:

```text
GET /health/live
GET /health/ready
```

Liveness:

```text
Node event loop and HTTP server are responding.
```

Readiness:

```text
Run SELECT 1 through the pool within a short bound.
If it succeeds: 200 { status: "ready" }
If it fails:    503 { status: "not_ready" }
```

Do not return database hostnames, credentials, or raw error messages.

Update Compose’s app health check to `/health/ready` if you want Compose health to represent whether the API can serve database-backed routes. Be able to explain why some production systems keep liveness and readiness separate rather than restarting a process during every dependency outage.

Refactor graceful shutdown:

```text
receive SIGTERM/SIGINT
→ stop accepting HTTP requests
→ allow active requests a bounded time
→ close PostgreSQL pool with pool.end()
→ close remaining connections if timeout expires
→ allow process to exit
```

Guard against running shutdown twice. Log each phase without leaking secrets.

Failure experiment:

```powershell
docker compose stop postgres
Invoke-RestMethod -Uri http://127.0.0.1:3000/health/live
Invoke-WebRequest -Uri http://127.0.0.1:3000/health/ready -SkipHttpErrorCheck
docker compose start postgres
```

Expected:

- Liveness can still succeed while Node is alive.
- Readiness returns `503` while PostgreSQL is unavailable.
- The pool can establish usable connections again after PostgreSQL returns.

## Step 25: Separate test levels

### Unit tests

Test logic without Docker/database access where possible:

- Zod schemas
- Pagination normalization
- Error mapping
- Time/capacity business rules
- Environment parsing

### Repository integration tests

Use a disposable real PostgreSQL container:

```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
```

Test:

- SQL mapping
- Constraints
- Transactions and rollback
- Filters
- Partial unique indexes
- Row-lock behavior

### API tests

Use Supertest with `createApp(testDependencies)`:

- Status codes
- Validation
- Headers/request ID
- Temporary identity
- Error shape
- Pagination
- Complete HTTP behavior

### End-to-end test

Exercise the full target flow from community creation through waitlist promotion and notification.

Never point automated integration tests at the development Compose database. Each test suite must control disposable state.

## Step 26: Build a reusable PostgreSQL test harness

Create a helper that:

1. Starts `postgres:17-bookworm` with Testcontainers in `beforeAll`.
2. Creates a `pg.Pool` from the container’s host/port/database/user/password.
3. Runs the same production migration runner against it.
4. Exposes the pool and application factory dependencies.
5. Truncates application tables between tests in a safe dependency-aware command.
6. Calls `pool.end()`.
7. Stops the container in `afterAll`.

Possible cleanup for this isolated test database:

```sql
TRUNCATE TABLE
  notifications,
  idempotency_keys,
  waitlist_entries,
  reservations,
  events,
  community_memberships,
  communities,
  users
RESTART IDENTITY CASCADE;
```

Reseed fixed users after truncation when a test needs them.

Configure a longer timeout for container startup, not for every fast unit test. Avoid sharing mutable database state across concurrently executing test files unless each gets its own database/schema.

Checkpoint:

```text
Integration tests work on a clean machine with Docker and do not depend on my development volume.
```

## Step 27: Document the API with OpenAPI

Create `docs/openapi.yaml` and describe the implemented contract—not aspirational future endpoints.

Document:

- Base path `/api`
- Temporary `x-user-id` header, clearly marked as development-only
- `Idempotency-Key` where applicable
- Request/response schemas
- Error envelope
- Pagination parameters and metadata
- Status codes
- Community/event filters
- Confirmed vs waitlisted reservation outcomes

Keep examples free of real secrets or private data.

Whenever an endpoint behavior changes, update its API tests and OpenAPI contract in the same change.

## Step 28: Run the complete quality gate

Host checks:

```powershell
yarn format:check
yarn lint
yarn typecheck
yarn test
yarn build
```

Container checks:

```powershell
docker compose config --quiet
docker compose build app
docker compose up --detach
docker compose ps
Invoke-RestMethod -Uri http://127.0.0.1:3000/health/live
Invoke-RestMethod -Uri http://127.0.0.1:3000/health/ready
```

Migration checks:

```powershell
docker compose run --rm app node dist/infrastructure/postgres/migrate.js
docker compose run --rm app node dist/infrastructure/postgres/migrate.js
```

The second migration run must be a no-op.

Inspect logs after stopping:

```powershell
docker compose stop app
docker compose logs app
```

Confirm graceful HTTP and pool shutdown.

## Step 29: Failure drills

Perform these intentionally and restore the correct state afterward.

### SQL injection attempt

Submit text containing quotes and SQL syntax. Parameterized queries should store/reject it as data rather than execute it.

### Unique violation

Create the same community slug concurrently. One succeeds; the other becomes a safe `409`, not a raw SQL error.

### Mid-transaction failure

Force failure after community insertion but before owner membership. Neither row should remain.

### PostgreSQL outage

Stop PostgreSQL while the API runs. Readiness fails safely, requests receive controlled errors, and credentials are not logged.

### Pool pressure

Temporarily use a small pool and send concurrent queries. Observe waiting rather than creating unlimited connections. Ensure every checked-out client is released.

### Migration failure

Run an invalid pending migration. It must roll back and remain absent from `schema_migrations`.

### Final-place race

Run the concurrency test repeatedly. Capacity is never exceeded.

### Duplicate cancellation/promotion

Send two cancellation requests concurrently. At most one cancellation transition and one promotion occur.

## Step 30: Phase 2 completion examination

You are ready for Phase 3 only when you can explain and demonstrate:

1. How Express middleware order affects a request.
2. Why controllers remain thin.
3. Which rules belong in services versus PostgreSQL constraints.
4. Why repositories map rows instead of returning `SELECT *` directly.
5. Why every external value uses SQL parameters.
6. Why a process normally owns one pool.
7. Why all transaction statements use one checked-out client.
8. How migrations are ordered, recorded, locked, and rolled back.
9. Why creating a community and owner membership is atomic.
10. Why event capacity cannot be protected by a JavaScript `if`.
11. How locking the event row serializes reservation and cancellation changes.
12. How a partial unique index prevents duplicate active reservations.
13. Why cross-table reservation/waitlist exclusivity still needs transaction logic.
14. How cancellation and waitlist promotion commit together.
15. How idempotency differs from ordinary uniqueness.
16. Why liveness and readiness answer different questions.
17. How PostgreSQL pool shutdown joins graceful HTTP shutdown.
18. Why Testcontainers tests do not use the development database.
19. Which Docker changes require rebuild versus restart/recreation.
20. Why Prisma has not been introduced yet.

Final proof:

```text
Two concurrent users request the final place.
Exactly one is confirmed.
Exactly one waits.
The confirmed user cancels.
Exactly one waiting user is promoted.
All state and notification changes are committed atomically.
```

## Suggested commit sequence

Keep changes understandable:

```text
1. chore: add Docker development target
2. chore: add environment validation and PostgreSQL pool
3. feat: add SQL migration runner and initial schema
4. feat: replace native routing with Express foundation
5. feat: add shared validation and error handling
6. feat: add communities and owner membership
7. feat: add open community membership
8. feat: add events API
9. feat: add reservation and waitlist transaction
10. feat: add cancellation and promotion transaction
11. feat: add idempotency handling
12. test: add PostgreSQL concurrency and e2e scenarios
13. docs: add OpenAPI contract and Phase 2 notes
```

## Common mistakes

```text
Creating a pool per request
Using string interpolation in SQL
Using pool.query for a multi-statement transaction
Forgetting client.release in finally
Returning raw database rows from controllers
Putting SQL in route handlers
Starting the server when app.ts is imported
Adding error middleware before routers
Trusting x-user-id as real authentication
Counting capacity without locking the event row
Locking different resources in inconsistent order
Deleting waitlist history instead of changing status
Editing an already-applied migration
Running integration tests against the development volume
Adding Prisma before completing the handwritten-SQL exercise
Treating depends_on as runtime database resilience
Logging SQL errors or secrets to clients
```

## Official references

- [Express middleware](https://expressjs.com/en/guide/using-middleware.html)
- [Express 5 migration notes](https://expressjs.com/en/guide/migrating-5.html)
- [Express error handling](https://expressjs.com/en/guide/error-handling.html)
- [node-postgres queries and parameters](https://node-postgres.com/features/queries)
- [node-postgres pooling](https://node-postgres.com/features/pooling)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
- [PostgreSQL 17 data definition](https://www.postgresql.org/docs/17/ddl.html)
- [PostgreSQL 17 transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html)
- [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html)
- [PostgreSQL 17 partial and unique indexes](https://www.postgresql.org/docs/17/sql-createindex.html)
- [Testcontainers PostgreSQL module](https://node.testcontainers.org/modules/postgresql/)
