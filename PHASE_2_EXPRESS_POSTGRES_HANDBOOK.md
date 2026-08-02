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
      # Required for reliable file watching through Docker Desktop bind mounts.
      CHOKIDAR_USEPOLLING: 'true'
      CHOKIDAR_INTERVAL: '500'
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

The development override enables Chokidar polling because Docker Desktop can
make changed file contents visible inside its Linux VM without forwarding the
filesystem event that `tsx watch` normally relies on. The 500 ms interval keeps
hot reload responsive without polling continuously. Native `yarn dev` does not
need these environment variables.

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

Create these two files; do not leave them empty:

```text
src/infrastructure/postgres/migrate.ts
src/infrastructure/postgres/seed.ts
```

### Build the migration runner

Add this to `src/infrastructure/postgres/migrate.ts`:

```ts
import 'dotenv/config';

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { environment } from '../../config/env.js';
import { createPool } from './pool.js';

const migrationsDirectory = path.resolve(process.cwd(), 'db/migrations');
const migrationLockKey = '314159265358979';

const migrate = async (): Promise<void> => {
  const pool = createPool(environment);

  try {
    const client = await pool.connect();
    let lockAcquired = false;

    try {
      await client.query('SELECT pg_advisory_lock($1::bigint)', [migrationLockKey]);
      lockAcquired = true;

      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const migrationNames = (await readdir(migrationsDirectory))
        .filter((name) => name.endsWith('.sql'))
        .sort();

      const history = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
      const appliedNames = new Set(history.rows.map((row) => row.name));

      for (const name of migrationNames) {
        if (appliedNames.has(name)) continue;

        const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');

        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
          await client.query('COMMIT');
          console.info(`Applied migration: ${name}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }

      console.info('Database migrations are up to date');
    } finally {
      try {
        if (lockAcquired) {
          await client.query('SELECT pg_advisory_unlock($1::bigint)', [migrationLockKey]);
        }
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
};

try {
  await migrate();
} catch (error) {
  console.error('Database migration failed', error);
  process.exitCode = 1;
}
```

How it works:

1. `createPool(environment)` uses the same validated PostgreSQL settings as the
   application.
2. One checked-out client owns the session-level advisory lock for the entire
   run. A second runner waits instead of applying the same migration concurrently.
3. `schema_migrations` records filenames that committed successfully.
4. Reading and sorting `.sql` filenames makes `001_...`, `002_...`, and later
   migrations run in order.
5. Already-recorded files are skipped, so rerunning the command is safe.
6. Each pending file and its history insert share one transaction. If either
   fails, both roll back and the migration remains pending.
7. The nested `finally` blocks always release the advisory lock, database client,
   and pool, including after an error.

The filename is the migration identity. Once a migration has been applied to a
shared database, do not edit or rename it; add a new migration instead. This
simple runner intentionally does not support automatic down migrations.

### Build the development seed runner

Add this to `src/infrastructure/postgres/seed.ts`:

```ts
import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { environment } from '../../config/env.js';
import { createPool } from './pool.js';

const seedFile = path.resolve(process.cwd(), 'db/seeds/development.sql');

const seed = async (): Promise<void> => {
  if (environment.NODE_ENV === 'production') {
    throw new Error('Development seeds must not run with NODE_ENV=production');
  }

  const sql = await readFile(seedFile, 'utf8');
  const pool = createPool(environment);

  try {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.info('Development seed applied');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
};

try {
  await seed();
} catch (error) {
  console.error('Database seed failed', error);
  process.exitCode = 1;
}
```

How it differs from the migration runner:

- The seed runner reads only `db/seeds/development.sql`; it does not change the
  schema or write migration history.
- The SQL is wrapped in a transaction so a partial seed is rolled back.
- The `NODE_ENV` guard prevents accidental development data insertion into a
  production database.
- Repeatability comes from the SQL itself. The `ON CONFLICT` clause from Step 9
  makes the deterministic user inserts idempotent.

Run migrations before seeds because the seed depends on tables created by the
migrations.

### Add package commands

After writing both runners, add these scripts to `package.json`:

```json
{
  "scripts": {
    "db:migrate": "tsx src/infrastructure/postgres/migrate.ts",
    "db:migrate:prod": "node dist/infrastructure/postgres/migrate.js",
    "db:seed": "tsx src/infrastructure/postgres/seed.ts"
  }
}
```

If you copied the earlier `db:seed:prod` suggestion, remove it. Gatherly's
current seed is development-only; production data should not be populated from
`development.sql`.

`db:migrate` and `db:seed` use `tsx` to execute TypeScript in development.
`db:migrate:prod` executes the JavaScript emitted into `dist/` by `yarn build`.

Run inside the development app container so `PGHOST=postgres` works:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn db:migrate
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn db:seed
```

Inspect history and tables:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec postgres psql -U gatherly -d gatherly -c "TABLE schema_migrations;"
docker compose -f compose.yaml -f compose.dev.yaml exec postgres psql -U gatherly -d gatherly -c "\dt"
docker compose -f compose.yaml -f compose.dev.yaml exec postgres psql -U gatherly -d gatherly -c "TABLE users;"
```

Use your actual `.env` names if they differ.

Run the migration command twice. The second run should report nothing pending and make no schema changes.

Run the seed command twice as well. The second run should succeed without
creating duplicate users.

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

export const createApp = (): Express => {
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

- The function constructs and returns the app without opening a network port.
- Tests can create an isolated app for Supertest.
- Importing the app does not start a port.
- Later dependencies can be passed in explicitly instead of read from hidden
  globals.

### What are application dependencies?

An application dependency is a runtime value or collaborator that `createApp`
needs but should not construct for itself. It does **not** mean packages listed
under `dependencies` in `package.json`.

Examples introduced as the project grows:

```text
Step 12  CORS origin and whether development HTTP logging is enabled
Step 16  community controller/service assembled with a PostgreSQL repository
Later    readiness checks, reservation services, and notification services
```

Passing these values into the factory is dependency injection. It keeps the
composition root in `server.ts`, where real infrastructure is created, while
tests can pass controlled configuration or test doubles. It also avoids a route
silently importing a global pool and opening database connections during an
import.

There is nothing useful to inject yet in Step 11. Do not create an empty
`AppDependencies` interface or call `createApp({})` only for appearance. Use:

```ts
const app = createApp();
```

Step 12 changes the signature to accept its first two concrete configuration
dependencies. Add dependencies only when the app actually consumes them; do not
turn every helper function or npm package into an injected abstraction.

### Build the Step 11 composition root

A composition root is the one place that creates long-lived infrastructure and
connects the application's layers. For this project it is `src/server.ts`.

The earlier arrow list described the eventual application, not everything you
can construct in Step 11. Repositories, services, and controllers do not exist
until the first vertical slice in Step 16. Do not create empty versions merely
to satisfy a diagram.

The runnable Step 11 sequence is:

```text
load .env and parse environment
→ create application logger
→ create Express app
→ wrap it in a Node HTTP server
→ listen on the configured port
→ close the HTTP server during shutdown
```

Replace `src/server.ts` with:

```ts
import 'dotenv/config';

import { createServer } from 'node:http';

import pino from 'pino';

import { createApp } from './app.js';
import { environment } from './config/env.js';

const logger = pino(
  environment.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {},
);

const app = createApp();
const server = createServer(app);

server.listen(environment.PORT, () => {
  logger.info({ port: environment.PORT }, 'Gatherly HTTP server started');
});

let isShuttingDown = false;

const shutDown = (signal: NodeJS.Signals): void => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Graceful shutdown started');

  const forcedShutdown = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    process.exitCode = 1;
    server.closeAllConnections();
  }, 10_000);
  forcedShutdown.unref();

  server.close((error) => {
    clearTimeout(forcedShutdown);

    if (error) {
      logger.error({ error }, 'HTTP server failed to close cleanly');
      process.exitCode = 1;
      return;
    }

    logger.info('Graceful shutdown completed');
  });
};

process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
```

What each part does:

- `dotenv/config` loads `.env` before `environment` is evaluated. Importing
  `environment` then validates the values with the Zod schema from Step 4 and
  fails startup immediately if configuration is invalid.
- `pino(...)` creates the application logger. Development uses readable
  `pino-pretty` output; other environments keep structured JSON.
- `createApp()` assembles Express routes and middleware but does not bind a port.
- `createServer(app)` gives explicit ownership of the Node HTTP server to the
  composition root. Express is a compatible request listener.
- `server.listen(...)` is the only operation that opens the port. Tests import
  `createApp`, not `server.ts`, so they do not accidentally start a listener.
- The signal handlers stop accepting new connections and allow current work a
  bounded time to finish.

Keep `createServer(app)` instead of hiding startup in `app.listen()` because the
composition root must later coordinate HTTP, PostgreSQL, workers, and live
connections during shutdown.

### How the composition root grows later

The PostgreSQL pool factory already exists, but no repository consumes a pool in
Step 11. Creating unused infrastructure obscures the lesson and complicates
shutdown, so wait until Step 16. The eventual order is:

```text
environment
→ logger and PostgreSQL pool
→ repositories (receive the pool)
→ services (receive repositories)
→ controllers/routes (receive services)
→ Express app (mounts routes)
→ Node HTTP server
→ listen
```

Conceptually, Step 16 will add wiring like this to `server.ts` (the exact names
must match the implementations you create in that step):

```ts
const pool = createPool(environment);

const communitiesRepository = new CommunitiesRepository(pool);
const communitiesService = new CommunitiesService(communitiesRepository);
const communitiesController = new CommunitiesController(communitiesService);

const app = createApp({
  corsOrigin: environment.CORS_ORIGIN,
  enableHttpLogging: environment.NODE_ENV === 'development',
  communitiesController,
});

const server = createServer(app);
```

This is manual dependency injection: construction points inward one layer at a
time, while business modules never reach outward to import a global pool. Route
registration may accept the controller and return an Express router; `createApp`
then mounts that router.

Once the pool is created, graceful shutdown must own it too. After the HTTP
server stops accepting work, call:

```ts
await pool.end();
```

Do not copy that line into the Step 11 callback yet because there is no Step 11
pool. Step 16 should convert shutdown coordination to an async function and
close every resource that the composition root actually created.

Update the Compose application health check from `/health` to `/health/live` temporarily. Later in this phase decide whether Compose should use liveness or readiness and be able to explain the tradeoff.

Update the existing health API test to call `createApp()` and `/health/live`.

Checkpoint:

```text
Express handles requests, but importing createApp still does not open a port.
```

## Step 12: Assemble middleware in the correct order

The final application order will be:

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

Do not implement future steps prematurely. In this step, add items 1–5. Step 13
adds the terminal not-found and error middleware, Step 15 adds the temporary
request-user middleware, and Step 16 adds the first API router.

### Request IDs

Use `crypto.randomUUID()` when an incoming trusted request ID is absent. Return it in an `x-request-id` response header and include it in logs/errors.

Do not blindly trust an arbitrarily long incoming header. Validate its length/format or always create your own ID.

For now, always create a server-owned ID. Trusting IDs from a reverse proxy
requires an explicit proxy boundary that this local phase does not have.

Add this to `src/shared/logging/request-id.middleware.ts`:

```ts
import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

export const requestIdMiddleware: RequestHandler = (_request, response, next) => {
  const requestId = randomUUID();

  response.locals.requestId = requestId;
  response.setHeader('x-request-id', requestId);
  next();
};
```

`response.locals` is scoped to one request. Step 13 will read the same value
when it creates the error response.

### Morgan

Use Morgan during this learning phase to observe request middleware:

```text
POST /api/events/... 201 34 ms request=<id>
```

Avoid logging request bodies, credentials, tokens, or private content.

Add this to `src/shared/logging/logger.ts`:

```ts
import type { RequestHandler } from 'express';
import morgan from 'morgan';

morgan.token('request-id', (_request, response) => {
  const value = response.getHeader('x-request-id');
  return typeof value === 'string' ? value : '-';
});

export const createDevelopmentHttpLogger = (): RequestHandler =>
  morgan(':method :url :status :response-time ms request=:request-id');
```

The request-ID middleware must run before Morgan. Morgan writes its line when
the response finishes, but its token still needs the header established earlier
in the chain.

### Helmet and CORS

Helmet adds defensive response headers. CORS controls which browser origins may read API responses; it is not authentication and does not stop non-browser clients.

Make the allowed browser origin explicit rather than reflecting every incoming
origin. Add this field to `environmentSchema` in `src/config/env.ts`:

```ts
CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
```

Add the corresponding local setting to `.env.example` and `.env`:

```dotenv
CORS_ORIGIN=http://localhost:5173
```

Pass it into the application container in `compose.yaml`:

```yaml
environment:
  CORS_ORIGIN: ${CORS_ORIGIN}
```

Place that line under the existing `app.environment` mapping. The development
override inherits it.

### JSON limits

Keep an explicit JSON body limit. An API should not accept arbitrarily large bodies by default.

This API does not need HTML-form parsing, so remove the existing 100 MB
`express.urlencoded(...)` middleware. Add it later only if an actual endpoint
requires form-encoded input, with a small deliberate limit.

### Assemble the application

Replace `src/app.ts` with:

```ts
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { createDevelopmentHttpLogger } from './shared/logging/logger.js';
import { requestIdMiddleware } from './shared/logging/request-id.middleware.js';

export interface AppDependencies {
  corsOrigin: string;
  enableHttpLogging: boolean;
}

export const createApp = (dependencies: AppDependencies): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: dependencies.corsOrigin }));
  app.use(requestIdMiddleware);

  if (dependencies.enableHttpLogging) {
    app.use(createDevelopmentHttpLogger());
  }

  app.use(express.json({ limit: '1mb' }));

  app.get('/health/live', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  // Step 15: temporary request-user middleware on protected API routes.
  // Step 16: API routers.
  // Step 13: not-found middleware, then error middleware.

  return app;
};
```

The comments are placement markers, not middleware calls. Do not import the
still-empty future-step files just to make the order look complete.

Update the application creation in `src/server.ts`:

```ts
const app = createApp({
  corsOrigin: environment.CORS_ORIGIN,
  enableHttpLogging: environment.NODE_ENV === 'development',
});
```

Keep application HTTP logging disabled in tests so test output stays readable.
Production structured HTTP logging comes later; Morgan is deliberately a
development learning tool here.

### Update the health API test

Replace `tests/api/health.test.ts` with:

```ts
import request from 'supertest';

import { createApp } from '../../src/app.js';

const app = createApp({
  corsOrigin: 'http://localhost:5173',
  enableHttpLogging: false,
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
```

Run:

```powershell
yarn typecheck
yarn lint
yarn test:api
```

Immediate checkpoint tests:

- JSON responses include an `x-request-id` header.
- The configured browser origin receives the expected CORS response header.
- Helmet adds defensive headers such as `x-content-type-options`.

After Step 13 adds the two terminal handlers, also test that:

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

Implement `src/shared/errors/app-error.ts`:

```ts
export class AppError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
```

Implement `src/shared/errors/not-found-handler.ts`:

```ts
import type { RequestHandler } from 'express';

import { AppError } from './app-error.js';

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `Route ${request.method} ${request.path} not found`));
};
```

Implement `src/shared/errors/error-handler.ts` (rename the current misspelled
`error-handle.ts` placeholder):

```ts
import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

import { AppError } from './app-error.js';

const isMalformedJson = (error: unknown): boolean =>
  error instanceof SyntaxError &&
  'type' in error &&
  (error as { type?: unknown }).type === 'entity.parse.failed';

export const createErrorHandler =
  (logger: Logger): ErrorRequestHandler =>
  (error, request, response, _next) => {
    const requestId =
      typeof response.locals.requestId === 'string' ? response.locals.requestId : 'unknown';

    const appError = isMalformedJson(error)
      ? new AppError(400, 'MALFORMED_JSON', 'Request body contains invalid JSON')
      : error instanceof AppError
        ? error
        : new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');

    if (appError.status >= 500) {
      logger.error(
        { err: error, requestId, method: request.method, path: request.path },
        'Request failed',
      );
    }

    response.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        requestId,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      },
    });
  };
```

Pass the Pino logger through `AppDependencies`, then place the terminal handlers
after health routes and all API routers:

```ts
app.use(notFoundHandler);
app.use(createErrorHandler(dependencies.logger));
```

In tests, provide `pino({ enabled: false })`. The four-argument error-handler
signature is significant: Express distinguishes error middleware by arity.

Add API tests that request an unknown route and send broken JSON:

```ts
expect((await request(app).get('/missing')).body.error.code).toBe('ROUTE_NOT_FOUND');

const malformed = await request(app)
  .post('/api/example')
  .set('content-type', 'application/json')
  .send('{');
expect(malformed.status).toBe(400);
expect(malformed.body.error.code).toBe('MALFORMED_JSON');
```

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
    city: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .transform((value) => value ?? null),
    country: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional()
      .transform((value) => value ?? null),
  }),
});
```

Do not validate only in TypeScript types. Types disappear at runtime and do not protect the API from malformed JSON.

Use parsed data—not the original body—after validation so trimming, coercion, defaults, and rejected unknown fields behave deliberately.

Decide whether request objects are `.strict()` or strip unknown keys, document the choice, and test it.

Implement `src/shared/validation/validate.middleware.ts`:

```ts
import type { RequestHandler, Response } from 'express';
import { type ZodType, z } from 'zod';

import { AppError } from '../errors/app-error.js';

const requestBoundarySchema = z.object({
  body: z.unknown(),
  params: z.unknown(),
  query: z.unknown(),
});

export const validate =
  <T>(schema: ZodType<T>): RequestHandler =>
  (request, response, next) => {
    const boundary = requestBoundarySchema.parse({
      body: request.body,
      params: request.params,
      query: request.query,
    });
    const result = schema.safeParse(boundary);

    if (!result.success) {
      next(
        new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      );
      return;
    }

    response.locals.validated = result.data;
    next();
  };

export const getValidated = <T>(response: Response): T => response.locals.validated as T;
```

Store parsed data in `response.locals` instead of overwriting `request.query`;
Express 5 exposes `query` as a getter. A route wires validation before its
controller:

```ts
router.post('/', validate(createCommunityRequestSchema), controller.create);
```

The controller reads the parsed result, including trims and defaults:

```ts
const input = getValidated<z.infer<typeof createCommunityRequestSchema>>(response);
```

Use `.strict()` on body objects so misspelled client fields fail loudly during
this learning phase. Define pagination once:

```ts
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
```

Test trimming/defaults, rejected unknown body keys, coerced pagination, and the
safe issue shape. Never return the full Zod error object.

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

Implement `src/shared/http/request-user.middleware.ts`:

```ts
import type { RequestHandler, Response } from 'express';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';

const userIdSchema = z.string().uuid();

export const requireRequestUser: RequestHandler = (request, response, next) => {
  const result = userIdSchema.safeParse(request.headers['x-user-id']);

  if (!result.success) {
    next(new AppError(401, 'USER_REQUIRED', 'A valid x-user-id header is required'));
    return;
  }

  response.locals.userId = result.data;
  next();
};

export const getRequestUserId = (response: Response): string => {
  const userId: unknown = response.locals.userId;

  if (typeof userId !== 'string') {
    throw new AppError(500, 'INTERNAL_ERROR', 'Request user middleware was not applied');
  }

  return userId;
};
```

An array-valued duplicate header fails the string schema, satisfying the
"exactly one" rule. Mount the middleware only on protected routes:

```ts
router.post('/', requireRequestUser, validate(schema), controller.create);
```

Syntax validation is not existence or authorization. The service/repository
must still verify that this UUID identifies an active user and an eligible
membership for the requested object.

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

Implement the slice one layer at a time. Start with
`communities.types.ts`:

```ts
export interface CreateCommunityInput {
  name: string;
  slug: string;
  description: string;
  city: string | null;
  country: string | null;
}

export interface Community {
  id: string;
  name: string;
  slug: string;
  description: string;
  city: string | null;
  country: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommunityPage {
  items: Community[];
  page: number;
  limit: number;
  total: number;
}
```

Add the request schemas to `communities.schemas.ts`:

```ts
import { z } from 'zod';

import { paginationSchema } from '../../shared/validation/pagination.schema.js';

const uuid = z.string().uuid();

export const createCommunityRequestSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(3).max(100),
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      description: z.string().trim().max(2_000).default(''),
      city: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .transform((value) => value ?? null),
      country: z
        .string()
        .trim()
        .min(2)
        .max(100)
        .optional()
        .transform((value) => value ?? null),
    })
    .strict(),
  params: z.object({}),
  query: z.object({}),
});

export const listCommunitiesRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({}),
  query: paginationSchema,
});

export const getCommunityRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({ communityId: uuid }),
  query: z.object({}),
});
```

The two transforms normalize omitted location fields to `null`. The inferred
validated body therefore matches `CreateCommunityInput` exactly and the
controller can pass `body` directly without rebuilding it field by field.

Implement the persistence core in `communities.repository.ts`. Keep the mapping
function beside the SQL so database naming never leaks upward:

```ts
import pg, { type Pool } from 'pg';

import { AppError } from '../../shared/errors/app-error.js';
import { withTransaction } from '../../shared/database/transaction.js';
import type { Community, CommunityPage, CreateCommunityInput } from './communities.types.js';

interface CommunityRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  city: string | null;
  country: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

const mapCommunity = (row: CommunityRow): Community => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  description: row.description,
  city: row.city,
  country: row.country,
  createdByUserId: row.created_by_user_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const selection = `
  id, name, slug, description, city, country,
  created_by_user_id, created_at, updated_at
`;

export class CommunitiesRepository {
  public constructor(private readonly pool: Pool) {}

  public async createWithOwner(userId: string, input: CreateCommunityInput): Promise<Community> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const created = await client.query<CommunityRow>(
          `INSERT INTO communities
             (name, slug, description, city, country, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${selection}`,
          [input.name, input.slug, input.description, input.city, input.country, userId],
        );
        const community = created.rows[0];
        if (community === undefined) throw new Error('Community insert returned no row');

        await client.query(
          `INSERT INTO community_memberships (community_id, user_id, role, status)
           VALUES ($1, $2, 'OWNER', 'ACTIVE')`,
          [community.id, userId],
        );
        return mapCommunity(community);
      });
    } catch (error) {
      if (
        error instanceof pg.DatabaseError &&
        error.code === '23505' &&
        error.constraint === 'communities_slug_key'
      ) {
        throw new AppError(409, 'COMMUNITY_SLUG_TAKEN', 'That community slug is already used');
      }
      throw error;
    }
  }

  public async findById(id: string): Promise<Community | null> {
    const result = await this.pool.query<CommunityRow>(
      `SELECT ${selection} FROM communities WHERE id = $1 AND status = 'ACTIVE'`,
      [id],
    );
    return result.rows[0] === undefined ? null : mapCommunity(result.rows[0]);
  }

  public async list(page: number, limit: number): Promise<CommunityPage> {
    const offset = (page - 1) * limit;
    const [rows, count] = await Promise.all([
      this.pool.query<CommunityRow>(
        `SELECT ${selection}
         FROM communities
         WHERE status = 'ACTIVE' AND visibility = 'PUBLIC'
         ORDER BY created_at DESC, id DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      this.pool.query<{ total: number }>(
        `SELECT count(*)::integer AS total
         FROM communities WHERE status = 'ACTIVE' AND visibility = 'PUBLIC'`,
      ),
    ]);
    return { items: rows.rows.map(mapCommunity), page, limit, total: count.rows[0]?.total ?? 0 };
  }
}
```

The repository owns the atomic persistence operation; the service owns the use
case and safe not-found behavior:

```ts
export class CommunitiesService {
  public constructor(private readonly repository: CommunitiesRepository) {}

  public create(userId: string, input: CreateCommunityInput): Promise<Community> {
    return this.repository.createWithOwner(userId, input);
  }

  public list(page: number, limit: number): Promise<CommunityPage> {
    return this.repository.list(page, limit);
  }

  public async get(id: string): Promise<Community> {
    const community = await this.repository.findById(id);
    if (community === null) {
      throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'The requested community does not exist');
    }
    return community;
  }
}
```

Controllers only translate validated HTTP data. A DTO (data transfer object) is
the deliberate public JSON shape returned by the API. Define the mapper near
the controller in `communities.controller.ts`:

```ts
interface CommunityDto {
  id: string;
  name: string;
  slug: string;
  description: string;
  city: string | null;
  country: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

const toCommunityDto = (community: Community): CommunityDto => ({
  id: community.id,
  name: community.name,
  slug: community.slug,
  description: community.description,
  city: community.city,
  country: community.country,
  createdByUserId: community.createdByUserId,
  createdAt: community.createdAt.toISOString(),
  updatedAt: community.updatedAt.toISOString(),
});
```

The repository mapper converts a PostgreSQL row into the internal `Community`
type; `toCommunityDto` performs the separate internal-to-HTTP conversion. This
prevents database columns or future private fields from leaking merely because
they were added to a query.

Use the mapper in all three controller methods:

```ts
export class CommunitiesController {
  public constructor(private readonly service: CommunitiesService) {}

  public readonly create: RequestHandler = async (_request, response) => {
    const { body } = getValidated<z.infer<typeof createCommunityRequestSchema>>(response);
    const community = await this.service.create(getRequestUserId(response), body);
    response.status(201).json({ data: toCommunityDto(community) });
  };

  public readonly list: RequestHandler = async (_request, response) => {
    const { query } = getValidated<z.infer<typeof listCommunitiesRequestSchema>>(response);
    const page = await this.service.list(query.page, query.limit);
    response.json({
      data: page.items.map(toCommunityDto),
      pagination: { page: page.page, limit: page.limit, total: page.total },
    });
  };

  public readonly get: RequestHandler = async (_request, response) => {
    const { params } = getValidated<z.infer<typeof getCommunityRequestSchema>>(response);
    response.json({ data: toCommunityDto(await this.service.get(params.communityId)) });
  };
}
```

Wire routes last in `communities.routes.ts`:

```ts
export const createCommunitiesRouter = (controller: CommunitiesController): Router => {
  const router = Router();
  router.post('/', requireRequestUser, validate(createCommunityRequestSchema), controller.create);
  router.get('/', validate(listCommunitiesRequestSchema), controller.list);
  router.get('/:communityId', validate(getCommunityRequestSchema), controller.get);
  return router;
};
```

### Connect the communities slice to the application

Creating a router does not make Express use it. Pass the constructed router into
the app factory so tests can substitute a router without importing production
database infrastructure.

Add the router to `AppDependencies` in `src/app.ts`:

```ts
import express, { type Express, type Router } from 'express';

export interface AppDependencies {
  corsOrigin: string;
  enableHttpLogging: boolean;
  logger: Logger;
  communitiesRouter: Router;
}
```

Mount it after shared middleware and the health route, but before the terminal
404 and error handlers:

```ts
app.get('/health/live', (_request, response) => {
  response.status(200).json({ status: 'ok' });
});

app.use('/api/communities', dependencies.communitiesRouter);

app.use(notFoundHandler);
app.use(createErrorHandler(dependencies.logger));
```

The router defines paths relative to its mount point. Its `POST '/'` therefore
becomes `POST /api/communities`, and `GET '/:communityId'` becomes
`GET /api/communities/:communityId`. Mounting after `notFoundHandler` would make
every community request return 404 before reaching the router.

Now assemble the complete dependency chain in `src/server.ts`:

```ts
import { createPool } from './infrastructure/postgres/pool.js';
import { CommunitiesController } from './modules/communities/communities.controller.js';
import { CommunitiesRepository } from './modules/communities/communities.repository.js';
import { createCommunitiesRouter } from './modules/communities/communities.routes.js';
import { CommunitiesService } from './modules/communities/communities.service.js';

const pool = createPool(environment);
const communitiesRepository = new CommunitiesRepository(pool);
const communitiesService = new CommunitiesService(communitiesRepository);
const communitiesController = new CommunitiesController(communitiesService);
const communitiesRouter = createCommunitiesRouter(communitiesController);

const app = createApp({
  corsOrigin: environment.CORS_ORIGIN,
  enableHttpLogging: environment.NODE_ENV === 'development',
  logger,
  communitiesRouter,
});
```

This is the missing end-to-end connection:

```text
HTTP request
→ app.use('/api/communities', communitiesRouter)
→ route middleware
→ CommunitiesController
→ CommunitiesService
→ CommunitiesRepository
→ PostgreSQL pool
```

Because `server.ts` now creates the pool, it owns its cleanup. Until Step 24
introduces the fully coordinated async shutdown, close the pool after the HTTP
server finishes draining:

```ts
server.close((error) => {
  if (error) {
    logger.error({ err: error }, 'HTTP server failed to close cleanly');
    process.exitCode = 1;
  }

  void pool
    .end()
    .then(() => logger.info('HTTP server and PostgreSQL pool closed'))
    .catch((poolError: unknown) => {
      logger.error({ err: poolError }, 'PostgreSQL pool failed to close');
      process.exitCode = 1;
    })
    .finally(() => clearTimeout(forcedShutdown));
});
```

Update health-only tests with an empty router:

```ts
const app = createApp({
  corsOrigin: 'http://localhost:5173',
  enableHttpLogging: false,
  logger: pino({ enabled: false }),
  communitiesRouter: Router(),
});
```

Community API tests should pass the real `communitiesRouter` assembled with the
disposable test repository/service/controller chain. Do not let `app.ts` create
that chain itself; doing so would hide the database dependency and make isolated
app tests difficult.

Add the omitted imports in each file from the shared helpers shown in Steps
13–15. Keeping snippets separated by layer makes the dependency direction
visible; the complete files should contain the corresponding imports.

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

Because `(community_id, user_id)` is unique, rejoining updates the existing row
rather than inserting a duplicate. Choose idempotent join behavior: an
already-active member receives `200`; a newly created/reactivated membership
receives `201`.

Create a separate module because membership is its own domain concept even
though these routes are nested under a community URL:

```text
src/modules/memberships/
  memberships.routes.ts
  memberships.controller.ts
  memberships.service.ts
  memberships.repository.ts
  memberships.schemas.ts
  memberships.types.ts
```

### Membership types

Implement `memberships.types.ts`:

```ts
export type JoinPersistenceOutcome =
  | 'COMMUNITY_NOT_FOUND'
  | 'JOIN_NOT_AVAILABLE'
  | 'BLOCKED'
  | 'ALREADY_ACTIVE'
  | 'CREATED'
  | 'REACTIVATED';

export type LeavePersistenceOutcome = 'NOT_ACTIVE' | 'OWNER' | 'LEFT';

export interface JoinMembershipResult {
  created: boolean;
  status: 'ACTIVE';
}
```

The repository returns persistence outcomes rather than HTTP errors. The service
maps those outcomes to the API/domain contract.

### Membership schema

Implement `memberships.schemas.ts`:

```ts
import { z } from 'zod';

export const communityMembershipRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({ communityId: z.uuid() }),
  query: z.object({}),
});

export type CommunityMembershipRequest = z.infer<typeof communityMembershipRequestSchema>;
```

Both operations have the same path input and no body, so one boundary schema is
enough.

### Membership repository

Implement `memberships.repository.ts`:

```ts
import type { Pool } from 'pg';

import { withTransaction } from '../../shared/database/transaction.js';
import type { JoinPersistenceOutcome, LeavePersistenceOutcome } from './memberships.types.js';

interface CommunityRow {
  join_policy: string;
}

interface MembershipRow {
  role: string;
  status: string;
}

export class MembershipsRepository {
  public constructor(private readonly pool: Pool) {}

  public joinOpenCommunity(communityId: string, userId: string): Promise<JoinPersistenceOutcome> {
    return withTransaction(this.pool, async (client) => {
      const community = await client.query<CommunityRow>(
        `SELECT join_policy
         FROM communities
         WHERE id = $1 AND status = 'ACTIVE'
         FOR UPDATE`,
        [communityId],
      );
      const communityRow = community.rows[0];
      if (communityRow === undefined) return 'COMMUNITY_NOT_FOUND';
      if (communityRow.join_policy !== 'OPEN') return 'JOIN_NOT_AVAILABLE';

      const existing = await client.query<MembershipRow>(
        `SELECT role, status
         FROM community_memberships
         WHERE community_id = $1 AND user_id = $2
         FOR UPDATE`,
        [communityId, userId],
      );
      const membership = existing.rows[0];

      if (membership?.status === 'BANNED' || membership?.status === 'SUSPENDED') {
        return 'BLOCKED';
      }
      if (membership?.status === 'ACTIVE') return 'ALREADY_ACTIVE';

      if (membership === undefined) {
        await client.query(
          `INSERT INTO community_memberships (community_id, user_id, role, status)
           VALUES ($1, $2, 'MEMBER', 'ACTIVE')`,
          [communityId, userId],
        );
        return 'CREATED';
      }

      await client.query(
        `UPDATE community_memberships
         SET role = 'MEMBER', status = 'ACTIVE', joined_at = now(), updated_at = now()
         WHERE community_id = $1 AND user_id = $2`,
        [communityId, userId],
      );
      return 'REACTIVATED';
    });
  }

  public leaveCommunity(communityId: string, userId: string): Promise<LeavePersistenceOutcome> {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<MembershipRow>(
        `SELECT role, status
         FROM community_memberships
         WHERE community_id = $1 AND user_id = $2
         FOR UPDATE`,
        [communityId, userId],
      );
      const membership = existing.rows[0];

      if (membership?.status !== 'ACTIVE') return 'NOT_ACTIVE';
      if (membership.role === 'OWNER') return 'OWNER';

      await client.query(
        `UPDATE community_memberships
         SET status = 'LEFT', updated_at = now()
         WHERE community_id = $1 AND user_id = $2`,
        [communityId, userId],
      );
      return 'LEFT';
    });
  }
}
```

The community row is locked before join decisions so concurrent joins see one
ordered membership state. Leave locks the membership row that it transitions.
Neither operation deletes history.

### Membership service

Implement `memberships.service.ts`:

```ts
import { AppError } from '../../shared/errors/app-error.js';
import type { MembershipsRepository } from './memberships.repository.js';
import type { JoinMembershipResult } from './memberships.types.js';

export class MembershipsService {
  public constructor(private readonly repository: MembershipsRepository) {}

  public async join(communityId: string, userId: string): Promise<JoinMembershipResult> {
    const outcome = await this.repository.joinOpenCommunity(communityId, userId);

    switch (outcome) {
      case 'COMMUNITY_NOT_FOUND':
        throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'The requested community does not exist');
      case 'JOIN_NOT_AVAILABLE':
        throw new AppError(409, 'JOIN_NOT_AVAILABLE', 'This community cannot be joined directly');
      case 'BLOCKED':
        throw new AppError(403, 'COMMUNITY_ACCESS_DENIED', 'Community access is denied');
      case 'ALREADY_ACTIVE':
        return { created: false, status: 'ACTIVE' };
      case 'CREATED':
      case 'REACTIVATED':
        return { created: true, status: 'ACTIVE' };
    }
  }

  public async leave(communityId: string, userId: string): Promise<void> {
    const outcome = await this.repository.leaveCommunity(communityId, userId);

    switch (outcome) {
      case 'NOT_ACTIVE':
        throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'No active membership exists');
      case 'OWNER':
        throw new AppError(409, 'OWNER_CANNOT_LEAVE', 'Transfer ownership before leaving');
      case 'LEFT':
        return;
    }
  }
}
```

The service is where persistence outcomes become stable HTTP-facing domain
errors. The exhaustive `switch` also forces TypeScript to flag new outcomes that
are not handled.

### Membership controller

Implement `memberships.controller.ts`:

```ts
import type { RequestHandler } from 'express';

import { getRequestUserId } from '../../shared/http/request-user.middleware.js';
import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { MembershipsService } from './memberships.service.js';
import type { CommunityMembershipRequest } from './memberships.schemas.js';

export class MembershipsController {
  public constructor(private readonly service: MembershipsService) {}

  public readonly join: RequestHandler = async (_request, response) => {
    const { params } = getValidated<CommunityMembershipRequest>(response);
    const result = await this.service.join(params.communityId, getRequestUserId(response));
    response.status(result.created ? 201 : 200).json({ data: { status: result.status } });
  };

  public readonly leave: RequestHandler = async (_request, response) => {
    const { params } = getValidated<CommunityMembershipRequest>(response);
    await this.service.leave(params.communityId, getRequestUserId(response));
    response.status(204).send();
  };
}
```

Use `POST .../leave` because leaving is a state transition that preserves the
membership resource/history. It is not a row deletion.

### Membership router

Implement `memberships.routes.ts`:

```ts
import { Router } from 'express';

import { requireRequestUser } from '../../shared/http/request-user.middleware.js';
import { validate } from '../../shared/validation/validate.middleware.js';
import type { MembershipsController } from './memberships.controller.js';
import { communityMembershipRequestSchema } from './memberships.schemas.js';

export const createMembershipsRouter = (controller: MembershipsController): Router => {
  const router = Router();
  router.post(
    '/:communityId/join',
    requireRequestUser,
    validate(communityMembershipRequestSchema),
    controller.join,
  );
  router.post(
    '/:communityId/leave',
    requireRequestUser,
    validate(communityMembershipRequestSchema),
    controller.leave,
  );
  return router;
};
```

### Connect the membership router

Add `membershipsRouter: Router` to `AppDependencies` and mount it beside the
community router, before `notFoundHandler`:

```ts
app.use('/api/communities', dependencies.communitiesRouter);
app.use('/api/communities', dependencies.membershipsRouter);

app.use(notFoundHandler);
app.use(createErrorHandler(dependencies.logger));
```

Two routers can share a mount point. Express tries their matching method/path
handlers in registration order and continues when the first router has no
matching route.

Add the membership chain to `server.ts`:

```ts
const membershipsRepository = new MembershipsRepository(pool);
const membershipsService = new MembershipsService(membershipsRepository);
const membershipsController = new MembershipsController(membershipsService);
const membershipsRouter = createMembershipsRouter(membershipsController);

const app = createApp({
  corsOrigin: environment.CORS_ORIGIN,
  enableHttpLogging: environment.NODE_ENV === 'development',
  logger,
  communitiesRouter,
  membershipsRouter,
});
```

Import the four membership constructors/factory from their module files. Add an
empty `membershipsRouter: Router()` to health-only tests.

### Membership tests

At minimum, make the chosen idempotent contract executable:

```ts
const first = await request(app)
  .post(`/api/communities/${communityId}/join`)
  .set('x-user-id', bobId);
const repeated = await request(app)
  .post(`/api/communities/${communityId}/join`)
  .set('x-user-id', bobId);

expect(first.status).toBe(201);
expect(repeated.status).toBe(200);
expect(first.body.data).toEqual({ status: 'ACTIVE' });
```

Also test:

- A banned or suspended user receives `403` and remains blocked.
- Approval-required/invite-only communities receive `409 JOIN_NOT_AVAILABLE`.
- Leave changes `ACTIVE` to `LEFT` and returns `204`.
- An owner receives `409 OWNER_CANNOT_LEAVE` and stays active.
- A nonexistent community receives `404 COMMUNITY_NOT_FOUND`.
- Concurrent join requests leave exactly one membership row because of the
  unique constraint and transaction.

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

Validate creation at the boundary in `events.schemas.ts`:

```ts
const eventBodySchema = z
  .object({
    title: z.string().trim().min(3).max(150),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().max(10_000).default(''),
    format: z.enum(['IN_PERSON', 'ONLINE', 'HYBRID']).default('IN_PERSON'),
    visibility: z.enum(['PUBLIC', 'COMMUNITY_ONLY', 'INVITE_ONLY']).default('PUBLIC'),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    timezone: z.string().trim().min(1).max(100),
    capacity: z.number().int().positive(),
  })
  .strict()
  .refine((body) => Date.parse(body.startsAt) < Date.parse(body.endsAt), {
    path: ['endsAt'],
    message: 'endsAt must be later than startsAt',
  });

export const createEventRequestSchema = z.object({
  body: eventBodySchema,
  params: z.object({ communityId: z.string().uuid() }),
  query: z.object({}),
});
```

The service first authorizes the exact community object, then calls the insert:

```ts
public async create(communityId: string, userId: string, input: CreateEventInput): Promise<Event> {
  const authorization = await this.repository.findCreationAuthorization(communityId, userId);
  if (authorization === null || authorization.communityStatus !== 'ACTIVE') {
    throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'The requested community does not exist');
  }
  if (
    authorization.membershipStatus !== 'ACTIVE' ||
    !['OWNER', 'ORGANIZER', 'MODERATOR'].includes(authorization.role ?? '')
  ) {
    throw new AppError(403, 'COMMUNITY_PERMISSION_DENIED', 'You cannot create events here');
  }
  if (Date.parse(input.startsAt) >= Date.parse(input.endsAt)) {
    throw new AppError(400, 'INVALID_EVENT_TIME', 'Event end must be after its start');
  }
  return this.repository.create(communityId, userId, input);
}
```

The repository authorization query prevents cross-community ID substitution:

```sql
SELECT
  c.status AS community_status,
  m.status AS membership_status,
  m.role
FROM communities AS c
LEFT JOIN community_memberships AS m
  ON m.community_id = c.id
 AND m.user_id = $2
WHERE c.id = $1;
```

Insert with explicit columns and map the row:

```ts
const result = await this.pool.query<EventRow>(
  `INSERT INTO events
     (community_id, created_by_user_id, title, slug, description, format,
      visibility, starts_at, ends_at, timezone, capacity)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
   RETURNING id, community_id, created_by_user_id, title, slug, description,
             format, status, visibility, starts_at, ends_at, timezone,
             capacity, created_at, updated_at`,
  [
    communityId,
    userId,
    input.title,
    input.slug,
    input.description,
    input.format,
    input.visibility,
    input.startsAt,
    input.endsAt,
    input.timezone,
    input.capacity,
  ],
);
```

Translate PostgreSQL `23505` for `events_community_slug_key` into a safe
`409 EVENT_SLUG_TAKEN` near this query. The database still independently checks
time order and capacity.

Build list filters only from known branches:

```ts
const clauses = [`e.status <> 'ARCHIVED'`];
const values: unknown[] = [];
const add = (sql: string, value: unknown): void => {
  values.push(value);
  clauses.push(`${sql} $${values.length}`);
};

if (filters.communityId !== undefined) add('e.community_id =', filters.communityId);
if (filters.status !== undefined) add('e.status =', filters.status);
if (filters.startsAfter !== undefined) add('e.starts_at >=', filters.startsAfter);
if (filters.startsBefore !== undefined) add('e.starts_at <', filters.startsBefore);

values.push(filters.limit, (filters.page - 1) * filters.limit);
const sql = `
  SELECT id, community_id, created_by_user_id, title, slug, description,
         format, status, visibility, starts_at, ends_at, timezone,
         capacity, created_at, updated_at
  FROM events AS e
  WHERE ${clauses.join(' AND ')}
  ORDER BY e.starts_at ASC, e.id ASC
  LIMIT $${values.length - 1} OFFSET $${values.length}
`;
```

Only the values are dynamic; every SQL operator and column comes from code. Add
the three routes with the same `requireRequestUser → validate → controller`
pattern for creation and `validate → controller` for public reads.

Tests:

- Owner can create an event.
- Ordinary member cannot create an event.
- Organizer from another community cannot create here.
- Invalid time order is rejected.
- Zero/negative capacity is rejected.
- Duplicate event slug within one community conflicts.
- Same slug in another community is allowed.
- Filters and pagination are deterministic.

### Complete event implementation

The earlier snippets show the critical rules but are not a complete slice. Use
the following files together. Create:

```text
src/modules/events/
  events.routes.ts
  events.controller.ts
  events.service.ts
  events.repository.ts
  events.schemas.ts
  events.types.ts
```

This first read API exposes only public, non-draft events. Private and
community-only reads require additional authorization rules and should not be
silently exposed here.

#### `events.types.ts`

```ts
export type EventFormat = 'IN_PERSON' | 'ONLINE' | 'HYBRID';
export type EventVisibility = 'PUBLIC' | 'COMMUNITY_ONLY' | 'INVITE_ONLY';
export type PublicEventStatus = 'PUBLISHED' | 'CANCELLED' | 'COMPLETED';

export interface CreateEventInput {
  title: string;
  slug: string;
  description: string;
  format: EventFormat;
  visibility: EventVisibility;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  capacity: number;
}

export interface Event {
  id: string;
  communityId: string;
  createdByUserId: string;
  title: string;
  slug: string;
  description: string;
  format: EventFormat;
  status: string;
  visibility: EventVisibility;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  capacity: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventFilters {
  communityId: string | null;
  status: PublicEventStatus | null;
  startsAfter: Date | null;
  startsBefore: Date | null;
  page: number;
  limit: number;
}

export interface EventPage {
  items: Event[];
  page: number;
  limit: number;
  total: number;
}

export interface EventCreationAuthorization {
  communityStatus: string;
  membershipStatus: string | null;
  role: string | null;
}
```

Dates are `Date` objects inside the application and ISO strings at the HTTP
boundary. Optional query filters are normalized to explicit `null`, avoiding
`exactOptionalPropertyTypes` mismatches.

#### `events.schemas.ts`

```ts
import { z } from 'zod';

import { paginationSchema } from '../../shared/validation/pagination.schema.js';

const instantSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const optionalInstantSchema = z.iso
  .datetime({ offset: true })
  .optional()
  .transform((value) => (value === undefined ? null : new Date(value)));

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Invalid IANA time-zone identifier');

const eventBodySchema = z
  .object({
    title: z.string().trim().min(3).max(150),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().max(10_000).default(''),
    format: z.enum(['IN_PERSON', 'ONLINE', 'HYBRID']).default('IN_PERSON'),
    visibility: z.enum(['PUBLIC', 'COMMUNITY_ONLY', 'INVITE_ONLY']).default('PUBLIC'),
    startsAt: instantSchema,
    endsAt: instantSchema,
    timezone: timezoneSchema,
    capacity: z.number().int().positive(),
  })
  .strict()
  .refine((body) => body.startsAt < body.endsAt, {
    path: ['endsAt'],
    message: 'endsAt must be later than startsAt',
  });

export const createEventRequestSchema = z.object({
  body: eventBodySchema,
  params: z.object({ communityId: z.uuid() }),
  query: z.object({}),
});

export const listEventsRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({}),
  query: paginationSchema
    .extend({
      communityId: z
        .uuid()
        .optional()
        .transform((value) => value ?? null),
      status: z
        .enum(['PUBLISHED', 'CANCELLED', 'COMPLETED'])
        .optional()
        .transform((value) => value ?? null),
      startsAfter: optionalInstantSchema,
      startsBefore: optionalInstantSchema,
    })
    .refine(
      (query) =>
        query.startsAfter === null ||
        query.startsBefore === null ||
        query.startsAfter < query.startsBefore,
      { path: ['startsBefore'], message: 'startsBefore must be after startsAfter' },
    ),
});

export const getEventRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({ eventId: z.uuid() }),
  query: z.object({}),
});

export type CreateEventRequest = z.infer<typeof createEventRequestSchema>;
export type ListEventsRequest = z.infer<typeof listEventsRequestSchema>;
export type GetEventRequest = z.infer<typeof getEventRequestSchema>;
```

Zod converts external date-time strings once. Invalid time ordering and IANA
time zones fail before SQL, while the database constraints remain defense in
depth for non-HTTP callers.

#### `events.repository.ts`

```ts
import pg, { type Pool } from 'pg';

import { AppError } from '../../shared/errors/app-error.js';
import type {
  CreateEventInput,
  Event,
  EventCreationAuthorization,
  EventFilters,
  EventFormat,
  EventPage,
  EventVisibility,
} from './events.types.js';

interface EventRow {
  id: string;
  community_id: string;
  created_by_user_id: string;
  title: string;
  slug: string;
  description: string;
  format: EventFormat;
  status: string;
  visibility: EventVisibility;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  capacity: number;
  created_at: Date;
  updated_at: Date;
}

interface AuthorizationRow {
  community_status: string;
  membership_status: string | null;
  role: string | null;
}

const eventSelection = `
  e.id, e.community_id, e.created_by_user_id, e.title, e.slug,
  e.description, e.format, e.status, e.visibility, e.starts_at,
  e.ends_at, e.timezone, e.capacity, e.created_at, e.updated_at
`;

const mapEvent = (row: EventRow): Event => ({
  id: row.id,
  communityId: row.community_id,
  createdByUserId: row.created_by_user_id,
  title: row.title,
  slug: row.slug,
  description: row.description,
  format: row.format,
  status: row.status,
  visibility: row.visibility,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  timezone: row.timezone,
  capacity: row.capacity,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class EventsRepository {
  public constructor(private readonly pool: Pool) {}

  public async findCreationAuthorization(
    communityId: string,
    userId: string,
  ): Promise<EventCreationAuthorization | null> {
    const result = await this.pool.query<AuthorizationRow>(
      `SELECT c.status AS community_status,
              m.status AS membership_status,
              m.role
       FROM communities AS c
       LEFT JOIN community_memberships AS m
         ON m.community_id = c.id AND m.user_id = $2
       WHERE c.id = $1`,
      [communityId, userId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          communityStatus: row.community_status,
          membershipStatus: row.membership_status,
          role: row.role,
        };
  }

  public async create(
    communityId: string,
    userId: string,
    input: CreateEventInput,
  ): Promise<Event> {
    try {
      const result = await this.pool.query<EventRow>(
        `INSERT INTO events
           (community_id, created_by_user_id, title, slug, description,
            format, visibility, starts_at, ends_at, timezone, capacity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING
           id, community_id, created_by_user_id, title, slug, description,
           format, status, visibility, starts_at, ends_at, timezone,
           capacity, created_at, updated_at`,
        [
          communityId,
          userId,
          input.title,
          input.slug,
          input.description,
          input.format,
          input.visibility,
          input.startsAt,
          input.endsAt,
          input.timezone,
          input.capacity,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('Event insert returned no row');
      return mapEvent(row);
    } catch (error) {
      if (
        error instanceof pg.DatabaseError &&
        error.code === '23505' &&
        error.constraint === 'events_community_slug_key'
      ) {
        throw new AppError(409, 'EVENT_SLUG_TAKEN', 'That event slug is already used here');
      }
      throw error;
    }
  }

  public async findPublicById(eventId: string): Promise<Event | null> {
    const result = await this.pool.query<EventRow>(
      `SELECT ${eventSelection}
       FROM events AS e
       JOIN communities AS c ON c.id = e.community_id
       WHERE e.id = $1
         AND e.visibility = 'PUBLIC'
         AND e.status IN ('PUBLISHED', 'CANCELLED', 'COMPLETED')
         AND c.status = 'ACTIVE'`,
      [eventId],
    );
    return result.rows[0] === undefined ? null : mapEvent(result.rows[0]);
  }

  public async listPublic(filters: EventFilters): Promise<EventPage> {
    const clauses = [
      `e.visibility = 'PUBLIC'`,
      `e.status IN ('PUBLISHED', 'CANCELLED', 'COMPLETED')`,
      `c.status = 'ACTIVE'`,
    ];
    const values: unknown[] = [];
    const add = (columnAndOperator: string, value: unknown): void => {
      values.push(value);
      clauses.push(`${columnAndOperator} $${values.length}`);
    };

    if (filters.communityId !== null) add('e.community_id =', filters.communityId);
    if (filters.status !== null) add('e.status =', filters.status);
    if (filters.startsAfter !== null) add('e.starts_at >=', filters.startsAfter);
    if (filters.startsBefore !== null) add('e.starts_at <', filters.startsBefore);

    const where = clauses.join(' AND ');
    const filterValues = [...values];
    values.push(filters.limit, (filters.page - 1) * filters.limit);

    const [events, count] = await Promise.all([
      this.pool.query<EventRow>(
        `SELECT ${eventSelection}
         FROM events AS e
         JOIN communities AS c ON c.id = e.community_id
         WHERE ${where}
         ORDER BY e.starts_at ASC, e.id ASC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      ),
      this.pool.query<{ total: number }>(
        `SELECT count(*)::integer AS total
         FROM events AS e
         JOIN communities AS c ON c.id = e.community_id
         WHERE ${where}`,
        filterValues,
      ),
    ]);

    return {
      items: events.rows.map(mapEvent),
      page: filters.page,
      limit: filters.limit,
      total: count.rows[0]?.total ?? 0,
    };
  }
}
```

Only values are dynamic. SQL columns/operators come from fixed code branches,
and every row passes through one snake_case-to-camelCase mapper. The named
`23505` mapping avoids turning unrelated unique violations into the wrong API
error.

#### `events.service.ts`

```ts
import { AppError } from '../../shared/errors/app-error.js';
import type { EventsRepository } from './events.repository.js';
import type { CreateEventInput, Event, EventFilters, EventPage } from './events.types.js';

const creationRoles = new Set(['OWNER', 'ORGANIZER', 'MODERATOR']);

export class EventsService {
  public constructor(private readonly repository: EventsRepository) {}

  public async create(
    communityId: string,
    userId: string,
    input: CreateEventInput,
  ): Promise<Event> {
    const authorization = await this.repository.findCreationAuthorization(communityId, userId);

    if (authorization === null || authorization.communityStatus !== 'ACTIVE') {
      throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'The requested community does not exist');
    }
    if (
      authorization.membershipStatus !== 'ACTIVE' ||
      authorization.role === null ||
      !creationRoles.has(authorization.role)
    ) {
      throw new AppError(403, 'COMMUNITY_PERMISSION_DENIED', 'You cannot create events here');
    }
    if (input.startsAt >= input.endsAt) {
      throw new AppError(400, 'INVALID_EVENT_TIME', 'Event end must be after its start');
    }

    return this.repository.create(communityId, userId, input);
  }

  public list(filters: EventFilters): Promise<EventPage> {
    return this.repository.listPublic(filters);
  }

  public async get(eventId: string): Promise<Event> {
    const event = await this.repository.findPublicById(eventId);
    if (event === null) {
      throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
    }
    return event;
  }
}
```

Authorization uses both requested IDs, so an organizer cannot substitute a
different community. The service repeats time ordering because non-HTTP callers
may bypass Zod; PostgreSQL remains the final constraint.

#### `events.controller.ts`

```ts
import type { RequestHandler } from 'express';

import { getRequestUserId } from '../../shared/http/request-user.middleware.js';
import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { CreateEventRequest, GetEventRequest, ListEventsRequest } from './events.schemas.js';
import type { EventsService } from './events.service.js';
import type { Event } from './events.types.js';

interface EventDto {
  id: string;
  communityId: string;
  createdByUserId: string;
  title: string;
  slug: string;
  description: string;
  format: string;
  status: string;
  visibility: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  capacity: number;
  createdAt: string;
  updatedAt: string;
}

const toEventDto = (event: Event): EventDto => ({
  id: event.id,
  communityId: event.communityId,
  createdByUserId: event.createdByUserId,
  title: event.title,
  slug: event.slug,
  description: event.description,
  format: event.format,
  status: event.status,
  visibility: event.visibility,
  startsAt: event.startsAt.toISOString(),
  endsAt: event.endsAt.toISOString(),
  timezone: event.timezone,
  capacity: event.capacity,
  createdAt: event.createdAt.toISOString(),
  updatedAt: event.updatedAt.toISOString(),
});

export class EventsController {
  public constructor(private readonly service: EventsService) {}

  public readonly create: RequestHandler = async (_request, response) => {
    const { body, params } = getValidated<CreateEventRequest>(response);
    const event = await this.service.create(params.communityId, getRequestUserId(response), body);
    response.status(201).json({ data: toEventDto(event) });
  };

  public readonly list: RequestHandler = async (_request, response) => {
    const { query } = getValidated<ListEventsRequest>(response);
    const page = await this.service.list(query);
    response.json({
      data: page.items.map(toEventDto),
      pagination: { page: page.page, limit: page.limit, total: page.total },
    });
  };

  public readonly get: RequestHandler = async (_request, response) => {
    const { params } = getValidated<GetEventRequest>(response);
    response.json({ data: toEventDto(await this.service.get(params.eventId)) });
  };
}
```

The controller only translates HTTP input/output. `toEventDto` makes the public
shape explicit and converts internal `Date` values to ISO strings.

#### `events.routes.ts`

```ts
import { Router } from 'express';

import { requireRequestUser } from '../../shared/http/request-user.middleware.js';
import { validate } from '../../shared/validation/validate.middleware.js';
import type { EventsController } from './events.controller.js';
import {
  createEventRequestSchema,
  getEventRequestSchema,
  listEventsRequestSchema,
} from './events.schemas.js';

export const createEventsRouter = (controller: EventsController): Router => {
  const router = Router();
  router.post(
    '/communities/:communityId/events',
    requireRequestUser,
    validate(createEventRequestSchema),
    controller.create,
  );
  router.get('/events', validate(listEventsRequestSchema), controller.list);
  router.get('/events/:eventId', validate(getEventRequestSchema), controller.get);
  return router;
};
```

The router contains nested creation and top-level reads, so mount it once at
`/api`.

### Connect the events slice

Add `eventsRouter: Router` to `AppDependencies`. Mount every API router before
the terminal handlers:

```ts
app.use('/api/communities', dependencies.communitiesRouter);
app.use('/api/communities', dependencies.membershipsRouter);
app.use('/api', dependencies.eventsRouter);

app.use(notFoundHandler);
app.use(createErrorHandler(dependencies.logger));
```

Assemble the event dependency chain in `server.ts`:

```ts
import { EventsController } from './modules/events/events.controller.js';
import { EventsRepository } from './modules/events/events.repository.js';
import { createEventsRouter } from './modules/events/events.routes.js';
import { EventsService } from './modules/events/events.service.js';

const eventsRepository = new EventsRepository(pool);
const eventsService = new EventsService(eventsRepository);
const eventsController = new EventsController(eventsService);
const eventsRouter = createEventsRouter(eventsController);

const app = createApp({
  corsOrigin: environment.CORS_ORIGIN,
  enableHttpLogging: environment.NODE_ENV === 'development',
  logger,
  communitiesRouter,
  membershipsRouter,
  eventsRouter,
});
```

Health-only tests pass `eventsRouter: Router()`. Event API tests pass the real
router assembled from the disposable PostgreSQL repository chain.

### Event tests

Boundary validation should fail before SQL:

```ts
const invalid = await request(app)
  .post(`/api/communities/${communityId}/events`)
  .set('x-user-id', ownerId)
  .send({
    title: 'Invalid event',
    slug: 'invalid-event',
    startsAt: '2026-08-03T18:00:00.000Z',
    endsAt: '2026-08-03T17:00:00.000Z',
    timezone: 'Europe/Moscow',
    capacity: 0,
  });
expect(invalid.status).toBe(400);
expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
```

Prove object-level authorization, not only role checking:

```ts
const forbidden = await request(app)
  .post(`/api/communities/${otherCommunityId}/events`)
  .set('x-user-id', firstCommunityOrganizerId)
  .send(validEventBody);
expect(forbidden.status).toBe(403);
expect(forbidden.body.error.code).toBe('COMMUNITY_PERMISSION_DENIED');
```

Verify fixed filters and deterministic pagination:

```ts
const listed = await request(app).get('/api/events').query({
  communityId,
  status: 'PUBLISHED',
  startsAfter: '2026-08-01T00:00:00.000Z',
  limit: 10,
  page: 1,
});
expect(listed.status).toBe(200);
expect(
  listed.body.data.every((event: { communityId: string }) => event.communityId === communityId),
).toBe(true);
```

Also test:

- Owner, organizer, and moderator can create; an ordinary member cannot.
- A banned/suspended or cross-community member receives `403`.
- Duplicate slug in one community becomes `409 EVENT_SLUG_TAKEN`.
- The same slug in another community succeeds.
- Invalid time order, time zone, and non-positive capacity fail before SQL.
- Public get returns `404 EVENT_NOT_FOUND` for draft/private/archived-community
  events, avoiding existence leaks.
- Ordering remains `starts_at ASC, id ASC` with stable pagination metadata.

The completed request path is:

```text
HTTP
→ eventsRouter
→ validation / temporary identity
→ EventsController
→ EventsService authorization
→ EventsRepository parameterized SQL
→ PostgreSQL
```

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

Write the transaction shell before outcome-specific inserts:

```ts
const reserveInTransaction = async (
  pool: Pool,
  eventId: string,
  userId: string,
): Promise<AttendanceOutcome> =>
  withTransaction(pool, async (client) => {
    // Reservation, cancellation, and promotion all lock this event row first.
    const eventResult = await client.query<LockedEventRow>(
      `SELECT id, community_id, status, starts_at, capacity
       FROM events WHERE id = $1 FOR UPDATE`,
      [eventId],
    );
    const event = eventResult.rows[0];
    if (event === undefined) {
      throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
    }

    await assertEligibleMembership(client, event.community_id, userId);
    await assertNoActiveAttendance(client, eventId, userId);

    const count = await client.query<{ confirmed_count: number }>(
      `SELECT count(*)::integer AS confirmed_count
       FROM reservations
       WHERE event_id = $1 AND status = 'CONFIRMED'`,
      [eventId],
    );

    return (count.rows[0]?.confirmed_count ?? 0) < event.capacity
      ? insertConfirmed(client, eventId, userId)
      : insertWaiting(client, eventId, userId);
  });
```

Define `LockedEventRow`, `AttendanceOutcome`, and each helper with domain-shaped
inputs/outputs. Every helper receives the same `PoolClient`; none calls
`pool.query`, or its statement could escape the transaction. Step 20 fills in
these helpers.

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

Use these domain result types:

```ts
export type AttendanceOutcome =
  | { attendanceStatus: 'CONFIRMED'; reservationId: string }
  | { attendanceStatus: 'WAITLISTED'; waitlistEntryId: string; position: number };

interface LockedEventRow {
  id: string;
  community_id: string;
  status: string;
  starts_at: Date;
  capacity: number;
}
```

Fill in the Step 19 helpers. These functions deliberately accept a
`PoolClient`, proving that every query runs on the checked-out transaction
connection:

```ts
const assertEligibleMembership = async (
  client: PoolClient,
  communityId: string,
  userId: string,
): Promise<void> => {
  const result = await client.query<{ status: string }>(
    `SELECT status FROM community_memberships
     WHERE community_id = $1 AND user_id = $2`,
    [communityId, userId],
  );
  if (result.rows[0]?.status !== 'ACTIVE') {
    throw new AppError(403, 'COMMUNITY_PERMISSION_DENIED', 'Active membership is required');
  }
};

const assertNoActiveAttendance = async (
  client: PoolClient,
  eventId: string,
  userId: string,
): Promise<void> => {
  const result = await client.query<{ reserved: boolean; waiting: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM reservations
         WHERE event_id = $1 AND user_id = $2 AND status = 'CONFIRMED'
       ) AS reserved,
       EXISTS (
         SELECT 1 FROM waitlist_entries
         WHERE event_id = $1 AND user_id = $2 AND status = 'WAITING'
       ) AS waiting`,
    [eventId, userId],
  );
  if (result.rows[0]?.reserved === true) {
    throw new AppError(409, 'ALREADY_RESERVED', 'You already have a reservation');
  }
  if (result.rows[0]?.waiting === true) {
    throw new AppError(409, 'ALREADY_WAITLISTED', 'You are already waiting');
  }
};

const insertConfirmed = async (
  client: PoolClient,
  eventId: string,
  userId: string,
): Promise<AttendanceOutcome> => {
  const result = await client.query<{ id: string }>(
    `INSERT INTO reservations (event_id, user_id)
     VALUES ($1, $2) RETURNING id`,
    [eventId, userId],
  );
  const reservation = result.rows[0];
  if (reservation === undefined) throw new Error('Reservation insert returned no row');

  await client.query(
    `INSERT INTO notifications (user_id, type, title, message, data)
     VALUES ($1, 'RESERVATION_CONFIRMED', 'Reservation confirmed',
             'Your event reservation is confirmed', jsonb_build_object('eventId', $2::text))`,
    [userId, eventId],
  );
  return { attendanceStatus: 'CONFIRMED', reservationId: reservation.id };
};

const insertWaiting = async (
  client: PoolClient,
  eventId: string,
  userId: string,
): Promise<AttendanceOutcome> => {
  const result = await client.query<{ id: string; joined_at: Date }>(
    `INSERT INTO waitlist_entries (event_id, user_id)
     VALUES ($1, $2) RETURNING id, joined_at`,
    [eventId, userId],
  );
  const entry = result.rows[0];
  if (entry === undefined) throw new Error('Waitlist insert returned no row');

  const position = await client.query<{ value: number }>(
    `SELECT count(*)::integer AS value
     FROM waitlist_entries
     WHERE event_id = $1 AND status = 'WAITING'
       AND (joined_at, id) <= ($2::timestamptz, $3::uuid)`,
    [eventId, entry.joined_at, entry.id],
  );
  await client.query(
    `INSERT INTO notifications (user_id, type, title, message, data)
     VALUES ($1, 'WAITLIST_JOINED', 'Added to waitlist',
             'You were added to the event waitlist', jsonb_build_object('eventId', $2::text))`,
    [userId, eventId],
  );
  return {
    attendanceStatus: 'WAITLISTED',
    waitlistEntryId: entry.id,
    position: position.rows[0]?.value ?? 1,
  };
};
```

Before the membership check, reject non-`PUBLISHED` events and events whose
`starts_at <= now()`. Return the union directly from the controller with `201`;
TypeScript narrowing guarantees that only the matching ID field is serialized.

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

### Complete reservation-creation slice

Create the reservation module now; Step 21 extends the same files for
cancellation:

```text
src/modules/reservations/
  reservations.routes.ts
  reservations.controller.ts
  reservations.service.ts
  reservations.repository.ts
  reservations.schemas.ts
  reservations.types.ts
```

#### `reservations.types.ts`

```ts
export interface LockedEvent {
  id: string;
  communityId: string;
  status: string;
  startsAt: Date;
  capacity: number;
}

export interface ActiveAttendanceState {
  reserved: boolean;
  waiting: boolean;
}

export type AttendanceOutcome =
  | { attendanceStatus: 'CONFIRMED'; reservationId: string }
  | { attendanceStatus: 'WAITLISTED'; waitlistEntryId: string; position: number };

export interface ReservationSummary {
  id: string;
  status: 'CONFIRMED';
  reservedAt: Date;
}

export interface WaitlistSummary {
  id: string;
  status: 'WAITING';
  joinedAt: Date;
  position: number;
}
```

#### `reservations.schemas.ts`

```ts
import { z } from 'zod';

export const eventAttendanceRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({ eventId: z.uuid() }),
  query: z.object({}),
});

export type EventAttendanceRequest = z.infer<typeof eventAttendanceRequestSchema>;
```

#### `reservations.repository.ts`

```ts
import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../shared/database/transaction.js';
import type {
  ActiveAttendanceState,
  LockedEvent,
  ReservationSummary,
  WaitlistSummary,
} from './reservations.types.js';

interface LockedEventRow {
  id: string;
  community_id: string;
  status: string;
  starts_at: Date;
  capacity: number;
}

export class ReservationTransactionRepository {
  public constructor(private readonly client: PoolClient) {}

  public async lockEvent(eventId: string): Promise<LockedEvent | null> {
    const result = await this.client.query<LockedEventRow>(
      `SELECT id, community_id, status, starts_at, capacity
       FROM events WHERE id = $1 FOR UPDATE`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          communityId: row.community_id,
          status: row.status,
          startsAt: row.starts_at,
          capacity: row.capacity,
        };
  }

  public async findMembershipStatus(communityId: string, userId: string): Promise<string | null> {
    const result = await this.client.query<{ status: string }>(
      `SELECT status FROM community_memberships
       WHERE community_id = $1 AND user_id = $2`,
      [communityId, userId],
    );
    return result.rows[0]?.status ?? null;
  }

  public async findActiveState(eventId: string, userId: string): Promise<ActiveAttendanceState> {
    const result = await this.client.query<ActiveAttendanceState>(
      `SELECT
         EXISTS (SELECT 1 FROM reservations
           WHERE event_id = $1 AND user_id = $2 AND status = 'CONFIRMED') AS reserved,
         EXISTS (SELECT 1 FROM waitlist_entries
           WHERE event_id = $1 AND user_id = $2 AND status = 'WAITING') AS waiting`,
      [eventId, userId],
    );
    return result.rows[0] ?? { reserved: false, waiting: false };
  }

  public async countConfirmed(eventId: string): Promise<number> {
    const result = await this.client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM reservations
       WHERE event_id = $1 AND status = 'CONFIRMED'`,
      [eventId],
    );
    return result.rows[0]?.count ?? 0;
  }

  public async insertConfirmed(eventId: string, userId: string): Promise<string> {
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO reservations (event_id, user_id) VALUES ($1, $2) RETURNING id`,
      [eventId, userId],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('Reservation insert returned no row');
    return id;
  }

  public async insertWaiting(
    eventId: string,
    userId: string,
  ): Promise<{ id: string; joinedAt: Date }> {
    const result = await this.client.query<{ id: string; joined_at: Date }>(
      `INSERT INTO waitlist_entries (event_id, user_id)
       VALUES ($1, $2) RETURNING id, joined_at`,
      [eventId, userId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Waitlist insert returned no row');
    return { id: row.id, joinedAt: row.joined_at };
  }

  public async calculatePosition(
    eventId: string,
    joinedAt: Date,
    entryId: string,
  ): Promise<number> {
    const result = await this.client.query<{ position: number }>(
      `SELECT count(*)::integer AS position
       FROM waitlist_entries
       WHERE event_id = $1 AND status = 'WAITING'
         AND (joined_at, id) <= ($2::timestamptz, $3::uuid)`,
      [eventId, joinedAt, entryId],
    );
    return result.rows[0]?.position ?? 1;
  }

  public async insertNotification(
    userId: string,
    eventId: string,
    type: 'RESERVATION_CONFIRMED' | 'WAITLIST_JOINED',
  ): Promise<void> {
    const title = type === 'RESERVATION_CONFIRMED' ? 'Reservation confirmed' : 'Added to waitlist';
    await this.client.query(
      `INSERT INTO notifications (user_id, type, title, message, data)
       VALUES ($1, $2, $3, $3, jsonb_build_object('eventId', $4::text))`,
      [userId, type, title, eventId],
    );
  }
}

export class ReservationsRepository {
  public constructor(private readonly pool: Pool) {}

  public inTransaction<T>(
    operation: (repository: ReservationTransactionRepository) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.pool, (client) =>
      operation(new ReservationTransactionRepository(client)),
    );
  }

  public async findReservation(
    eventId: string,
    userId: string,
  ): Promise<ReservationSummary | null> {
    const result = await this.pool.query<{
      id: string;
      status: 'CONFIRMED';
      reserved_at: Date;
    }>(
      `SELECT id, status, reserved_at FROM reservations
       WHERE event_id = $1 AND user_id = $2 AND status = 'CONFIRMED'`,
      [eventId, userId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { id: row.id, status: row.status, reservedAt: row.reserved_at };
  }

  public async findWaitlistEntry(eventId: string, userId: string): Promise<WaitlistSummary | null> {
    const result = await this.pool.query<{
      id: string;
      status: 'WAITING';
      joined_at: Date;
      position: number;
    }>(
      `SELECT w.id, w.status, w.joined_at,
         (SELECT count(*)::integer FROM waitlist_entries AS earlier
          WHERE earlier.event_id = w.event_id AND earlier.status = 'WAITING'
            AND (earlier.joined_at, earlier.id) <= (w.joined_at, w.id)) AS position
       FROM waitlist_entries AS w
       WHERE w.event_id = $1 AND w.user_id = $2 AND w.status = 'WAITING'`,
      [eventId, userId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { id: row.id, status: row.status, joinedAt: row.joined_at, position: row.position };
  }
}
```

The service owns decisions; the repository owns SQL and exposes a
transaction-scoped repository rather than leaking `PoolClient` into business
logic.

#### `reservations.service.ts`

```ts
import { AppError } from '../../shared/errors/app-error.js';
import type { ReservationsRepository } from './reservations.repository.js';
import type {
  AttendanceOutcome,
  ReservationSummary,
  WaitlistSummary,
} from './reservations.types.js';

export class ReservationsService {
  public constructor(private readonly repository: ReservationsRepository) {}

  public reserve(eventId: string, userId: string): Promise<AttendanceOutcome> {
    return this.repository.inTransaction(async (transaction) => {
      const event = await transaction.lockEvent(eventId);
      if (event === null) {
        throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
      }
      if (event.status !== 'PUBLISHED' || event.startsAt <= new Date()) {
        throw new AppError(409, 'EVENT_NOT_RESERVABLE', 'This event cannot be reserved');
      }
      if ((await transaction.findMembershipStatus(event.communityId, userId)) !== 'ACTIVE') {
        throw new AppError(403, 'COMMUNITY_PERMISSION_DENIED', 'Active membership is required');
      }

      const state = await transaction.findActiveState(eventId, userId);
      if (state.reserved) {
        throw new AppError(409, 'ALREADY_RESERVED', 'You already have a reservation');
      }
      if (state.waiting) {
        throw new AppError(409, 'ALREADY_WAITLISTED', 'You are already waiting');
      }

      if ((await transaction.countConfirmed(eventId)) < event.capacity) {
        const reservationId = await transaction.insertConfirmed(eventId, userId);
        await transaction.insertNotification(userId, eventId, 'RESERVATION_CONFIRMED');
        return { attendanceStatus: 'CONFIRMED', reservationId };
      }

      const entry = await transaction.insertWaiting(eventId, userId);
      const position = await transaction.calculatePosition(eventId, entry.joinedAt, entry.id);
      await transaction.insertNotification(userId, eventId, 'WAITLIST_JOINED');
      return { attendanceStatus: 'WAITLISTED', waitlistEntryId: entry.id, position };
    });
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
}
```

The event lock is acquired before membership, attendance, count, or inserts. All
capacity-changing paths must retain that order.

#### Controller, routes, and composition

```ts
// reservations.controller.ts
import type { RequestHandler } from 'express';

import { getRequestUserId } from '../../shared/http/request-user.middleware.js';
import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { ReservationsService } from './reservations.service.js';
import type { EventAttendanceRequest } from './reservations.schemas.js';

export class ReservationsController {
  public constructor(private readonly service: ReservationsService) {}

  public readonly reserve: RequestHandler = async (_request, response) => {
    const { params } = getValidated<EventAttendanceRequest>(response);
    const outcome = await this.service.reserve(params.eventId, getRequestUserId(response));
    response.status(201).json({ data: outcome });
  };

  public readonly getMine: RequestHandler = async (_request, response) => {
    const { params } = getValidated<EventAttendanceRequest>(response);
    const value = await this.service.getReservation(params.eventId, getRequestUserId(response));
    response.json({ data: { ...value, reservedAt: value.reservedAt.toISOString() } });
  };

  public readonly getMyWaitlist: RequestHandler = async (_request, response) => {
    const { params } = getValidated<EventAttendanceRequest>(response);
    const value = await this.service.getWaitlistEntry(params.eventId, getRequestUserId(response));
    response.json({ data: { ...value, joinedAt: value.joinedAt.toISOString() } });
  };
}
```

```ts
// reservations.routes.ts
import { Router } from 'express';

import { requireRequestUser } from '../../shared/http/request-user.middleware.js';
import { validate } from '../../shared/validation/validate.middleware.js';
import type { ReservationsController } from './reservations.controller.js';
import { eventAttendanceRequestSchema } from './reservations.schemas.js';

export const createReservationsRouter = (controller: ReservationsController): Router => {
  const router = Router();
  router.post(
    '/events/:eventId/reservations',
    requireRequestUser,
    validate(eventAttendanceRequestSchema),
    controller.reserve,
  );
  router.get(
    '/events/:eventId/reservations/me',
    requireRequestUser,
    validate(eventAttendanceRequestSchema),
    controller.getMine,
  );
  router.get(
    '/events/:eventId/waitlist/me',
    requireRequestUser,
    validate(eventAttendanceRequestSchema),
    controller.getMyWaitlist,
  );
  return router;
};
```

Construct the chain in `server.ts` (Step 24 shows the complete composition
root containing these imports):

```ts
const reservationsRepository = new ReservationsRepository(pool);
const reservationsService = new ReservationsService(reservationsRepository);
const reservationsController = new ReservationsController(reservationsService);
const reservationsRouter = createReservationsRouter(reservationsController);
```

Add `reservationsRouter: Router` to `AppDependencies` and mount it before the
terminal handlers:

```ts
app.use('/api', dependencies.eventsRouter);
app.use('/api', dependencies.reservationsRouter);
app.use(notFoundHandler);
app.use(createErrorHandler(dependencies.logger));
```

Health-only tests pass `reservationsRouter: Router()`. Reservation API tests use
the real chain and disposable PostgreSQL.

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

Implement confirmed cancellation with the same event-first lock order used by
reservation creation:

```ts
public async cancelReservation(eventId: string, userId: string): Promise<void> {
  await withTransaction(this.pool, async (client) => {
    const event = await client.query(`SELECT id FROM events WHERE id = $1 FOR UPDATE`, [eventId]);
    if (event.rowCount === 0) {
      throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
    }

    const cancelled = await client.query(
      `UPDATE reservations
       SET status = 'CANCELLED_BY_USER', cancelled_at = now(), updated_at = now()
       WHERE event_id = $1 AND user_id = $2 AND status = 'CONFIRMED'
       RETURNING id`,
      [eventId, userId],
    );
    if (cancelled.rowCount === 0) {
      throw new AppError(404, 'RESERVATION_NOT_FOUND', 'No active reservation exists');
    }

    const next = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id
       FROM waitlist_entries
       WHERE event_id = $1 AND status = 'WAITING'
       ORDER BY joined_at ASC, id ASC
       LIMIT 1 FOR UPDATE`,
      [eventId],
    );
    const entry = next.rows[0];
    if (entry === undefined) return;

    await client.query(
      `UPDATE waitlist_entries
       SET status = 'PROMOTED', promoted_at = now(), updated_at = now()
       WHERE id = $1`,
      [entry.id],
    );
    await client.query(
      `INSERT INTO reservations (event_id, user_id) VALUES ($1, $2)`,
      [eventId, entry.user_id],
    );
    await client.query(
      `INSERT INTO notifications (user_id, type, title, message, data)
       VALUES ($1, 'WAITLIST_PROMOTED', 'Reservation confirmed',
               'A place became available', jsonb_build_object('eventId', $2::text))`,
      [entry.user_id, eventId],
    );
  });
}
```

Implement waitlist cancellation as a smaller mutation. It changes history but
does not free a confirmed place, so it performs no promotion:

```ts
public async cancelWaitlist(eventId: string, userId: string): Promise<void> {
  const result = await this.pool.query(
    `UPDATE waitlist_entries
     SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
     WHERE event_id = $1 AND user_id = $2 AND status = 'WAITING'
     RETURNING id`,
    [eventId, userId],
  );
  if (result.rowCount === 0) {
    throw new AppError(404, 'WAITLIST_ENTRY_NOT_FOUND', 'No active waitlist entry exists');
  }
}
```

Expose the methods through the service and thin `DELETE` controllers. Return
`204` on success and the documented `404` on repeat. The event-row lock makes
concurrent cancellation and promotion follow the same serialization protocol as
reservation creation.

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

### Complete the Step 21 file changes

Add these methods to `ReservationTransactionRepository` in
`reservations.repository.ts`:

```ts
public async cancelConfirmed(eventId: string, userId: string): Promise<boolean> {
  const result = await this.client.query(
    `UPDATE reservations
     SET status = 'CANCELLED_BY_USER', cancelled_at = now(), updated_at = now()
     WHERE event_id = $1 AND user_id = $2 AND status = 'CONFIRMED'
     RETURNING id`,
    [eventId, userId],
  );
  return result.rowCount === 1;
}

public async findFirstWaiting(
  eventId: string,
): Promise<{ id: string; userId: string } | null> {
  const result = await this.client.query<{ id: string; user_id: string }>(
    `SELECT id, user_id
     FROM waitlist_entries
     WHERE event_id = $1 AND status = 'WAITING'
     ORDER BY joined_at ASC, id ASC
     LIMIT 1 FOR UPDATE`,
    [eventId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { id: row.id, userId: row.user_id };
}

public async promoteWaitlistEntry(entryId: string): Promise<void> {
  await this.client.query(
    `UPDATE waitlist_entries
     SET status = 'PROMOTED', promoted_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'WAITING'`,
    [entryId],
  );
}

public async insertPromotedReservation(eventId: string, userId: string): Promise<void> {
  await this.client.query(
    `INSERT INTO reservations (event_id, user_id) VALUES ($1, $2)`,
    [eventId, userId],
  );
}

public async insertPromotionNotification(userId: string, eventId: string): Promise<void> {
  await this.client.query(
    `INSERT INTO notifications (user_id, type, title, message, data)
     VALUES ($1, 'WAITLIST_PROMOTED', 'Reservation confirmed',
             'A place became available', jsonb_build_object('eventId', $2::text))`,
    [userId, eventId],
  );
}
```

Add this ordinary repository method to `ReservationsRepository` for cancelling a
waiting entry:

```ts
public async cancelWaiting(eventId: string, userId: string): Promise<boolean> {
  const result = await this.pool.query(
    `UPDATE waitlist_entries
     SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
     WHERE event_id = $1 AND user_id = $2 AND status = 'WAITING'
     RETURNING id`,
    [eventId, userId],
  );
  return result.rowCount === 1;
}
```

PostgreSQL locks the row modified by `cancelWaiting`. If promotion updated it
first, the `status = 'WAITING'` predicate is rechecked and cancellation returns
false. It does not change confirmed capacity, so it does not need the event
serialization lock.

Add both use cases to `ReservationsService`:

```ts
public cancelReservation(eventId: string, userId: string): Promise<void> {
  return this.repository.inTransaction(async (transaction) => {
    const event = await transaction.lockEvent(eventId);
    if (event === null) {
      throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
    }
    if (!(await transaction.cancelConfirmed(eventId, userId))) {
      throw new AppError(404, 'RESERVATION_NOT_FOUND', 'No active reservation exists');
    }

    const entry = await transaction.findFirstWaiting(eventId);
    if (entry === null) return;

    await transaction.promoteWaitlistEntry(entry.id);
    await transaction.insertPromotedReservation(eventId, entry.userId);
    await transaction.insertPromotionNotification(entry.userId, eventId);
  });
}

public async cancelWaitlist(eventId: string, userId: string): Promise<void> {
  if (!(await this.repository.cancelWaiting(eventId, userId))) {
    throw new AppError(404, 'WAITLIST_ENTRY_NOT_FOUND', 'No active waitlist entry exists');
  }
}
```

Add controller methods:

```ts
public readonly cancelMine: RequestHandler = async (_request, response) => {
  const { params } = getValidated<EventAttendanceRequest>(response);
  await this.service.cancelReservation(params.eventId, getRequestUserId(response));
  response.status(204).send();
};

public readonly cancelMyWaitlist: RequestHandler = async (_request, response) => {
  const { params } = getValidated<EventAttendanceRequest>(response);
  await this.service.cancelWaitlist(params.eventId, getRequestUserId(response));
  response.status(204).send();
};
```

After adding the two controller methods, replace `reservations.routes.ts` with
this complete final router rather than trying to splice in two loose lines:

```ts
import { Router } from 'express';

import { requireRequestUser } from '../../shared/http/request-user.middleware.js';
import { validate } from '../../shared/validation/validate.middleware.js';
import type { ReservationsController } from './reservations.controller.js';
import { eventAttendanceRequestSchema } from './reservations.schemas.js';

export const createReservationsRouter = (controller: ReservationsController): Router => {
  const router = Router();
  const middleware = [requireRequestUser, validate(eventAttendanceRequestSchema)] as const;

  router.post('/events/:eventId/reservations', ...middleware, controller.reserve);
  router.get('/events/:eventId/reservations/me', ...middleware, controller.getMine);
  router.delete('/events/:eventId/reservations/me', ...middleware, controller.cancelMine);
  router.get('/events/:eventId/waitlist/me', ...middleware, controller.getMyWaitlist);
  router.delete('/events/:eventId/waitlist/me', ...middleware, controller.cancelMyWaitlist);

  return router;
};
```

The cancellation, promotion, new reservation, and notification all use the same
transaction repository. An exception from any statement rolls back every prior
statement in that callback.

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

Make those assertions executable in
`tests/integration/reservations.concurrent.test.ts`:

```ts
it('allocates one final place and waitlists the other request', async () => {
  const { eventId, userAId, userBId } = await fixtures.createCapacityOneEvent();

  const outcomes = await Promise.all([
    reservationService.reserve(eventId, userAId),
    reservationService.reserve(eventId, userBId),
  ]);

  expect(outcomes.map((outcome) => outcome.attendanceStatus).sort()).toEqual([
    'CONFIRMED',
    'WAITLISTED',
  ]);

  const counts = await pool.query<{ confirmed: number; waiting: number; overlap: number }>(
    `SELECT
       (SELECT count(*)::integer FROM reservations
        WHERE event_id = $1 AND status = 'CONFIRMED') AS confirmed,
       (SELECT count(*)::integer FROM waitlist_entries
        WHERE event_id = $1 AND status = 'WAITING') AS waiting,
       (SELECT count(*)::integer
        FROM reservations AS r
        JOIN waitlist_entries AS w
          ON w.event_id = r.event_id AND w.user_id = r.user_id
        WHERE r.event_id = $1
          AND r.status = 'CONFIRMED'
          AND w.status = 'WAITING') AS overlap`,
    [eventId],
  );

  expect(counts.rows[0]).toEqual({ confirmed: 1, waiting: 1, overlap: 0 });
});
```

Create fixtures through SQL/service helpers against the disposable test pool,
not through the development Compose database. The test asserts both returned
behavior and authoritative PostgreSQL state; either side alone is insufficient.

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

### Complete concurrency test file

Create `tests/integration/reservations.concurrent.test.ts`. It uses the reusable
Testcontainers harness shown in full in Step 26; create that helper now if you
want to run this checkpoint immediately.

```ts
import type { Pool } from 'pg';

import { ReservationsRepository } from '../../src/modules/reservations/reservations.repository.js';
import { ReservationsService } from '../../src/modules/reservations/reservations.service.js';
import { type PostgresHarness, startPostgresHarness } from './postgres-harness.js';

const aliceId = '00000000-0000-4000-8000-000000000001';
const bobId = '00000000-0000-4000-8000-000000000002';

const createCapacityOneEvent = async (pool: Pool): Promise<string> => {
  const community = await pool.query<{ id: string }>(
    `INSERT INTO communities (name, slug, created_by_user_id)
     VALUES ('Race Community', 'race-community', $1)
     RETURNING id`,
    [aliceId],
  );
  const communityId = community.rows[0]?.id;
  if (communityId === undefined) throw new Error('Community fixture failed');

  await pool.query(
    `INSERT INTO community_memberships (community_id, user_id, role, status)
     VALUES
       ($1, $2, 'OWNER', 'ACTIVE'),
       ($1, $3, 'MEMBER', 'ACTIVE')`,
    [communityId, aliceId, bobId],
  );
  const event = await pool.query<{ id: string }>(
    `INSERT INTO events
       (community_id, created_by_user_id, title, slug, starts_at, ends_at,
        timezone, capacity)
     VALUES
       ($1, $2, 'One place', 'one-place', now() + interval '1 day',
        now() + interval '2 days', 'Europe/Moscow', 1)
     RETURNING id`,
    [communityId, aliceId],
  );
  const eventId = event.rows[0]?.id;
  if (eventId === undefined) throw new Error('Event fixture failed');
  return eventId;
};

describe('reservation concurrency', () => {
  let harness: PostgresHarness;
  let service: ReservationsService;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    service = new ReservationsService(new ReservationsRepository(harness.pool));
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('allocates one final place and waitlists the other request', async () => {
    const eventId = await createCapacityOneEvent(harness.pool);
    const outcomes = await Promise.all([
      service.reserve(eventId, aliceId),
      service.reserve(eventId, bobId),
    ]);

    expect(outcomes.map((outcome) => outcome.attendanceStatus).sort()).toEqual([
      'CONFIRMED',
      'WAITLISTED',
    ]);

    const result = await harness.pool.query<{
      confirmed: number;
      waiting: number;
      overlap: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM reservations
          WHERE event_id = $1 AND status = 'CONFIRMED') AS confirmed,
         (SELECT count(*)::integer FROM waitlist_entries
          WHERE event_id = $1 AND status = 'WAITING') AS waiting,
         (SELECT count(*)::integer
          FROM reservations AS r
          JOIN waitlist_entries AS w
            ON w.event_id = r.event_id AND w.user_id = r.user_id
          WHERE r.event_id = $1 AND r.status = 'CONFIRMED' AND w.status = 'WAITING') AS overlap`,
      [eventId],
    );
    expect(result.rows[0]).toEqual({ confirmed: 1, waiting: 1, overlap: 0 });
  });
});
```

Run this file repeatedly with the PowerShell loop already shown. The two
`service.reserve` calls use separate pool clients; the event-row lock, not a
JavaScript mutex, determines the winner.

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

Validate the header and compute a stable request hash:

```ts
import { createHash } from 'node:crypto';

const idempotencyKeySchema = z.string().min(1).max(200);

const hashReservationRequest = (eventId: string, userId: string): string =>
  createHash('sha256')
    .update(JSON.stringify({ operation: 'reserve', eventId, userId }))
    .digest('hex');
```

Inside the existing event-locked reservation transaction, claim or replay the
key before changing attendance state:

```ts
const scope = `reserve:${eventId}`;
const requestHash = hashReservationRequest(eventId, userId);
const claimed = await client.query<{ id: string }>(
  `INSERT INTO idempotency_keys (user_id, scope, key, request_hash)
   VALUES ($1, $2, $3, $4)
   ON CONFLICT (user_id, scope, key) DO NOTHING
   RETURNING id`,
  [userId, scope, idempotencyKey, requestHash],
);

if (claimed.rows[0] === undefined) {
  const existing = await client.query<{
    request_hash: string;
    response_status: number | null;
    response_body: AttendanceOutcome | null;
  }>(
    `SELECT request_hash, response_status, response_body
     FROM idempotency_keys
     WHERE user_id = $1 AND scope = $2 AND key = $3
     FOR UPDATE`,
    [userId, scope, idempotencyKey],
  );
  const record = existing.rows[0];
  if (record === undefined || record.request_hash !== requestHash) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused');
  }
  if (record.response_status !== null && record.response_body !== null) {
    return { status: record.response_status, body: record.response_body };
  }
  throw new AppError(409, 'REQUEST_IN_PROGRESS', 'The original request is incomplete');
}

const outcome = await createAttendanceOutcome(client, event, userId);
await client.query(
  `UPDATE idempotency_keys
   SET response_status = 201, response_body = $2::jsonb, completed_at = now()
   WHERE id = $1`,
  [claimed.rows[0].id, JSON.stringify(outcome)],
);
return { status: 201, body: outcome };
```

The claim, outcome, notification, and stored response use the same client and
transaction. A unique-key conflict waits for the first insert transaction; after
that transaction commits, the loser reads the completed response. If the first
transaction rolls back, its key row also disappears and a retry can claim it.

Require `Idempotency-Key` on the reservation route for a simpler Phase 2
contract:

```ts
const parsedKey = idempotencyKeySchema.safeParse(request.header('Idempotency-Key'));
if (!parsedKey.success) {
  throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key is required');
}
const idempotencyKey = parsedKey.data;
const result = await service.reserve(eventId, userId, idempotencyKey);
response.status(result.status).json({ data: result.body });
```

The explicit conversion prevents a raw `ZodError` from becoming an unexpected 500. You may instead extend the Step 14 boundary schema to validate selected
headers centrally; never copy all request headers into error details.

Tests:

- Same key and request returns same outcome.
- Same key with conflicting request returns `409`.
- Concurrent repeated key creates one effect.
- Mid-transaction failure does not leave a completed idempotency response.

### Complete idempotency integration

Add these types to `reservations.types.ts`:

```ts
export type IdempotencyClaim =
  | { kind: 'CLAIMED'; id: string }
  | { kind: 'CONFLICT' }
  | { kind: 'INCOMPLETE' }
  | { kind: 'REPLAY'; status: number; body: AttendanceOutcome };

export interface ReservationCommandResult {
  status: number;
  body: AttendanceOutcome;
}
```

Add these methods to `ReservationTransactionRepository`:

```ts
public async claimIdempotency(
  userId: string,
  scope: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyClaim> {
  const inserted = await this.client.query<{ id: string }>(
    `INSERT INTO idempotency_keys (user_id, scope, key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, scope, key) DO NOTHING
     RETURNING id`,
    [userId, scope, key, requestHash],
  );
  const id = inserted.rows[0]?.id;
  if (id !== undefined) return { kind: 'CLAIMED', id };

  const existing = await this.client.query<{
    request_hash: string;
    response_status: number | null;
    response_body: AttendanceOutcome | null;
  }>(
    `SELECT request_hash, response_status, response_body
     FROM idempotency_keys
     WHERE user_id = $1 AND scope = $2 AND key = $3
     FOR UPDATE`,
    [userId, scope, key],
  );
  const record = existing.rows[0];
  if (record === undefined || record.request_hash !== requestHash) return { kind: 'CONFLICT' };
  if (record.response_status === null || record.response_body === null) {
    return { kind: 'INCOMPLETE' };
  }
  return { kind: 'REPLAY', status: record.response_status, body: record.response_body };
}

public async completeIdempotency(
  id: string,
  result: ReservationCommandResult,
): Promise<void> {
  await this.client.query(
    `UPDATE idempotency_keys
     SET response_status = $2, response_body = $3::jsonb, completed_at = now()
     WHERE id = $1`,
    [id, result.status, JSON.stringify(result.body)],
  );
}
```

Import `AttendanceOutcome`, `IdempotencyClaim`, and
`ReservationCommandResult` from `reservations.types.ts`.

Replace the Step 20 `reserve` method in `ReservationsService` with this complete
version and helper:

```ts
import { createHash } from 'node:crypto';

import type { ReservationTransactionRepository } from './reservations.repository.js';
import type {
  AttendanceOutcome,
  LockedEvent,
  ReservationCommandResult,
} from './reservations.types.js';

const hashRequest = (eventId: string, userId: string): string =>
  createHash('sha256')
    .update(JSON.stringify({ operation: 'reserve', eventId, userId }))
    .digest('hex');

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

  if ((await transaction.countConfirmed(event.id)) < event.capacity) {
    const reservationId = await transaction.insertConfirmed(event.id, userId);
    await transaction.insertNotification(userId, event.id, 'RESERVATION_CONFIRMED');
    return { attendanceStatus: 'CONFIRMED', reservationId };
  }

  const entry = await transaction.insertWaiting(event.id, userId);
  const position = await transaction.calculatePosition(event.id, entry.joinedAt, entry.id);
  await transaction.insertNotification(userId, event.id, 'WAITLIST_JOINED');
  return { attendanceStatus: 'WAITLISTED', waitlistEntryId: entry.id, position };
}

public reserve(
  eventId: string,
  userId: string,
  idempotencyKey: string,
): Promise<ReservationCommandResult> {
  return this.repository.inTransaction(async (transaction) => {
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

    const result = { status: 201, body: await this.createAttendance(transaction, event, userId) };
    await transaction.completeIdempotency(claim.id, result);
    return result;
  });
}
```

The event lock is still first, preserving one lock order across reservation and
cancellation paths. The idempotency row and attendance effects commit together.

Replace `reservations.controller.ts` with its complete final form:

```ts
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { AppError } from '../../shared/errors/app-error.js';
import { getRequestUserId } from '../../shared/http/request-user.middleware.js';
import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { EventAttendanceRequest } from './reservations.schemas.js';
import type { ReservationsService } from './reservations.service.js';

const idempotencyKeySchema = z.string().min(1).max(200);

export class ReservationsController {
  public constructor(private readonly service: ReservationsService) {}

  public readonly reserve: RequestHandler = async (request, response) => {
    const parsedKey = idempotencyKeySchema.safeParse(request.header('Idempotency-Key'));
    if (!parsedKey.success) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key is required');
    }

    const { params } = getValidated<EventAttendanceRequest>(response);
    const result = await this.service.reserve(
      params.eventId,
      getRequestUserId(response),
      parsedKey.data,
    );
    response.status(result.status).json({ data: result.body });
  };

  public readonly getMine: RequestHandler = async (_request, response) => {
    const { params } = getValidated<EventAttendanceRequest>(response);
    const value = await this.service.getReservation(params.eventId, getRequestUserId(response));
    response.json({ data: { ...value, reservedAt: value.reservedAt.toISOString() } });
  };

  public readonly cancelMine: RequestHandler = async (_request, response) => {
    const { params } = getValidated<EventAttendanceRequest>(response);
    await this.service.cancelReservation(params.eventId, getRequestUserId(response));
    response.status(204).send();
  };

  public readonly getMyWaitlist: RequestHandler = async (_request, response) => {
    const { params } = getValidated<EventAttendanceRequest>(response);
    const value = await this.service.getWaitlistEntry(params.eventId, getRequestUserId(response));
    response.json({ data: { ...value, joinedAt: value.joinedAt.toISOString() } });
  };

  public readonly cancelMyWaitlist: RequestHandler = async (_request, response) => {
    const { params } = getValidated<EventAttendanceRequest>(response);
    await this.service.cancelWaitlist(params.eventId, getRequestUserId(response));
    response.status(204).send();
  };
}
```

The controller validates the operation-specific header, delegates every use
case, converts dates at the HTTP boundary, and contains no SQL. Express 5
forwards a thrown error from any async handler to the four-parameter JSON error
middleware.

Add the idempotency cases to the concurrency test:

```ts
it('replays one result for concurrent requests with the same key', async () => {
  const eventId = await createCapacityOneEvent(harness.pool);
  const [first, second] = await Promise.all([
    service.reserve(eventId, aliceId, 'same-key'),
    service.reserve(eventId, aliceId, 'same-key'),
  ]);

  expect(second).toEqual(first);
  const effects = await harness.pool.query<{ reservations: number; keys: number }>(
    `SELECT
       (SELECT count(*)::integer FROM reservations WHERE event_id = $1) AS reservations,
       (SELECT count(*)::integer FROM idempotency_keys
        WHERE user_id = $2 AND scope = $3 AND key = $4) AS keys`,
    [eventId, aliceId, `reserve:${eventId}`, 'same-key'],
  );
  expect(effects.rows[0]).toEqual({ reservations: 1, keys: 1 });
});
```

Update earlier tests to pass distinct idempotency keys. A rollback test should
force notification insertion to fail and assert that neither attendance nor a
completed key remains.

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

Keep PostgreSQL outside `app.ts` by injecting a readiness function:

```ts
export interface AppDependencies {
  corsOrigin: string;
  enableHttpLogging: boolean;
  logger: Logger;
  checkReadiness: () => Promise<boolean>;
}

app.get('/health/live', (_request, response) => {
  response.status(200).json({ status: 'ok' });
});

app.get('/health/ready', async (_request, response) => {
  const ready = await dependencies.checkReadiness();
  response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
});
```

Build the real dependency in `server.ts` with a query-level timeout:

```ts
const pool = createPool(environment);

const checkReadiness = async (): Promise<boolean> => {
  try {
    await pool.query({ text: 'SELECT 1', query_timeout: 1_000 });
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'PostgreSQL readiness check failed');
    return false;
  }
};

const app = createApp({
  corsOrigin: environment.CORS_ORIGIN,
  enableHttpLogging: environment.NODE_ENV === 'development',
  logger,
  checkReadiness,
});
```

Tests inject `async () => true` and `async () => false`, proving both status
codes without requiring PostgreSQL in an API unit test.

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

Replace callback-only shutdown with coordinated async cleanup:

```ts
const closeHttpServer = (): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

let isShuttingDown = false;

const shutDown = async (signal: NodeJS.Signals): Promise<void> => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown started');

  const forcedShutdown = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    server.closeAllConnections();
    process.exitCode = 1;
  }, 10_000);
  forcedShutdown.unref();

  try {
    await closeHttpServer();
    await pool.end();
    logger.info('Graceful shutdown completed');
  } catch (error) {
    logger.error({ err: error }, 'Graceful shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(forcedShutdown);
  }
};

process.once('SIGINT', (signal) => void shutDown(signal));
process.once('SIGTERM', (signal) => void shutDown(signal));
```

HTTP closes before the pool so an accepted request never loses its database
resource midway through normal shutdown. The forced timer bounds the drain.

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

### Complete Step 24 application composition

At this point, replace incremental fragments with one complete `src/app.ts`:

```ts
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import { createErrorHandler } from './shared/errors/error-handler.js';
import { notFoundHandler } from './shared/errors/not-found-handler.js';
import { createDevelopmentHttpLogger } from './shared/logging/logger.js';
import { requestIdMiddleware } from './shared/logging/request-id.middleware.js';

export interface AppDependencies {
  corsOrigin: string;
  enableHttpLogging: boolean;
  logger: Logger;
  checkReadiness: () => Promise<boolean>;
  communitiesRouter: Router;
  membershipsRouter: Router;
  eventsRouter: Router;
  reservationsRouter: Router;
}

export const createApp = (dependencies: AppDependencies): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: dependencies.corsOrigin }));
  app.use(requestIdMiddleware);
  if (dependencies.enableHttpLogging) app.use(createDevelopmentHttpLogger());
  app.use(express.json({ limit: '1mb' }));

  app.get('/health/live', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });
  app.get('/health/ready', async (_request, response) => {
    const ready = await dependencies.checkReadiness();
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  app.use('/api/communities', dependencies.communitiesRouter);
  app.use('/api/communities', dependencies.membershipsRouter);
  app.use('/api', dependencies.eventsRouter);
  app.use('/api', dependencies.reservationsRouter);

  app.use(notFoundHandler);
  app.use(createErrorHandler(dependencies.logger));
  return app;
};
```

Then use this complete `src/server.ts` composition root. The imports assume the
module files created in Steps 16–23:

```ts
import 'dotenv/config';

import { createServer } from 'node:http';

import pino from 'pino';

import { createApp } from './app.js';
import { environment } from './config/env.js';
import { createPool } from './infrastructure/postgres/pool.js';
import { CommunitiesController } from './modules/communities/communities.controller.js';
import { CommunitiesRepository } from './modules/communities/communities.repository.js';
import { createCommunitiesRouter } from './modules/communities/communities.routes.js';
import { CommunitiesService } from './modules/communities/communities.service.js';
import { EventsController } from './modules/events/events.controller.js';
import { EventsRepository } from './modules/events/events.repository.js';
import { createEventsRouter } from './modules/events/events.routes.js';
import { EventsService } from './modules/events/events.service.js';
import { MembershipsController } from './modules/memberships/memberships.controller.js';
import { MembershipsRepository } from './modules/memberships/memberships.repository.js';
import { createMembershipsRouter } from './modules/memberships/memberships.routes.js';
import { MembershipsService } from './modules/memberships/memberships.service.js';
import { ReservationsController } from './modules/reservations/reservations.controller.js';
import { ReservationsRepository } from './modules/reservations/reservations.repository.js';
import { createReservationsRouter } from './modules/reservations/reservations.routes.js';
import { ReservationsService } from './modules/reservations/reservations.service.js';

const logger = pino(
  environment.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {},
);
const pool = createPool(environment);
pool.on('error', (error) => logger.error({ err: error }, 'Idle PostgreSQL client failed'));

const communitiesRepository = new CommunitiesRepository(pool);
const communitiesService = new CommunitiesService(communitiesRepository);
const communitiesRouter = createCommunitiesRouter(new CommunitiesController(communitiesService));

const membershipsRepository = new MembershipsRepository(pool);
const membershipsService = new MembershipsService(membershipsRepository);
const membershipsRouter = createMembershipsRouter(new MembershipsController(membershipsService));

const eventsRepository = new EventsRepository(pool);
const eventsService = new EventsService(eventsRepository);
const eventsRouter = createEventsRouter(new EventsController(eventsService));

const reservationsRepository = new ReservationsRepository(pool);
const reservationsService = new ReservationsService(reservationsRepository);
const reservationsRouter = createReservationsRouter(
  new ReservationsController(reservationsService),
);

const checkReadiness = async (): Promise<boolean> => {
  try {
    await pool.query({ text: 'SELECT 1', query_timeout: 1_000 });
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'PostgreSQL readiness check failed');
    return false;
  }
};

const app = createApp({
  corsOrigin: environment.CORS_ORIGIN,
  enableHttpLogging: environment.NODE_ENV === 'development',
  logger,
  checkReadiness,
  communitiesRouter,
  membershipsRouter,
  eventsRouter,
  reservationsRouter,
});
const server = createServer(app);

server.listen(environment.PORT, () => {
  logger.info({ port: environment.PORT }, 'Gatherly HTTP server started');
});

const closeHttpServer = (): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

let isShuttingDown = false;
const shutDown = async (signal: NodeJS.Signals): Promise<void> => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown started');

  const forcedShutdown = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    server.closeAllConnections();
    process.exitCode = 1;
  }, 10_000);
  forcedShutdown.unref();

  try {
    await closeHttpServer();
    await pool.end();
    logger.info('Graceful shutdown completed');
  } catch (error) {
    logger.error({ err: error }, 'Graceful shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(forcedShutdown);
  }
};

process.once('SIGINT', (signal) => void shutDown(signal));
process.once('SIGTERM', (signal) => void shutDown(signal));
```

The composition root creates and therefore closes the pool. HTTP drains first
so accepted requests retain database access; the forced timer bounds shutdown.
Tests inject readiness callbacks and routers without importing `server.ts`.

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

Use one concrete example at each level:

```ts
// tests/unit/events.schemas.test.ts
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { createEventRequestSchema } from '../../src/modules/events/events.schemas.js';

it('rejects an end before the start', () => {
  const result = createEventRequestSchema.safeParse({
    params: { communityId: randomUUID() },
    query: {},
    body: {
      title: 'Board games',
      slug: 'board-games',
      startsAt: '2026-08-03T18:00:00.000Z',
      endsAt: '2026-08-03T17:00:00.000Z',
      timezone: 'Europe/Moscow',
      capacity: 10,
    },
  });
  expect(result.success).toBe(false);
});
```

```ts
// tests/integration/communities.repository.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommunitiesRepository } from '../../src/modules/communities/communities.repository.js';
import { type PostgresHarness, startPostgresHarness } from './postgres-harness.js';

const aliceId = '00000000-0000-4000-8000-000000000001';

describe('CommunitiesRepository', () => {
  let harness: PostgresHarness;
  let repository: CommunitiesRepository;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    repository = new CommunitiesRepository(harness.pool);
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('creates the community and owner membership atomically', async () => {
    const community = await repository.createWithOwner(aliceId, {
      name: 'Chess Club',
      slug: 'chess-club',
      description: '',
      city: null,
      country: null,
    });
    const membership = await harness.pool.query<{ role: string; status: string }>(
      `SELECT role, status FROM community_memberships
       WHERE community_id = $1 AND user_id = $2`,
      [community.id, aliceId],
    );

    expect(community.createdByUserId).toBe(aliceId);
    expect(membership.rows[0]).toEqual({ role: 'OWNER', status: 'ACTIVE' });
  });
});
```

```ts
// tests/api/communities.test.ts
import { Router } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { CommunitiesController } from '../../src/modules/communities/communities.controller.js';
import { CommunitiesRepository } from '../../src/modules/communities/communities.repository.js';
import { createCommunitiesRouter } from '../../src/modules/communities/communities.routes.js';
import { CommunitiesService } from '../../src/modules/communities/communities.service.js';
import { type PostgresHarness, startPostgresHarness } from '../integration/postgres-harness.js';

const aliceId = '00000000-0000-4000-8000-000000000001';

describe('communities API', () => {
  let harness: PostgresHarness;

  beforeAll(async () => {
    harness = await startPostgresHarness();
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('creates a community and returns JSON with a request ID', async () => {
    const repository = new CommunitiesRepository(harness.pool);
    const controller = new CommunitiesController(new CommunitiesService(repository));
    const app = createApp({
      logger: pino({ enabled: false }),
      enableHttpLogging: false,
      isDatabaseReady: async () => true,
      communitiesRouter: createCommunitiesRouter(controller),
      membershipsRouter: Router(),
      eventsRouter: Router(),
      reservationsRouter: Router(),
    });

    const response = await request(app)
      .post('/api/communities')
      .set('x-user-id', aliceId)
      .send({ name: 'Chess Club', slug: 'chess-club' });

    expect(response.status).toBe(201);
    expect(response.type).toMatch(/json/);
    expect(response.headers['x-request-id']).toBeTypeOf('string');
    expect(response.body.data.slug).toBe('chess-club');
  });
});
```

Step 30 provides the complete end-to-end file. It intentionally uses the real
reservation service and PostgreSQL queries instead of undefined `reserve`,
`cancel`, or assertion helpers.

Unit tests prove pure rules, repository tests prove SQL, API tests prove HTTP
translation, and the end-to-end test proves that the layers work together. Do
not duplicate every assertion at every level.

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

First extract the Step 10 algorithm to
`src/infrastructure/postgres/migration-runner.ts`. This is the complete reusable
runner; importing it has no CLI side effect:

```ts
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Pool } from 'pg';

const migrationLockId = 7_240_162_551;

export const runMigrations = async (pool: Pool, directory: string): Promise<void> => {
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockId]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationNames = (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort((left, right) => left.localeCompare(right));
    const appliedResult = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    );
    const appliedNames = new Set(appliedResult.rows.map(({ name }) => name));

    for (const name of migrationNames) {
      if (appliedNames.has(name)) continue;

      const sql = await readFile(path.join(directory, name), 'utf8');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (error: unknown) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId]);
    } finally {
      client.release();
    }
  }
};
```

The advisory lock prevents two application instances from applying the same
pending file concurrently. Each file gets its own transaction, so a broken file
is neither partly applied nor recorded. The caller owns the pool, which is why
this function releases only its checked-out client.

Replace `src/infrastructure/postgres/migrate.ts` with this complete CLI wrapper:

```ts
import 'dotenv/config';

import path from 'node:path';

import { parseEnvironment } from '../../config/environment.js';
import { createPool } from './pool.js';
import { runMigrations } from './migration-runner.js';

const migrate = async (): Promise<void> => {
  const environment = parseEnvironment(process.env);
  const pool = createPool(environment);
  const migrationsDirectory = path.resolve(process.cwd(), 'db/migrations');

  try {
    await runMigrations(pool, migrationsDirectory);
  } finally {
    await pool.end();
  }
};

migrate().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

The executable wrapper parses configuration, creates the resource, invokes the
reusable algorithm, and closes the resource. Tests call `runMigrations`
directly and therefore never execute this CLI block.

Create `tests/integration/postgres-harness.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg, { type Pool } from 'pg';

import { runMigrations } from '../../src/infrastructure/postgres/migration-runner.js';

export interface PostgresHarness {
  connectionString: string;
  pool: Pool;
  reset: () => Promise<void>;
  seed: () => Promise<void>;
  stop: () => Promise<void>;
}

export const startPostgresHarness = async (): Promise<PostgresHarness> => {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:17-bookworm',
  ).start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 10 });

  await runMigrations(pool, path.resolve(process.cwd(), 'db/migrations'));

  const seed = async (): Promise<void> => {
    const sql = await readFile(path.resolve(process.cwd(), 'db/seeds/development.sql'), 'utf8');
    await pool.query(sql);
  };

  const reset = async (): Promise<void> => {
    await pool.query(`
      TRUNCATE TABLE
        notifications, idempotency_keys, waitlist_entries, reservations,
        events, community_memberships, communities, users
      RESTART IDENTITY CASCADE
    `);
  };

  return {
    connectionString: container.getConnectionUri(),
    pool,
    reset,
    seed,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
};
```

Use it from one integration suite:

```ts
let harness: PostgresHarness;

beforeAll(async () => {
  harness = await startPostgresHarness();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  await harness.seed();
});

afterAll(async () => {
  await harness.stop();
});
```

The harness owns everything it creates. `runMigrations` does not close a
caller-owned pool; `stop()` closes the pool before stopping its container. If
Step 23 has not been applied in a branch, omit `idempotency_keys` from truncation
until that migration exists.

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

Start `docs/openapi.yaml` with a valid, executable contract rather than prose:

```yaml
openapi: 3.1.0
info:
  title: Gatherly API
  version: 0.1.0
servers:
  - url: http://localhost:3000
paths:
  /api/communities:
    post:
      summary: Create a community and owner membership
      parameters:
        - $ref: '#/components/parameters/RequestUserId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateCommunity'
      responses:
        '201':
          description: Community created
          headers:
            x-request-id:
              $ref: '#/components/headers/RequestId'
          content:
            application/json:
              schema:
                type: object
                required: [data]
                properties:
                  data:
                    $ref: '#/components/schemas/Community'
        '400':
          $ref: '#/components/responses/BadRequest'
        '409':
          $ref: '#/components/responses/Conflict'
  /api/events/{eventId}/reservations:
    post:
      summary: Reserve a place or join the waitlist
      parameters:
        - $ref: '#/components/parameters/EventId'
        - $ref: '#/components/parameters/RequestUserId'
        - $ref: '#/components/parameters/IdempotencyKey'
      responses:
        '201':
          description: Confirmed or waitlisted
          content:
            application/json:
              schema:
                type: object
                required: [data]
                properties:
                  data:
                    oneOf:
                      - $ref: '#/components/schemas/ConfirmedOutcome'
                      - $ref: '#/components/schemas/WaitlistedOutcome'
components:
  parameters:
    EventId:
      name: eventId
      in: path
      required: true
      schema: { type: string, format: uuid }
    RequestUserId:
      name: x-user-id
      in: header
      required: true
      description: Development-only identity; not authentication.
      schema: { type: string, format: uuid }
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      schema: { type: string, minLength: 1, maxLength: 200 }
  headers:
    RequestId:
      schema: { type: string, format: uuid }
  schemas:
    CreateCommunity:
      type: object
      additionalProperties: false
      required: [name, slug]
      properties:
        name: { type: string, minLength: 3, maxLength: 100 }
        slug: { type: string, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }
        description: { type: string, maxLength: 2000, default: '' }
    Community:
      type: object
      required: [id, name, slug, createdByUserId, createdAt, updatedAt]
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        slug: { type: string }
        createdByUserId: { type: string, format: uuid }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }
    ConfirmedOutcome:
      type: object
      required: [attendanceStatus, reservationId]
      properties:
        attendanceStatus: { const: CONFIRMED }
        reservationId: { type: string, format: uuid }
    WaitlistedOutcome:
      type: object
      required: [attendanceStatus, waitlistEntryId, position]
      properties:
        attendanceStatus: { const: WAITLISTED }
        waitlistEntryId: { type: string, format: uuid }
        position: { type: integer, minimum: 1 }
    Error:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message, requestId]
          properties:
            code: { type: string }
            message: { type: string }
            requestId: { type: string, format: uuid }
  responses:
    BadRequest:
      description: Invalid request
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }
    Conflict:
      description: State conflict
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }
```

Do not leave the file with only those two teaching examples. Replace its
`paths` block with this complete path inventory; keep the `components` block
above for the shared headers, parameters, outcomes, and error envelope:

```yaml
paths:
  /api/communities:
    get:
      summary: List public active communities
      parameters:
        - { name: page, in: query, schema: { type: integer, minimum: 1, default: 1 } }
        - {
            name: limit,
            in: query,
            schema: { type: integer, minimum: 1, maximum: 100, default: 20 },
          }
      responses:
        '200': { description: A page of communities }
        '400': { $ref: '#/components/responses/BadRequest' }
    post:
      summary: Create a community and owner membership
      parameters:
        - $ref: '#/components/parameters/RequestUserId'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateCommunity' }
      responses:
        '201': { description: Community created }
        '400': { $ref: '#/components/responses/BadRequest' }
        '409': { $ref: '#/components/responses/Conflict' }
  /api/communities/{communityId}:
    get:
      summary: Get a public active community
      parameters:
        - &communityId
          name: communityId
          in: path
          required: true
          schema: { type: string, format: uuid }
      responses:
        '200': { description: Community returned }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { description: Community not found }
  /api/communities/{communityId}/join:
    post:
      summary: Join an open community
      parameters:
        - *communityId
        - $ref: '#/components/parameters/RequestUserId'
      responses:
        '201': { description: Membership created }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { description: Community not found }
        '409': { $ref: '#/components/responses/Conflict' }
  /api/communities/{communityId}/leave:
    post:
      summary: Leave a community while retaining membership history
      parameters:
        - *communityId
        - $ref: '#/components/parameters/RequestUserId'
      responses:
        '200': { description: Membership transitioned to LEFT }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { description: Active membership not found }
        '409': { $ref: '#/components/responses/Conflict' }
  /api/communities/{communityId}/events:
    post:
      summary: Create an event as an authorized active member
      parameters:
        - *communityId
        - $ref: '#/components/parameters/RequestUserId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [title, slug, startsAt, endsAt, timezone, capacity]
              properties:
                title: { type: string, minLength: 3, maxLength: 160 }
                slug: { type: string, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }
                description: { type: string, maxLength: 5000, default: '' }
                startsAt: { type: string, format: date-time }
                endsAt: { type: string, format: date-time }
                timezone: { type: string, example: Europe/Moscow }
                capacity: { type: integer, minimum: 1 }
      responses:
        '201': { description: Event created }
        '400': { $ref: '#/components/responses/BadRequest' }
        '403': { description: Community permission denied }
        '404': { description: Community not found }
        '409': { $ref: '#/components/responses/Conflict' }
  /api/events:
    get:
      summary: List public published events
      parameters:
        - { name: communityId, in: query, schema: { type: string, format: uuid } }
        - { name: status, in: query, schema: { type: string, enum: [PUBLISHED] } }
        - { name: startsAfter, in: query, schema: { type: string, format: date-time } }
        - { name: page, in: query, schema: { type: integer, minimum: 1, default: 1 } }
        - {
            name: limit,
            in: query,
            schema: { type: integer, minimum: 1, maximum: 100, default: 20 },
          }
      responses:
        '200': { description: A page of events }
        '400': { $ref: '#/components/responses/BadRequest' }
  /api/events/{eventId}:
    get:
      summary: Get a public published event
      parameters:
        - &eventId
          $ref: '#/components/parameters/EventId'
      responses:
        '200': { description: Event returned }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { description: Event not found }
  /api/events/{eventId}/reservations:
    post:
      summary: Reserve a place or join the waitlist
      parameters:
        - *eventId
        - $ref: '#/components/parameters/RequestUserId'
        - $ref: '#/components/parameters/IdempotencyKey'
      responses:
        '201':
          description: Confirmed or waitlisted
          content:
            application/json:
              schema:
                type: object
                required: [data]
                properties:
                  data:
                    oneOf:
                      - $ref: '#/components/schemas/ConfirmedOutcome'
                      - $ref: '#/components/schemas/WaitlistedOutcome'
        '400': { $ref: '#/components/responses/BadRequest' }
        '403': { description: Active membership required }
        '404': { description: Event not found }
        '409': { $ref: '#/components/responses/Conflict' }
  /api/events/{eventId}/reservations/me:
    get:
      summary: Get the caller's active reservation
      parameters:
        - *eventId
        - $ref: '#/components/parameters/RequestUserId'
      responses:
        '200': { description: Active reservation returned }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { description: Active reservation not found }
    delete:
      summary: Cancel a reservation and promote at most one waiting user
      parameters:
        - *eventId
        - $ref: '#/components/parameters/RequestUserId'
      responses:
        '204': { description: Reservation cancelled }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { description: Active reservation not found }
  /api/events/{eventId}/waitlist/me:
    get:
      summary: Get the caller's active waitlist entry
      parameters:
        - *eventId
        - $ref: '#/components/parameters/RequestUserId'
      responses:
        '200': { description: Active waitlist entry returned }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { description: Active waitlist entry not found }
    delete:
      summary: Cancel the caller's waitlist entry
      parameters:
        - *eventId
        - $ref: '#/components/parameters/RequestUserId'
      responses:
        '204': { description: Waitlist entry cancelled }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { description: Active waitlist entry not found }
```

YAML anchors keep the repeated path parameters identical. The response
descriptions are intentionally concise, but every implemented method, required
header, request body, and status family is present. Validate the assembled file
with an OpenAPI-capable editor; do not install a documentation runtime merely to
display one file during this phase.

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

To make the gate repeatable, create `scripts/verify-phase-2.ps1`:

```powershell
$ErrorActionPreference = 'Stop'

yarn format:check
yarn lint
yarn typecheck
yarn test
yarn build

docker compose config --quiet
docker compose build app
docker compose up --detach

try {
  docker compose ps
  Invoke-RestMethod -Uri http://127.0.0.1:3000/health/live
  Invoke-RestMethod -Uri http://127.0.0.1:3000/health/ready

  docker compose run --rm app node dist/infrastructure/postgres/migrate.js
  docker compose run --rm app node dist/infrastructure/postgres/migrate.js
} finally {
  docker compose stop app
  docker compose logs app
}
```

Run it from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-phase-2.ps1
```

`$ErrorActionPreference = 'Stop'` prevents a failed host check or health call
from being hidden by later commands. The `finally` block still stops the app and
prints its logs. It deliberately leaves PostgreSQL running so you can inspect
the development database; use the documented cleanup command when you actually
want to remove it and its volume.

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

Make the drills reproducible instead of relying on manual observation.

SQL injection stays data because the repository parameterizes it:

```ts
const hostileName = `Chess'); DROP TABLE communities; --`;
const response = await request(app)
  .post('/api/communities')
  .set('x-user-id', aliceId)
  .send({ name: hostileName, slug: 'hostile-input' });
expect(response.status).toBe(201);
expect(
  (await harness.pool.query(`SELECT to_regclass('communities') AS table_name`)).rows[0].table_name,
).toBe('communities');
```

Prove safe unique-error translation with concurrent HTTP calls:

```ts
const createCommunity = (userId: string) =>
  request(app)
    .post('/api/communities')
    .set('x-user-id', userId)
    .send({ name: 'Same Slug', slug: 'same-slug' });
const results = await Promise.all([createCommunity(aliceId), createCommunity(bobId)]);
expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
expect(results.find((result) => result.status === 409)?.body.error.code).toBe(
  'COMMUNITY_SLUG_TAKEN',
);
```

Use a test-only operation callback to force a transaction failure after the
first insert, then query the database after rejection:

```ts
await expect(
  withTransaction(harness.pool, async (client) => {
    await client.query(
      `INSERT INTO communities (name, slug, created_by_user_id) VALUES ($1, $2, $3)`,
      ['Rollback Probe', 'rollback-probe', aliceId],
    );
    throw new Error('forced failure');
  }),
).rejects.toThrow('forced failure');
expect(
  (await harness.pool.query(`SELECT 1 FROM communities WHERE slug = 'rollback-probe'`)).rowCount,
).toBe(0);
```

Automate the PostgreSQL outage drill as `scripts/drill-postgres-outage.ps1` so
the database is restarted even when an assertion fails:

```powershell
$ErrorActionPreference = 'Stop'
$composeFiles = @('-f', 'compose.yaml', '-f', 'compose.dev.yaml')

docker compose @composeFiles stop postgres

try {
  $live = Invoke-WebRequest `
    -Uri http://127.0.0.1:3000/health/live `
    -SkipHttpErrorCheck
  $ready = Invoke-WebRequest `
    -Uri http://127.0.0.1:3000/health/ready `
    -SkipHttpErrorCheck

  if ($live.StatusCode -ne 200) {
    throw "Expected liveness 200, received $($live.StatusCode)"
  }
  if ($ready.StatusCode -ne 503) {
    throw "Expected readiness 503, received $($ready.StatusCode)"
  }
} finally {
  docker compose @composeFiles start postgres
}

$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  $ready = Invoke-WebRequest `
    -Uri http://127.0.0.1:3000/health/ready `
    -SkipHttpErrorCheck
} until ($ready.StatusCode -eq 200 -or (Get-Date) -ge $deadline)

if ($ready.StatusCode -ne 200) {
  throw 'PostgreSQL did not become ready again within 30 seconds'
}
```

Run it only while the local development stack is active:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/drill-postgres-outage.ps1
```

Observe pool pressure in an integration test with `max: 2`:

```ts
const smallPool = new pg.Pool({ connectionString: harness.connectionString, max: 2 });
await Promise.all(Array.from({ length: 10 }, () => smallPool.query('SELECT pg_sleep(0.05)')));
expect(smallPool.totalCount).toBeLessThanOrEqual(2);
await smallPool.end();
```

For the migration drill, add `999_invalid_probe.sql` containing invalid SQL,
run `yarn db:migrate`, and assert that no history row was committed:

```sql
SELECT count(*) = 0 AS not_recorded
FROM schema_migrations
WHERE name = '999_invalid_probe.sql';
```

Delete only that unapplied probe file afterward. Never modify an already-applied
migration to conduct this drill.

Prove duplicate cancellation cannot promote twice:

```ts
const results = await Promise.allSettled([
  reservationService.cancelReservation(eventId, confirmedUserId),
  reservationService.cancelReservation(eventId, confirmedUserId),
]);
expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

const state = await pool.query<{ reservations: number; promotions: number; notifications: number }>(
  `SELECT
     (SELECT count(*)::integer FROM reservations
      WHERE event_id = $1 AND status = 'CONFIRMED') AS reservations,
     (SELECT count(*)::integer FROM waitlist_entries
      WHERE event_id = $1 AND status = 'PROMOTED') AS promotions,
     (SELECT count(*)::integer FROM notifications
      WHERE type = 'WAITLIST_PROMOTED' AND data->>'eventId' = $1::text) AS notifications`,
  [eventId],
);
expect(state.rows[0]).toEqual({ reservations: 1, promotions: 1, notifications: 1 });
```

Run drills only against disposable integration state or the local development
stack. The expected error is part of the proof; always restore PostgreSQL and
remove temporary probes in `finally`/test teardown.

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

Encode that proof in `tests/e2e/reservation-lifecycle.test.ts` and run it with
the concurrency test:

```powershell
yarn vitest run tests/e2e/reservation-lifecycle.test.ts tests/integration/reservations.concurrent.test.ts
```

The final lifecycle assertion should query all three authoritative tables in one
snapshot:

```ts
const proof = await pool.query(
  `SELECT
     (SELECT count(*)::integer FROM reservations
      WHERE event_id = $1 AND status = 'CONFIRMED') AS confirmed,
     (SELECT count(*)::integer FROM waitlist_entries
      WHERE event_id = $1 AND status = 'PROMOTED') AS promoted,
     (SELECT count(*)::integer FROM notifications
      WHERE type = 'WAITLIST_PROMOTED' AND data->>'eventId' = $1::text) AS notified`,
  [eventId],
);
expect(proof.rows[0]).toEqual({ confirmed: 1, promoted: 1, notified: 1 });
```

Here is the complete `tests/e2e/reservation-lifecycle.test.ts`; it contains its
own fixture instead of depending on unexplained `reserve`, `cancel`, or query
helpers:

```ts
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ReservationsRepository } from '../../src/modules/reservations/reservations.repository.js';
import { ReservationsService } from '../../src/modules/reservations/reservations.service.js';
import { type PostgresHarness, startPostgresHarness } from '../integration/postgres-harness.js';

const aliceId = '00000000-0000-4000-8000-000000000001';
const bobId = '00000000-0000-4000-8000-000000000002';

const createLifecycleEvent = async (pool: Pool): Promise<string> => {
  const community = await pool.query<{ id: string }>(
    `INSERT INTO communities (name, slug, created_by_user_id)
     VALUES ('Lifecycle Community', 'lifecycle-community', $1)
     RETURNING id`,
    [aliceId],
  );
  const communityId = community.rows[0]?.id;
  if (communityId === undefined) throw new Error('Community fixture failed');

  await pool.query(
    `INSERT INTO community_memberships (community_id, user_id, role, status)
     VALUES
       ($1, $2, 'OWNER', 'ACTIVE'),
       ($1, $3, 'MEMBER', 'ACTIVE')`,
    [communityId, aliceId, bobId],
  );
  const event = await pool.query<{ id: string }>(
    `INSERT INTO events
       (community_id, created_by_user_id, title, slug, starts_at, ends_at,
        timezone, capacity)
     VALUES
       ($1, $2, 'Lifecycle event', 'lifecycle-event', now() + interval '1 day',
        now() + interval '2 days', 'Europe/Moscow', 1)
     RETURNING id`,
    [communityId, aliceId],
  );
  const eventId = event.rows[0]?.id;
  if (eventId === undefined) throw new Error('Event fixture failed');
  return eventId;
};

describe('reservation lifecycle', () => {
  let harness: PostgresHarness;
  let service: ReservationsService;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    service = new ReservationsService(new ReservationsRepository(harness.pool));
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('allocates one place, waitlists one user, then atomically promotes that user', async () => {
    const eventId = await createLifecycleEvent(harness.pool);
    const [alice, bob] = await Promise.all([
      service.reserve(eventId, aliceId, 'alice-final-place'),
      service.reserve(eventId, bobId, 'bob-final-place'),
    ]);
    const resultsByUser = new Map([
      [aliceId, alice.body.attendanceStatus],
      [bobId, bob.body.attendanceStatus],
    ]);
    expect([...resultsByUser.values()].sort()).toEqual(['CONFIRMED', 'WAITLISTED']);

    const confirmedUser = [...resultsByUser].find(([, status]) => status === 'CONFIRMED')?.[0];
    const waitingUser = [...resultsByUser].find(([, status]) => status === 'WAITLISTED')?.[0];
    if (confirmedUser === undefined || waitingUser === undefined) {
      throw new Error('Fixture did not produce one confirmed and one waiting user');
    }

    await service.cancelReservation(eventId, confirmedUser);

    const proof = await harness.pool.query<{
      confirmed: number;
      promoted: number;
      notified: number;
      confirmed_user_id: string | null;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM reservations
          WHERE event_id = $1 AND status = 'CONFIRMED') AS confirmed,
         (SELECT count(*)::integer FROM waitlist_entries
          WHERE event_id = $1 AND status = 'PROMOTED') AS promoted,
         (SELECT count(*)::integer FROM notifications
          WHERE type = 'WAITLIST_PROMOTED' AND data->>'eventId' = $1::text) AS notified,
         (SELECT user_id FROM reservations
          WHERE event_id = $1 AND status = 'CONFIRMED') AS confirmed_user_id`,
      [eventId],
    );

    expect(proof.rows[0]).toEqual({
      confirmed: 1,
      promoted: 1,
      notified: 1,
      confirmed_user_id: waitingUser,
    });
  });
});
```

The two initial calls race on different pool clients. Whichever transaction
locks the event first becomes confirmed; the other sees the committed count and
waitlists. Cancellation locks that same event, changes the old reservation,
promotes the first waiting row, inserts its reservation, and writes its
notification before one commit.

Passing commands are not enough for the examination: explain which transaction
and constraint makes each value remain exactly one under concurrency.

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
