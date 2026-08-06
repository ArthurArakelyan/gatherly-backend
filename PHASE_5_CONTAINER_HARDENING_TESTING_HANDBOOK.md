# Phase 5 Handbook: Container Hardening and Serious Behavioral Testing

This is a build-it-yourself guide for the repository as it exists after Phase 4. It explains what to change, why the change matters, what code to paste, how
to verify it, and what result to expect.

The old roadmap milestone about deploying to real users is deliberately
skipped. Gatherly is a pet and learning project. Phase 5 therefore takes the
useful work from the former Phase 6: harden the local production-style
container and prove the existing business invariants under concurrency and
failure.

Do not add Redis, Kafka, Elasticsearch, SSE, WebSockets, Nginx, Kubernetes, a
frontend, or new product modules in this phase.

## How to use this handbook

Work through one checkpoint at a time. Do not paste the entire handbook into
the repository in one pass.

Each checkpoint has four parts:

1. **Reason:** the engineering lesson behind the change.
2. **Implementation:** exact files and copy-pasteable code.
3. **Verification:** commands to run.
4. **Expected result:** evidence that the checkpoint is complete.

Code blocks labelled **complete file** replace the whole named file. Blocks
labelled **add this test** belong inside the existing `describe` block named by
the instruction. Small diff blocks show the exact local edit when replacing a
whole large file would hide the lesson.

Before beginning, commit or otherwise preserve the completed Phase 4 work. The
database and Docker cleanup exercises later in this handbook deliberately use
an isolated Compose project name, but a source-control checkpoint is still the
safest recovery point for code.

## What Phase 4 already proves

Do not recreate tests that already exist:

- `tests/api/identity.api.test.ts` proves sign-up, sign-in, `/auth/me`, password
  hashing, safe credential errors, current account-status checks, and both auth
  rate limits.
- `tests/unit/security-adapters.test.ts` proves Argon2 verification and the
  basic JWT issuer/audience boundary.
- `tests/integration/reservations.integration.test.ts` already proves the
  final-place race, idempotent replay, and normal waitlist promotion with real
  PostgreSQL.
- `tests/e2e/reservation-lifecycle.e2e.test.ts` proves the successful
  cross-module reservation lifecycle through HTTP.

Phase 5 adds failure evidence around that baseline. The important missing
proofs are transaction rollback, bounded shutdown, dependency outage, and a
repeatable production-style container gate.

## Current implementation status

The automated-testing portion of this handbook is now implemented:

- shutdown-aware readiness and the reusable graceful-shutdown coordinator;
- graceful draining, repeated-signal, and forced-timeout integration tests;
- PostgreSQL-trigger failure injection proving cancellation/promotion rollback;
- forged, expired, wrong-issuer, and wrong-audience JWT tests;
- cross-community event authorization coverage;
- suspended-membership reservation denial with durable-state assertions.

The remaining checkpoints are operational exercises: running and inspecting
the hardened containers, rehearsing the one-shot migration workflow, executing
the PostgreSQL outage drill, and running the local release gate. Their scripts
and commands remain below so they can be performed when Docker behavior is the
learning target.

---

## Checkpoint 1: Record a clean baseline

### Reason

Hardening without a baseline produces claims such as “the image is smaller” or
“startup still works” without evidence. First prove Phase 4 and record the
current image metadata.

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
docker compose build app
docker image ls gatherly-backend-app
docker history gatherly-backend-app
```

If Docker chose a different generated image name, find it with:

```powershell
docker compose images
```

Record these facts in your Phase 5 notes:

```text
baseline date:
git commit:
test files / tests passed:
runtime image size:
uncached build duration:
cached rebuild duration after changing only src/:
```

### Expected result

All Phase 4 checks pass before Phase 5 code is introduced. If they do not,
repair the baseline first; otherwise later failures cannot be attributed to
the hardening work.

---

## Checkpoint 2: Build separate development, migration, and runtime images

### Reason

The application process and the migration process need different tools:

- development needs TypeScript, Vitest, Prisma CLI, and file watching;
- migration needs Prisma CLI and migration files, but it does not serve HTTP;
- runtime needs compiled JavaScript and production dependencies, but it should
  not contain TypeScript, tests, Vitest, or Prisma CLI.

Running `prisma migrate deploy` from every application replica creates an
ownership problem: several processes can attempt release work at once. A
separate one-shot migration image makes the actor explicit and lets Compose
block application startup when migrations fail.

### Implementation

Replace `Dockerfile` with this **complete file**:

```dockerfile
FROM node:24-bookworm-slim AS base

# Prisma's PostgreSQL runtime needs OpenSSL. Install it once in the shared base
# so the build, migration, and application stages use the same system library.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS dependencies

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile \
  && yarn cache clean

FROM dependencies AS development

ENV NODE_ENV=development
COPY tsconfig.json tsconfig.build.json vitest.config.ts prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY tests ./tests
RUN DATABASE_URL=postgresql://unused:unused@localhost:5432/unused yarn prisma:generate
USER node
CMD ["yarn", "dev"]

FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN DATABASE_URL=postgresql://unused:unused@localhost:5432/unused yarn build

# This stage intentionally retains Prisma CLI from the full dependency install.
# It is a one-shot release tool, not the HTTP application image.
FROM dependencies AS migration

ENV NODE_ENV=production
COPY prisma.config.ts ./
COPY prisma ./prisma
USER node
CMD ["yarn", "db:migrate:deploy"]

FROM base AS production-dependencies

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true \
  && yarn cache clean

FROM base AS runtime

ENV NODE_ENV=production

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

Important details:

- `yarn.lock` and `--frozen-lockfile` make dependency resolution reproducible.
- dependency files are copied before source files so ordinary source changes do
  not invalidate the expensive install layer;
- `migration` has Prisma CLI, while `runtime` has production dependencies only;
- TypeScript compiles the generated Prisma client below `src/generated` into
  `dist/generated`, so the runtime does not copy the generated TypeScript
  sources a second time;
- the runtime image does not need `prisma.config.ts` or migration SQL because it
  never applies migrations;
- `USER node` reduces the impact of a process compromise, but it is not a full
  sandbox; kernel access and mounted secrets still matter;
- no secret is an `ARG` or `ENV` baked into the Dockerfile.

Replace `.dockerignore` with this **complete file**:

```dockerignore
node_modules
dist
coverage
.git
.gitignore
.env
.env.*
*.log
*.tmp
.vscode
.idea
docs
db
README.md
AGENTS.md
PHASE_*.md
```

Do not add `tests` to `.dockerignore`: the `development` stage intentionally
copies tests so they can run inside the development container. The runtime
stage never copies them.

### Verification

```powershell
docker compose build --no-cache app
docker build --target migration --tag gatherly-migration:phase5 .

docker image inspect gatherly-backend-app --format '{{.Config.User}}'
docker run --rm --entrypoint node gatherly-backend-app -e `
  "const fs=require('node:fs'); console.log({tests:fs.existsSync('/app/tests'), prismaCli:fs.existsSync('/app/node_modules/prisma')})"
```

If the Compose image name differs, substitute the name reported by
`docker compose images`.

### Expected result

The configured user is `node`. The runtime inspection prints:

```text
{ tests: false, prismaCli: false }
```

The migration image can run `yarn db:migrate:deploy`; the application image
cannot accidentally run Prisma CLI because it does not contain that tool.

---

## Checkpoint 3: Make migrations a one-shot Compose service

### Reason

`depends_on: condition: service_healthy` only says PostgreSQL accepts
connections. It does not say the application schema exists. A one-shot
`migration` service creates this order:

```text
PostgreSQL healthy -> migration exits 0 -> application may start
                                  |
                                  +-> migration exits non-zero -> app stays stopped
```

This is release ordering, not application startup logic. Never replace failure
with `prisma migrate reset`; that destroys data instead of recovering it.

### Implementation

Replace `compose.yaml` with this **complete file**:

```yaml
services:
  postgres:
    image: postgres:17-bookworm
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    ports:
      - '127.0.0.1:${POSTGRES_PORT}:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}']
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  migration:
    build:
      context: .
      dockerfile: Dockerfile
      target: migration
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
    depends_on:
      postgres:
        condition: service_healthy
    restart: 'no'

  app:
    build:
      context: .
      dockerfile: Dockerfile
      target: runtime
    environment:
      NODE_ENV: production
      PORT: 3000
      PGHOST: postgres
      PGPORT: 5432
      PGDATABASE: ${POSTGRES_DB}
      PGUSER: ${POSTGRES_USER}
      PGPASSWORD: ${POSTGRES_PASSWORD}
      CORS_ORIGIN: ${CORS_ORIGIN}
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      PGPOOL_MAX: ${PGPOOL_MAX:-5}
      PRISMA_POOL_MAX: ${PRISMA_POOL_MAX:-5}
      JWT_SECRET: ${JWT_SECRET}
      JWT_ISSUER: ${JWT_ISSUER:-gatherly-api}
      JWT_AUDIENCE: ${JWT_AUDIENCE:-gatherly-client}
      JWT_ACCESS_TOKEN_TTL_SECONDS: ${JWT_ACCESS_TOKEN_TTL_SECONDS:-900}
    ports:
      - '127.0.0.1:${APP_PORT}:3000'
    depends_on:
      migration:
        condition: service_completed_successfully
    healthcheck:
      test:
        [
          'CMD',
          'node',
          '-e',
          "fetch('http://127.0.0.1:3000/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
        ]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 5s
    init: true
    stop_grace_period: 15s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    pids_limit: 100
    mem_limit: 512m

volumes:
  postgres_data:
```

Keep `compose.dev.yaml` as this **complete file**:

```yaml
services:
  app:
    build:
      target: development
    environment:
      NODE_ENV: development
      # Used only by the explicit seed command. Server startup does not read it.
      DEVELOPMENT_SEED_PASSWORD: ${DEVELOPMENT_SEED_PASSWORD}
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
      - ./prisma:/app/prisma:ro
      - ./prisma.config.ts:/app/prisma.config.ts:ro
```

Why each runtime restriction exists:

- `no-new-privileges` prevents gaining more privilege through setuid/setgid
  executables;
- `cap_drop: ALL` removes Linux capabilities an ordinary HTTP process does not
  need;
- `read_only` prevents writes to the image filesystem;
- `/tmp` is the one explicit writable scratch area for Node/native libraries;
- `pids_limit` limits process explosion;
- `mem_limit` gives an observable local failure boundary instead of allowing an
  accidental process to consume all Docker Desktop memory;
- `init: true` gives PID 1 correct signal forwarding and child reaping;
- the host port remains bound to loopback, because this is a local exercise.

These values are starting bounds, not universal production numbers. If a test
demonstrates that 512 MB is insufficient, measure peak usage and document the
new value rather than deleting the limit without explanation.

### Verification

Use an isolated Compose project so the volume can be safely deleted afterward:

```powershell
docker compose -p gatherly-phase5 -f compose.yaml config --quiet
docker compose -p gatherly-phase5 -f compose.yaml up --detach --build
docker compose -p gatherly-phase5 -f compose.yaml ps --all
docker compose -p gatherly-phase5 -f compose.yaml logs migration
```

The migration container should show `migrate deploy` succeeded and exit with
code `0`; the application should then become healthy.

Run the migration again to prove it is idempotent:

```powershell
docker compose -p gatherly-phase5 -f compose.yaml run --rm migration
```

Prisma should report that no pending migrations exist.

Prove migration failure is visible rather than hidden by app startup:

```powershell
docker compose -p gatherly-phase5 -f compose.yaml run --rm `
  -e DATABASE_URL=postgresql://invalid:invalid@postgres:5432/missing migration
$LASTEXITCODE
```

The command must return non-zero. This exercise proves the release command
propagates failure; it does not simulate every possible SQL migration failure.
A real failed migration must be reviewed and recovered with
`prisma migrate status` and, only after understanding database state,
`prisma migrate resolve`.

Cleanup is destructive only to the explicitly isolated `gatherly-phase5`
project:

```powershell
docker compose -p gatherly-phase5 -f compose.yaml down --volumes
```

---

## Checkpoint 4: Make shutdown state part of readiness

### Reason

Liveness and readiness answer different questions:

- liveness: “Is the Node process capable of serving HTTP?”
- readiness: “Should new database-backed work be sent here now?”

A PostgreSQL outage should make readiness fail but should not cause a restart
loop by failing liveness. During shutdown, readiness should fail before the
process drains existing requests.

The existing server already calls `server.close()`, which stops new
connections and waits for active requests. Extract only the lifecycle
coordination so it can be tested without importing `src/server.ts` and
accidentally starting the real application.

### Implementation

Create `src/infrastructure/http/graceful-shutdown.ts` with this **complete
file**. This is infrastructure code, not a seventh file inside a domain module.

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

In `src/app.ts`, add this dependency to `AppDependencies`:

```ts
isShuttingDown: () => boolean;
```

Then replace the readiness handler with:

```ts
app.get('/health/ready', async (_request, response) => {
  if (dependencies.isShuttingDown()) {
    response.status(503).json({ status: 'not_ready' });
    return;
  }

  const ready = await dependencies.checkReadiness();
  response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
});
```

In both `tests/helpers/test-app.ts` and `tests/api/health.test.ts`, add this
property to the object passed to `createApp`:

```ts
isShuttingDown: () => false,
```

In `src/server.ts`, add this import:

```ts
import { createGracefulShutdown } from './infrastructure/http/graceful-shutdown.js';
```

Immediately before `checkReadiness`, create the shared state and make readiness
short-circuit during draining:

```ts
const shutdownState = { started: false };

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

Add this property to the `createApp` call in `src/server.ts`:

```ts
isShuttingDown: () => shutdownState.started,
```

Finally, replace everything from `const server = createServer(app);` to the end
of `src/server.ts` with:

```ts
const server = createServer(app);

server.listen(environment.PORT, () => {
  logger.info({ port: environment.PORT }, 'Gatherly HTTP server started');
});

const gracefulShutdown = createGracefulShutdown({
  server,
  state: shutdownState,
  logger,
  timeoutMs: 10_000,
  closeDependencies: async () => {
    await Promise.all([prisma.$disconnect(), pool.end()]);
  },
});

const handleSignal = (signal: NodeJS.Signals): void => {
  void gracefulShutdown
    .shutdown(signal)
    .then(({ forced }) => {
      if (forced) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'Graceful shutdown failed');
      process.exitCode = 1;
    });
};

process.once('SIGINT', handleSignal);
process.once('SIGTERM', handleSignal);
```

The application timeout is 10 seconds and Compose allows 15 seconds. That
five-second margin lets the application force-close, release dependencies, and
exit before the orchestrator sends an unconditional kill.

### Add a readiness-state API test

In `tests/api/health.test.ts`, change its setup so the dependency can observe a
mutable boolean:

```ts
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
```

Add this test to that file:

```ts
it('stops reporting readiness after shutdown begins without failing liveness', async () => {
  shuttingDown = true;

  const ready = await request(app).get('/health/ready');
  const live = await request(app).get('/health/live');

  expect(ready.status).toBe(503);
  expect(ready.body).toEqual({ status: 'not_ready' });
  expect(live.status).toBe(200);
  expect(live.body).toEqual({ status: 'ok' });

  shuttingDown = false;
});
```

### Add a real draining test

Create `tests/integration/graceful-shutdown.test.ts` with this **complete file**:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGracefulShutdown,
  type ShutdownState,
} from '../../src/infrastructure/http/graceful-shutdown.js';

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

describe('graceful HTTP shutdown', () => {
  const servers: Server[] = [];

  afterEach(() => {
    for (const server of servers) server.closeAllConnections();
    servers.length = 0;
  });

  it('stops admission, drains an active request, and closes dependencies once', async () => {
    const requestStarted = createDeferred();
    const releaseRequest = createDeferred();
    const app = express();
    app.get('/slow', async (_request, response) => {
      requestStarted.resolve();
      await releaseRequest.promise;
      response.json({ status: 'finished' });
    });

    const server = createServer(app);
    servers.push(server);
    const port = await listen(server);
    const state: ShutdownState = { started: false };
    const closeDependencies = vi.fn().mockResolvedValue(undefined);
    const shutdown = createGracefulShutdown({
      server,
      state,
      logger: pino({ enabled: false }),
      timeoutMs: 1_000,
      closeDependencies,
    });

    const responsePromise = fetch(`http://127.0.0.1:${String(port)}/slow`, {
      headers: { connection: 'close' },
    });
    await requestStarted.promise;

    const firstShutdown = shutdown.shutdown('SIGTERM');
    const repeatedShutdown = shutdown.shutdown('SIGINT');

    expect(state.started).toBe(true);
    expect(server.listening).toBe(false);
    expect(repeatedShutdown).toBe(firstShutdown);
    expect(closeDependencies).not.toHaveBeenCalled();

    releaseRequest.resolve();
    const response = await responsePromise;
    await expect(response.json()).resolves.toEqual({ status: 'finished' });
    await expect(firstShutdown).resolves.toEqual({ forced: false });
    expect(closeDependencies).toHaveBeenCalledOnce();
  });

  it('force-closes a request that exceeds the deadline', async () => {
    const requestStarted = createDeferred();
    const neverRelease = createDeferred();
    const app = express();
    app.get('/stuck', async (_request, response) => {
      requestStarted.resolve();
      await neverRelease.promise;
      response.end();
    });

    const server = createServer(app);
    servers.push(server);
    const port = await listen(server);
    const closeDependencies = vi.fn().mockResolvedValue(undefined);
    const shutdown = createGracefulShutdown({
      server,
      state: { started: false },
      logger: pino({ enabled: false }),
      timeoutMs: 25,
      closeDependencies,
    });

    const responsePromise = fetch(`http://127.0.0.1:${String(port)}/stuck`).then(
      () => undefined,
      (error: unknown) => error,
    );
    await requestStarted.promise;

    await expect(shutdown.shutdown('SIGTERM')).resolves.toEqual({ forced: true });
    await expect(responsePromise).resolves.toBeInstanceOf(Error);
    expect(closeDependencies).toHaveBeenCalledOnce();
  });
});
```

This test uses a deliberately controllable test route. Do not add a “slow” or
“stuck” endpoint to the production application.

### Verification

```powershell
yarn typecheck
yarn lint
yarn vitest run tests/api/health.test.ts tests/integration/graceful-shutdown.test.ts
yarn build
```

### Expected result

The normal test proves the active request completes before dependency clients
close. The timeout test proves a stuck request cannot keep the process alive
forever. Calling shutdown twice returns the same promise and therefore cannot
start two pool-disconnect races.

---

## Checkpoint 5: Prove transaction rollback with an actual PostgreSQL failure

### Reason

Mocking `insertNotification()` to throw only proves JavaScript propagated an
exception. It does not prove PostgreSQL rolled back prior writes.

Instead, install a trigger in the disposable Testcontainers database that
raises a PostgreSQL exception when promotion notification insertion occurs.
The cancellation transaction has already changed the reservation and waitlist
before that insert. If the transaction boundary is correct, every earlier
change rolls back.

### Implementation

Add this test inside the existing
`describe('ReservationsService with PostgreSQL', ...)` block in
`tests/integration/reservations.integration.test.ts`:

```ts
it('rolls back cancellation and promotion when the final notification write fails', async () => {
  const communityId = await createCommunityFixture(harness.pool);
  await addActiveMember(harness.pool, communityId, bobId);
  const eventId = await createEventFixture(harness.pool, communityId);

  await service.reserve(eventId, aliceId, 'alice-before-rollback');
  await service.reserve(eventId, bobId, 'bob-before-rollback');

  await harness.pool.query(`
    CREATE FUNCTION phase5_fail_promotion_notification()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.type = 'WAITLIST_PROMOTED' THEN
        RAISE EXCEPTION 'phase5 injected notification failure';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER phase5_fail_promotion_notification_trigger
    BEFORE INSERT ON notifications
    FOR EACH ROW
    EXECUTE FUNCTION phase5_fail_promotion_notification();
  `);

  try {
    await expect(service.cancelReservation(eventId, aliceId)).rejects.toThrow(
      'phase5 injected notification failure',
    );

    const state = await harness.pool.query<{
      alice_confirmed: number;
      bob_confirmed: number;
      bob_waiting: number;
      bob_promoted: number;
      promotion_notifications: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM reservations
          WHERE event_id = $1 AND user_id = $2 AND status = 'CONFIRMED') AS alice_confirmed,
         (SELECT count(*)::integer FROM reservations
          WHERE event_id = $1 AND user_id = $3 AND status = 'CONFIRMED') AS bob_confirmed,
         (SELECT count(*)::integer FROM waitlist_entries
          WHERE event_id = $1 AND user_id = $3 AND status = 'WAITING') AS bob_waiting,
         (SELECT count(*)::integer FROM waitlist_entries
          WHERE event_id = $1 AND user_id = $3 AND status = 'PROMOTED') AS bob_promoted,
         (SELECT count(*)::integer FROM notifications
          WHERE user_id = $3 AND type = 'WAITLIST_PROMOTED') AS promotion_notifications`,
      [eventId, aliceId, bobId],
    );

    expect(state.rows[0]).toEqual({
      alice_confirmed: 1,
      bob_confirmed: 0,
      bob_waiting: 1,
      bob_promoted: 0,
      promotion_notifications: 0,
    });
  } finally {
    await harness.pool.query(`
      DROP TRIGGER IF EXISTS phase5_fail_promotion_notification_trigger ON notifications;
      DROP FUNCTION IF EXISTS phase5_fail_promotion_notification();
    `);
  }
});
```

The `finally` block matters. `TRUNCATE` removes rows but does not remove
triggers or functions, so omitting cleanup would poison later tests.

### Verification

```powershell
yarn vitest run tests/integration/reservations.integration.test.ts
```

### Expected result

Alice remains confirmed, Bob remains waiting, and none of the partial
promotion state survives. That is evidence of a database transaction rollback,
not merely an HTTP error.

---

## Checkpoint 6: Extend hostile authentication cases

### Reason

Clients should receive the same safe authentication error whether a token is
forged, expired, issued by the wrong authority, or intended for another
audience. Distinct internal JWT failures must not become an oracle.

The current adapter already checks algorithm, issuer, audience, expiry, and
payload shape. Add tests; do not add another token service.

### Implementation

In `tests/unit/security-adapters.test.ts`, add this import:

```ts
import jwt from 'jsonwebtoken';
```

Then add this test inside `describe('security adapters', ...)`:

```ts
it('maps forged, expired, wrong-issuer, and wrong-audience JWTs to one safe error', () => {
  const secret = 'test-only-jwt-secret-that-is-long-enough';
  const tokens = new JwtAccessTokens({
    secret,
    issuer: 'gatherly-test-api',
    audience: 'gatherly-test-client',
    ttlSeconds: 900,
  });
  const userId = '00000000-0000-4000-8000-000000000001';
  const invalidTokens = [
    `${tokens.sign(userId)}tampered`,
    jwt.sign({}, secret, {
      algorithm: 'HS256',
      subject: userId,
      issuer: 'gatherly-test-api',
      audience: 'gatherly-test-client',
      expiresIn: -1,
    }),
    jwt.sign({}, secret, {
      algorithm: 'HS256',
      subject: userId,
      issuer: 'wrong-issuer',
      audience: 'gatherly-test-client',
      expiresIn: 900,
    }),
    jwt.sign({}, secret, {
      algorithm: 'HS256',
      subject: userId,
      issuer: 'gatherly-test-api',
      audience: 'wrong-audience',
      expiresIn: 900,
    }),
  ];

  for (const token of invalidTokens) {
    expect(() => tokens.verify(token)).toThrow(
      expect.objectContaining({
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication is required',
      }),
    );
  }
});
```

Phase 4 already has the database-backed account-suspension test in
`tests/api/identity.api.test.ts`; keep it. Its significance is that JWT validity
alone is insufficient. The middleware reloads current user state, so a token
issued before suspension stops authorizing requests.

### Verification

```powershell
yarn vitest run tests/unit/security-adapters.test.ts tests/api/identity.api.test.ts
```

### Expected result

Every hostile token produces the same public 401 boundary. No password, hash,
or bearer token appears in an assertion snapshot or log.

---

## Checkpoint 7: Prove target-object authorization

### Reason

Authentication answers “who is calling?” Authorization must answer “may this
caller act on this exact community/event/reservation?” A role in Community A
must not grant power in Community B.

Do not change services to accept the entire authenticated user. Controllers
pass the authenticated user ID; the service/repository load current
authorization for the target community. That prevents stale token claims from
becoming community permission truth.

### Implementation

Add the following test to `tests/api/events.api.test.ts`. It uses the existing
`eventBody` shape, so either move that object into a small local helper or paste
the complete body shown here.

```ts
it('does not carry organizer authority from one community into another', async () => {
  const firstCommunityId = await createCommunityFixture(harness.pool);
  const secondCommunityId = await createCommunityFixture(harness.pool);

  await harness.pool.query(
    `INSERT INTO community_memberships (community_id, user_id, role, status)
     VALUES ($1, $2, 'ORGANIZER', 'ACTIVE')`,
    [firstCommunityId, bobId],
  );

  const eventBody = {
    title: 'Cross-community attempt',
    slug: 'cross-community-attempt',
    startsAt: '2030-08-03T18:00:00.000Z',
    endsAt: '2030-08-03T21:00:00.000Z',
    timezone: 'Europe/Moscow',
    capacity: 10,
  };

  const allowed = await request(app)
    .post(`/api/communities/${firstCommunityId}/events`)
    .set('authorization', authorizationFor(bobId))
    .send(eventBody);
  expect(allowed.status).toBe(201);

  const denied = await request(app)
    .post(`/api/communities/${secondCommunityId}/events`)
    .set('authorization', authorizationFor(bobId))
    .send({ ...eventBody, slug: 'cross-community-denied' });
  expect(denied.status).toBe(403);
  expect((denied.body as { error: { code: string } }).error.code).toBe(
    'COMMUNITY_PERMISSION_DENIED',
  );
});
```

Add this test to `tests/api/reservations.api.test.ts` to prove current
membership status is checked for the target event:

```ts
it('rejects a reservation after membership becomes suspended', async () => {
  const communityId = await createCommunityFixture(harness.pool);
  const eventId = await createEventFixture(harness.pool, communityId);

  await harness.pool.query(
    `UPDATE community_memberships
     SET status = 'SUSPENDED', updated_at = now()
     WHERE community_id = $1 AND user_id = $2`,
    [communityId, aliceId],
  );

  const response = await request(app)
    .post(`/api/events/${eventId}/reservations`)
    .set('authorization', authorizationFor(aliceId))
    .set('Idempotency-Key', 'suspended-membership-attempt')
    .send({});

  expect(response.status).toBe(403);
  expect((response.body as { error: { code: string } }).error.code).toBe(
    'COMMUNITY_PERMISSION_DENIED',
  );

  const state = await harness.pool.query<{ reservations: number; waitlist: number }>(
    `SELECT
       (SELECT count(*)::integer FROM reservations
        WHERE event_id = $1 AND user_id = $2) AS reservations,
       (SELECT count(*)::integer FROM waitlist_entries
        WHERE event_id = $1 AND user_id = $2) AS waitlist`,
    [eventId, aliceId],
  );
  expect(state.rows[0]).toEqual({ reservations: 0, waitlist: 0 });
});
```

If member-management endpoints still do not exist, do not add unused
owner-protection code in this phase. Owner protection must be implemented and
tested in the same complete route/controller/service/repository vertical slice
that exposes member management.

### Verification

```powershell
yarn vitest run tests/api/events.api.test.ts tests/api/reservations.api.test.ts
```

### Expected result

Authority is derived from the requested community, not from “the user is an
organizer somewhere.” The suspended reservation attempt leaves no reservation
or waitlist row.

---

## Checkpoint 8: Drill a PostgreSQL outage

### Reason

When PostgreSQL is unavailable, permanent data remains in PostgreSQL and the
application reports temporary unavailability. It must not invent fallback
state, crash from an unhandled rejection, or claim readiness.

This drill uses the real containers because mocking `pool.query()` cannot prove
container health, network recovery, or process survival.

### Implementation

Create `scripts/phase5-postgres-outage.ps1` with this **complete file**:

```powershell
$ErrorActionPreference = 'Stop'

$project = 'gatherly-phase5-outage'
$compose = @('-p', $project, '-f', 'compose.yaml')
$baseUrl = "http://127.0.0.1:$($env:APP_PORT)"

if ([string]::IsNullOrWhiteSpace($env:APP_PORT)) {
  throw 'APP_PORT must be loaded from .env or set in this shell'
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
  if ($LASTEXITCODE -ne 0) { throw 'Compose startup failed' }

  $started = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Seconds 1
    if ((Get-HttpStatus "$baseUrl/health/ready") -eq 200) {
      $started = $true
      break
    }
  }
  if (-not $started) { throw 'Application did not become ready within 30 seconds' }

  docker compose @compose stop postgres
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop PostgreSQL' }

  $liveDuringOutage = Get-HttpStatus "$baseUrl/health/live"
  $readyDuringOutage = Get-HttpStatus "$baseUrl/health/ready"
  if ($liveDuringOutage -ne 200) {
    throw 'Liveness failed during a dependency outage'
  }
  if ($readyDuringOutage -ne 503) {
    throw "Expected readiness 503, got $readyDuringOutage"
  }

  docker compose @compose start postgres
  if ($LASTEXITCODE -ne 0) { throw 'Could not restart PostgreSQL' }

  $recovered = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Seconds 1
    if ((Get-HttpStatus "$baseUrl/health/ready") -eq 200) {
      $recovered = $true
      break
    }
  }
  if (-not $recovered) { throw 'Readiness did not recover within 30 seconds' }

  docker compose @compose ps
  docker compose @compose logs app
  Write-Host 'PostgreSQL outage drill passed'
}
finally {
  # This removes only the volume belonging to the isolated project name above.
  docker compose @compose down --volumes
}
```

PowerShell does not automatically export values read from `.env` into
`$env:APP_PORT`. Either set it for the shell:

```powershell
$env:APP_PORT = '3000'
```

or replace the script's `$baseUrl` with your known local port.

### Verification

```powershell
powershell -ExecutionPolicy Bypass -File scripts/phase5-postgres-outage.ps1
```

### Expected result

The transition is:

```text
database running  -> live 200, ready 200
database stopped  -> live 200, ready 503
database restarted -> live 200, ready 200
```

Application logs may contain a safe PostgreSQL readiness warning. They must not
contain passwords, `DATABASE_URL`, JWTs, or request authorization headers.

---

## Checkpoint 9: Inspect the hardened container instead of assuming

### Reason

Configuration is not evidence. Start the container and inspect the actual user,
mounts, capabilities, writable paths, and image history.

### Verification

```powershell
docker compose -p gatherly-phase5-inspect -f compose.yaml up --detach --build

docker compose -p gatherly-phase5-inspect -f compose.yaml exec app id
docker compose -p gatherly-phase5-inspect -f compose.yaml exec app sh -lc 'touch /app/should-fail'
docker compose -p gatherly-phase5-inspect -f compose.yaml exec app sh -lc 'touch /tmp/should-work && rm /tmp/should-work'

$containerId = docker compose -p gatherly-phase5-inspect -f compose.yaml ps -q app
docker inspect $containerId --format '{{json .HostConfig.CapDrop}}'
docker inspect $containerId --format '{{json .HostConfig.SecurityOpt}}'
docker inspect $containerId --format '{{.HostConfig.ReadonlyRootfs}}'
docker inspect $containerId --format '{{.HostConfig.PidsLimit}}'
docker inspect $containerId --format '{{.HostConfig.Memory}}'

docker compose -p gatherly-phase5-inspect -f compose.yaml down --volumes
```

### Expected result

- `id` reports the non-root `node` user;
- writing below `/app` fails with a read-only filesystem error;
- writing below `/tmp` succeeds;
- all capabilities are dropped;
- no-new-privileges and read-only root filesystem are enabled;
- PID and memory limits match Compose;
- the application remains healthy under those restrictions.

Do not print the container's entire environment in shared output: it includes
runtime secrets. If you inspect it locally, never paste that output into a bug
report or commit it.

---

## Checkpoint 10: Add a repeatable local release gate

### Reason

A release checklist that exists only in memory is not repeatable. The gate
should compile and test the host code, build the production-style images, run
migrations once, start the app, exercise auth and a protected endpoint, stop
the app gracefully, and clean up only its isolated disposable database.

### Implementation

Create `scripts/phase5-release-gate.ps1` with this **complete file**:

```powershell
$ErrorActionPreference = 'Stop'

$project = 'gatherly-phase5-gate'
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
  yarn install --frozen-lockfile
  Assert-LastExitCode 'Dependency installation failed'
  yarn prisma:generate
  Assert-LastExitCode 'Prisma generation failed'
  yarn prisma:validate
  Assert-LastExitCode 'Prisma validation failed'
  yarn typecheck
  Assert-LastExitCode 'TypeScript check failed'
  yarn lint
  Assert-LastExitCode 'Lint failed'
  yarn test
  Assert-LastExitCode 'Tests failed'
  yarn build
  Assert-LastExitCode 'Build failed'

  docker compose @compose config --quiet
  Assert-LastExitCode 'Compose configuration is invalid'
  docker compose @compose up --detach --build
  Assert-LastExitCode 'Production-style stack failed to start'

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
  $username = "smoke_$suffix"
  $passwordBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
  $password = [Convert]::ToBase64String($passwordBytes)
  $credentials = @{ username = $username; password = $password } | ConvertTo-Json

  $signUp = Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/sign-up" `
    -ContentType 'application/json' -Body $credentials
  if ($signUp.data.tokenType -ne 'Bearer') { throw 'Sign-up did not return a bearer token' }

  $headers = @{ Authorization = "Bearer $($signUp.data.accessToken)" }
  $me = Invoke-RestMethod -Method Get -Uri "$baseUrl/auth/me" -Headers $headers
  if ($me.data.user.username -ne $username) { throw '/auth/me returned the wrong user' }

  $communityBody = @{
    name = "Phase 5 Smoke $suffix"
    slug = "phase-5-smoke-$suffix"
  } | ConvertTo-Json
  $community = Invoke-WebRequest -Method Post -Uri "$baseUrl/api/communities" `
    -Headers $headers -ContentType 'application/json' -Body $communityBody
  if ($community.StatusCode -ne 201) {
    throw "Protected community smoke request returned $($community.StatusCode)"
  }

  docker compose @compose stop app
  Assert-LastExitCode 'Application did not stop cleanly'
  docker compose @compose logs app

  Write-Host 'Phase 5 local release gate passed'
}
finally {
  # Safe because this project name is dedicated to the disposable gate.
  docker compose @compose down --volumes
}
```

The script keeps the access token only in process memory. It does not print it,
write it to disk, or commit it. Its random smoke account lives only in the
isolated database volume deleted by `finally`.

### Verification

Make sure the normal Compose variables are available through `.env`, then run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/phase5-release-gate.ps1
```

### Expected result

The script ends with:

```text
Phase 5 local release gate passed
```

The app logs show startup followed by one graceful shutdown sequence. The
migration logs show migrations ran before app startup. The isolated containers
and volume are removed even if a checkpoint fails.

---

## Final examination

Phase 5 is complete when the code and evidence let you answer all of these
without guessing:

1. Why are development, migration, and runtime separate image stages?
2. Why is Prisma CLI absent from the HTTP runtime image?
3. Which user runs Node, which Linux capabilities remain, and which paths are
   writable?
4. Why does PostgreSQL failure produce liveness 200 but readiness 503?
5. Why does readiness fail as soon as shutdown starts?
6. What prevents a stuck request from blocking shutdown forever?
7. Why is Compose's 15-second grace period longer than the application's
   10-second deadline?
8. Who runs migrations, and what exact condition prevents app startup after a
   failed migration?
9. Why does the trigger-based test prove rollback more strongly than a mocked
   repository method?
10. How does the final-place test prove capacity and non-overlap in durable
    state?
11. Why does a token issued before account suspension stop working?
12. Why does an organizer role in one community not authorize another
    community?
13. Which secrets are runtime-only, and how did you verify they were not baked
    into image layers or logs?
14. Which failure tests were deliberately omitted because Redis, Kafka,
    Elasticsearch, SSE, and WebSockets do not exist yet?

## Phase 5 completion commands

Run the normal repository gate one final time:

```powershell
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

Then run the isolated production-style release gate:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/phase5-release-gate.ps1
```

The deliverable is a hardened local production-style artifact and behavioral
evidence for the existing modular monolith. It is not a real-user deployment
and it is not an excuse to pull later infrastructure into the project.
