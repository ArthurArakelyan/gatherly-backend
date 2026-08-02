# Phase 3 Handbook: Prisma with PostgreSQL

Phase 3 adds Prisma to the completed Phase 2 application. It does not discard
the PostgreSQL lessons already learned.

```text
ordinary repository reads and writes -> Prisma Client
capacity, row locking, partial indexes, specialised SQL -> pg + PostgreSQL
```

Routes, controllers, services, Zod schemas, domain types, HTTP contracts, and
business invariants remain in place. Prisma stays behind repositories: neither
controllers nor domain types import Prisma types.

This handbook targets the installed Prisma ORM 7.x. Its setup differs from
older tutorials: Prisma 7 needs a driver adapter at runtime, uses
`prisma.config.ts` for CLI configuration, and requires an explicit generated
client output directory.

## Phase outcome

```text
existing Phase 2 PostgreSQL database
-> reviewed Prisma schema
-> baselined Prisma Migrate history without replaying existing tables
-> generated client for ordinary CRUD repositories
-> existing pg locking transaction for reservations and waitlists
-> repeatable migrations, seeds, and disposable integration tests
```

You will learn how an ORM maps an existing schema, how to baseline an existing
database, how relations and transactions work, and why PostgreSQL constraints
and locks still matter.

## Scope for this phase

Migrate ordinary persistence first:

```text
communities
memberships
events
notifications and idempotency records where straightforward
```

Keep these operations on `pg` in this phase:

```text
reservation creation
cancellation and waitlist promotion
FOR UPDATE locking
partial indexes
hand-written PostgreSQL migration SQL
```

Do not add authentication, Redis, queues, WebSockets, email, check-ins,
reviews, search, or a new product module.

## Step 1: Prove the Phase 2 baseline

Start with a known-good application. Do not introduce an ORM while raw SQL is
already broken.

```powershell
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose -f compose.yaml -f compose.dev.yaml up --detach --build
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn db:migrate
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn db:seed
yarn format:check
yarn lint
yarn typecheck
yarn test
yarn build
```

Commit the result. Baselining is a one-time transition, and this commit is the
clean comparison point if anything goes wrong.

## Step 2: Document the persistence boundary

Add this near the Phase 3 roadmap in `README.md`:

```markdown
### Prisma persistence boundary

Prisma is used inside repositories for ordinary relational reads, filters,
pagination, CRUD, relations, and uncomplicated transactions. PostgreSQL and
`pg` remain the implementation for reservation capacity locking, cancellation
and waitlist promotion, partial indexes, specialized PostgreSQL features, and
queries whose SQL is clearer than an ORM expression. Controllers and services
depend on module-owned types and repository contracts, never on Prisma types.
```

This is an architectural constraint. Prisma makes ordinary operations clearer;
it does not make `SELECT ... FOR UPDATE` unnecessary or turn a JavaScript
capacity check into a concurrency guarantee.

## Step 3: Install the Prisma 7 PostgreSQL adapter

`prisma` and `@prisma/client` are already locked. Prisma 7 also needs the
PostgreSQL driver adapter at runtime:

```powershell
yarn add @prisma/adapter-pg
```

Replace `.env.example` with:

```dotenv
APP_PORT=3000
POSTGRES_PORT=5432
POSTGRES_DB=gatherly
POSTGRES_USER=gatherly
POSTGRES_PASSWORD=replace-with-a-local-password
CORS_ORIGIN=http://localhost:5173

# Used by Prisma CLI commands run from the host.
DATABASE_URL=postgresql://gatherly:replace-with-a-local-password@127.0.0.1:5432/gatherly

# The pools coexist temporarily: raw reservation SQL plus Prisma CRUD.
# Their combined maximum must fit PostgreSQL's connection budget.
PGPOOL_MAX=5
PRISMA_POOL_MAX=5
```

Replace `src/config/env.ts` with:

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
  PGPOOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  DATABASE_URL: z.url(),
  PRISMA_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  CORS_ORIGIN: z.url().default('http://localhost:5173'),
});

export type Environment = z.infer<typeof environmentSchema>;

export const parseEnvironment = (input: NodeJS.ProcessEnv): Environment =>
  environmentSchema.parse(input);

export const environment: Environment = parseEnvironment(process.env);
```

Add these entries to `services.app.environment` in `compose.yaml`:

```yaml
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      PRISMA_POOL_MAX: ${PRISMA_POOL_MAX:-5}
```

The container must use `postgres`, not the host-only `127.0.0.1` URL. Keep
the existing `PG*` variables: the raw reservation transaction still needs them.
The two pool limits are intentional; do not leave both at ten by accident.

## Step 4: Create Prisma configuration

Create `prisma.config.ts`:

```ts
import 'dotenv/config';

import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
```

Create this layout:

```text
prisma/
  migrations/
  schema.prisma
  seed.ts
src/
  generated/prisma/       generated; never edited by hand
  infrastructure/prisma/
    client.ts
```

`prisma.config.ts` configures the CLI. The application client is configured
separately with its validated environment and driver adapter.

## Step 5: Write a reviewed schema for the existing database

Use introspection as a measurement tool first. It rewrites `schema.prisma`, so
commit before using it:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn prisma db pull --print
```

Compare the output with this reviewed schema. It preserves the existing
snake_case database names while exposing camelCase fields to TypeScript.

Create `prisma/schema.prisma`:

```prisma
generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "esm"
}

datasource db {
  provider = "postgresql"
}

model User {
  id              String                @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  username        String                @unique(map: "users_username_key")
  status          String                @default("ACTIVE")
  createdAt       DateTime              @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime              @default(now()) @map("updated_at") @db.Timestamptz(6)
  communitiesMade Community[]           @relation("CommunityCreator")
  eventsMade      Event[]               @relation("EventCreator")
  memberships     CommunityMembership[]
  reservations    Reservation[]
  waitlistEntries WaitlistEntry[]
  notifications   Notification[]
  idempotencyKeys IdempotencyKey[]

  @@map("users")
}

model Community {
  id              String                @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  name            String
  slug            String                @unique(map: "communities_slug_key")
  description     String                @default("")
  city            String?
  country         String?
  visibility      String                @default("PUBLIC")
  joinPolicy      String                @default("OPEN") @map("join_policy")
  status          String                @default("ACTIVE")
  createdByUserId String                @map("created_by_user_id") @db.Uuid
  createdAt       DateTime              @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime              @default(now()) @map("updated_at") @db.Timestamptz(6)
  creator         User                  @relation("CommunityCreator", fields: [createdByUserId], references: [id])
  memberships     CommunityMembership[]
  events          Event[]

  @@index([status, createdAt(sort: Desc), id(sort: Desc)], map: "communities_status_created_idx")
  @@map("communities")
}

model CommunityMembership {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  communityId String    @map("community_id") @db.Uuid
  userId      String    @map("user_id") @db.Uuid
  role        String    @default("MEMBER")
  status      String    @default("ACTIVE")
  joinedAt    DateTime  @default(now()) @map("joined_at") @db.Timestamptz(6)
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime  @default(now()) @map("updated_at") @db.Timestamptz(6)
  community   Community @relation(fields: [communityId], references: [id])
  user        User      @relation(fields: [userId], references: [id])

  @@unique([communityId, userId], map: "community_memberships_user_community_key")
  @@index([userId, communityId], map: "community_memberships_user_idx")
  @@map("community_memberships")
}

model Event {
  id              String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  communityId     String          @map("community_id") @db.Uuid
  createdByUserId String          @map("created_by_user_id") @db.Uuid
  title           String
  slug            String
  description     String          @default("")
  format          String          @default("IN_PERSON")
  status          String          @default("PUBLISHED")
  visibility      String          @default("PUBLIC")
  startsAt        DateTime        @map("starts_at") @db.Timestamptz(6)
  endsAt          DateTime        @map("ends_at") @db.Timestamptz(6)
  timezone        String
  capacity        Int
  createdAt       DateTime        @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime        @default(now()) @map("updated_at") @db.Timestamptz(6)
  community       Community       @relation(fields: [communityId], references: [id])
  creator         User            @relation("EventCreator", fields: [createdByUserId], references: [id])
  reservations    Reservation[]
  waitlistEntries WaitlistEntry[]

  @@unique([communityId, slug], map: "events_community_slug_key")
  @@index([status, startsAt, id], map: "events_status_starts_idx")
  @@map("events")
}
```

Append the remaining models inside the same `prisma/schema.prisma` code block,
immediately before its closing fence:

```prisma
model Reservation {
  id                 String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  eventId            String    @map("event_id") @db.Uuid
  userId             String    @map("user_id") @db.Uuid
  status             String    @default("CONFIRMED")
  reservedAt         DateTime  @default(now()) @map("reserved_at") @db.Timestamptz(6)
  confirmedAt        DateTime  @default(now()) @map("confirmed_at") @db.Timestamptz(6)
  cancelledAt        DateTime? @map("cancelled_at") @db.Timestamptz(6)
  cancellationReason String?   @map("cancellation_reason")
  createdAt          DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt          DateTime  @default(now()) @map("updated_at") @db.Timestamptz(6)
  event              Event     @relation(fields: [eventId], references: [id])
  user               User      @relation(fields: [userId], references: [id])

  @@index([eventId, status], map: "reservations_event_status_idx")
  @@map("reservations")
}

model WaitlistEntry {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  eventId     String    @map("event_id") @db.Uuid
  userId      String    @map("user_id") @db.Uuid
  status      String    @default("WAITING")
  joinedAt    DateTime  @default(now()) @map("joined_at") @db.Timestamptz(6)
  promotedAt  DateTime? @map("promoted_at") @db.Timestamptz(6)
  cancelledAt DateTime? @map("cancelled_at") @db.Timestamptz(6)
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime  @default(now()) @map("updated_at") @db.Timestamptz(6)
  event       Event     @relation(fields: [eventId], references: [id])
  user        User      @relation(fields: [userId], references: [id])

  @@map("waitlist_entries")
}

model Notification {
  id        String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  type      String
  title     String
  message   String
  data      Json      @default(dbgenerated("'{}'::jsonb")) @db.JsonB
  readAt    DateTime? @map("read_at") @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  user      User      @relation(fields: [userId], references: [id])

  @@map("notifications")
}

model IdempotencyKey {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId         String    @map("user_id") @db.Uuid
  scope          String
  key            String
  requestHash    String    @map("request_hash")
  responseStatus Int?      @map("response_status")
  responseBody   Json?     @map("response_body") @db.JsonB
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  completedAt    DateTime? @map("completed_at") @db.Timestamptz(6)
  user           User      @relation(fields: [userId], references: [id])

  @@unique([userId, scope, key], map: "idempotency_keys_user_scope_key_key")
  @@map("idempotency_keys")
}
```

The second block is a continuation of the first: when typing the actual file,
there is one `generator`, one `datasource`, and all eight models in one file.

The `String` status fields are intentional. The database uses text columns plus
`CHECK` constraints, not PostgreSQL enum types. Inventing Prisma enums would
change the physical model. Keep existing module-owned status unions.

Prisma cannot express the Phase 2 partial unique indexes or `CHECK`
constraints. They remain in the SQL baseline migration and PostgreSQL continues
to enforce them.

Validate without changing the database:

```powershell
yarn prisma validate
yarn prisma format
```

## Step 6: Baseline the existing migration history safely

Do **not** run `prisma migrate dev --name init` against the Phase 2 database.
It already has every table. Create one baseline migration that can create a
fresh database but is marked applied in each existing database.

```powershell
New-Item -ItemType Directory -Force -Path prisma/migrations/0_phase2_baseline
Copy-Item db/migrations/001_initial_schema.sql prisma/migrations/0_phase2_baseline/migration.sql
Add-Content prisma/migrations/0_phase2_baseline/migration.sql "`n"
Get-Content db/migrations/002_idempotency_keys.sql | Add-Content prisma/migrations/0_phase2_baseline/migration.sql
```

Create `prisma/migrations/migration_lock.toml`:

```toml
provider = "postgresql"
```

The copied SQL is the complete historical schema definition, including checks
and partial indexes that Prisma cannot describe. Review it. Do not edit either
historical Phase 2 migration or delete `db/migrations` during this transition.

For an existing Phase 2 development database only, mark the baseline applied
without executing it:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn prisma migrate resolve --applied 0_phase2_baseline
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn prisma migrate status
```

For a fresh disposable database, do not resolve anything. Run:

```powershell
yarn prisma migrate deploy
```

`migrate resolve` records tables that already exist. It is unsafe on an empty
database; `migrate deploy` executes the baseline there.

## Step 7: Generate the client and add stable commands

Add these entries to the existing `scripts` object in `package.json`:

```json
"prisma:generate": "prisma generate",
"prisma:validate": "prisma validate",
"db:pull": "prisma db pull",
"db:migrate:dev": "prisma migrate dev",
"db:migrate:deploy": "prisma migrate deploy",
"db:migrate:status": "prisma migrate status",
"db:seed": "prisma db seed",
"db:migrate": "prisma migrate dev",
"db:migrate:prod": "prisma migrate deploy",
"build": "yarn prisma:generate && tsc -p tsconfig.build.json"
```

The final three replace the existing `db:migrate`, `db:migrate:prod`, and
`build` values; do not leave duplicate JSON keys.

Add this line to `.gitignore`:

```gitignore
src/generated/prisma/
```

Generate before compiling:

```powershell
yarn prisma:generate
yarn typecheck
yarn build
```

Prisma 7 does not automatically regenerate after `migrate dev`. Every schema
change needs an explicit `yarn prisma:generate`.

## Step 8: Make Prisma artifacts available in Docker

Replace `Dockerfile` with:

```dockerfile
FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM dependencies AS development

ENV NODE_ENV=development
COPY tsconfig.json tsconfig.build.json vitest.config.ts prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY tests ./tests
RUN yarn prisma:generate
USER node
CMD ["yarn", "dev"]

FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN yarn build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true && yarn cache clean
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/generated ./dist/generated
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node prisma.config.ts ./prisma.config.ts
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

Add these mounts to `services.app.volumes` in `compose.dev.yaml`:

```yaml
      - ./prisma:/app/prisma:ro
      - ./prisma.config.ts:/app/prisma.config.ts:ro
```

The production image runs generated JavaScript from `dist/generated`. It does
not generate TypeScript at startup. In a later deployment phase, migrations
should run in a deliberate migration job/image because the Prisma CLI is a dev
dependency; do not move it to application startup.

## Step 9: Create one Prisma Client factory

Create `src/infrastructure/prisma/client.ts`:

```ts
import { PrismaPg } from '@prisma/adapter-pg';

import type { Environment } from '../../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';

export const createPrismaClient = (environment: Environment): PrismaClient => {
  const adapter = new PrismaPg({
    connectionString: environment.DATABASE_URL,
    max: environment.PRISMA_POOL_MAX,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  return new PrismaClient({ adapter });
};
```

Prisma 7 requires the adapter. Create one Prisma Client per process, never per
request. The raw `pg.Pool` remains because the adapter does not expose a
checked-out connection for the `FOR UPDATE` reservation transaction.

## Step 10: Migrate communities first

Replace `src/modules/communities/communities.repository.ts` with this complete
Prisma implementation. Public methods and module-owned types do not change.

```ts
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

import { AppError } from '../../shared/errors/app-error.js';
import type { Community, CommunityPage, CreateCommunityInput } from './communities.types.js';

const selection = {
  id: true,
  name: true,
  slug: true,
  description: true,
  city: true,
  country: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CommunitySelect;

type CommunityRecord = Prisma.CommunityGetPayload<{ select: typeof selection }>;

const mapCommunity = (record: CommunityRecord): Community => ({
  id: record.id,
  name: record.name,
  slug: record.slug,
  description: record.description,
  city: record.city,
  country: record.country,
  createdByUserId: record.createdByUserId,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export class CommunitiesRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async createWithOwner(userId: string, input: CreateCommunityInput): Promise<Community> {
    try {
      const record = await this.prisma.$transaction(async (transaction) => {
        const community = await transaction.community.create({
          data: {
            name: input.name,
            slug: input.slug,
            description: input.description,
            city: input.city,
            country: input.country,
            createdByUserId: userId,
          },
          select: selection,
        });
        await transaction.communityMembership.create({
          data: { communityId: community.id, userId, role: 'OWNER', status: 'ACTIVE' },
        });
        return community;
      });
      return mapCommunity(record);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'COMMUNITY_SLUG_TAKEN', 'That community slug is already used');
      }
      throw error;
    }
  }

  public async findById(id: string): Promise<Community | null> {
    const record = await this.prisma.community.findFirst({
      where: { id, status: 'ACTIVE' },
      select: selection,
    });
    return record === null ? null : mapCommunity(record);
  }

  public async list(page: number, limit: number): Promise<CommunityPage> {
    const where = { status: 'ACTIVE', visibility: 'PUBLIC' };
    const [records, total] = await this.prisma.$transaction([
      this.prisma.community.findMany({
        where,
        select: selection,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.community.count({ where }),
    ]);
    return { items: records.map(mapCommunity), page, limit, total };
  }
}
```

The transaction protects the all-or-nothing community and owner-membership
write. PostgreSQL foreign keys and uniqueness still protect stored state.
`P2002` is translated at the repository boundary to the stable API error code.

## Step 11: Wire ordinary repositories to Prisma, retain reservations on pg

At the composition root create both clients once. Apply this replacement pattern
in `src/server.ts` and `tests/helpers/test-app.ts`:

```ts
const rawPool = createPool(environment);
const prisma = createPrismaClient(environment);

rawPool.on('error', (error) => {
  logger.error({ err: error }, 'Idle raw PostgreSQL client failed');
});

const communitiesRepository = new CommunitiesRepository(prisma);
const communitiesService = new CommunitiesService(communitiesRepository);
const communitiesRouter = createCommunitiesRouter(new CommunitiesController(communitiesService));

// Migrate these in separate tested commits.
const membershipsRepository = new MembershipsRepository(rawPool);
const eventsRepository = new EventsRepository(rawPool);

// Reservation allocation must remain the explicit pg locking implementation.
const reservationsRepository = new ReservationsRepository(rawPool);
```

Add this import:

```ts
import { createPrismaClient } from './infrastructure/prisma/client.js';
```

Replace readiness with a check that covers both access paths:

```ts
const checkReadiness = async (): Promise<boolean> => {
  try {
    await Promise.all([rawPool.query('SELECT 1'), prisma.$queryRaw`SELECT 1`]);
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'PostgreSQL readiness check failed');
    return false;
  }
};
```

Replace shutdown resource cleanup with:

```ts
await closeHttpServer();
await Promise.all([prisma.$disconnect(), rawPool.end()]);
logger.info('Graceful shutdown completed');
```

Do not replace the reservation repository with an ORM `count` then `create`.
Phase 2's checked-out `pg` client, event-row lock, partial unique indexes, and
one atomic commit are still the proof that capacity is correct.

## Step 12: Migrate memberships and events one vertical slice at a time

For each ordinary repository:

1. Keep its public method signatures and module-owned types.
2. Define a narrow `Prisma.<Model>Select` constant.
3. Derive a `Prisma.<Model>GetPayload` type from that selection.
4. Map the generated record into the existing domain type.
5. Use `findUnique` only with a true unique key and `findFirst` for filtered
   lookup.
6. Use a Prisma transaction only for a genuinely atomic multi-write operation.
7. Map known Prisma errors to existing `AppError` codes.
8. Retain raw SQL for locking or PostgreSQL-specific operations.

This complete method is suitable for the migrated membership repository:

```ts
public async createActiveMembership(communityId: string, userId: string): Promise<Membership> {
  try {
    const record = await this.prisma.communityMembership.create({
      data: { communityId, userId, role: 'MEMBER', status: 'ACTIVE' },
      select: membershipSelection,
    });
    return mapMembership(record);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(409, 'MEMBERSHIP_ALREADY_EXISTS', 'You already belong to this community');
    }
    throw error;
  }
}
```

For event listing, select only data used by the endpoint instead of an
unbounded relation `include`:

```ts
const records = await this.prisma.event.findMany({
  where: { status: 'PUBLISHED', startsAt: { gte: now } },
  orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  take: limit,
  select: {
    id: true,
    title: true,
    slug: true,
    startsAt: true,
    endsAt: true,
    timezone: true,
    capacity: true,
    community: { select: { id: true, name: true, slug: true } },
  },
});
```

Commit every repository conversion separately and rerun its unit, API, and
integration tests. An ORM transition should not hide an unrelated regression.

## Step 13: Use Prisma transactions correctly

Prisma has two transaction forms:

```ts
// Independent operations.
const [community, total] = await prisma.$transaction([
  prisma.community.findUniqueOrThrow({ where: { id: communityId } }),
  prisma.event.count({ where: { communityId, status: 'PUBLISHED' } }),
]);

// Dependent writes: later work needs the generated community id.
const community = await prisma.$transaction(async (transaction) => {
  const created = await transaction.community.create({ data: communityData });
  await transaction.communityMembership.create({
    data: { communityId: created.id, userId, role: 'OWNER', status: 'ACTIVE' },
  });
  return created;
});
```

Do not make HTTP calls, perform slow computation, or wait for user input inside
an interactive transaction. A transaction holds scarce connections and locks.

This remains unsafe for reservation capacity even inside Prisma:

```ts
const confirmed = await transaction.reservation.count({
  where: { eventId, status: 'CONFIRMED' },
});
if (confirmed < event.capacity) {
  await transaction.reservation.create({ data: { eventId, userId } });
}
```

Two requests can observe the same count. Keep the Phase 2 `FOR UPDATE` event
lock and the partial unique indexes for this invariant.

## Step 14: Keep raw SQL safe and explicit

When raw SQL belongs beside Prisma, use parameterized tagged templates:

```ts
const result = await prisma.$queryRaw<{ id: string; title: string }[]>`
  SELECT id, title
  FROM events
  WHERE community_id = ${communityId}::uuid
    AND status = ${'PUBLISHED'}
  ORDER BY starts_at ASC, id ASC
`;
```

Never concatenate client values into SQL or use unsafe raw-query APIs to avoid
modelling a normal query. For reservations, retain the already-tested `pg`
transaction instead of moving it to Prisma raw SQL.

## Step 15: Move the deterministic seed to Prisma

Create `prisma/seed.ts`:

```ts
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 1 });
const prisma = new PrismaClient({ adapter });

const users = [
  { id: '00000000-0000-4000-8000-000000000001', username: 'alice' },
  { id: '00000000-0000-4000-8000-000000000002', username: 'bob' },
  { id: '00000000-0000-4000-8000-000000000003', username: 'carol' },
] as const;

const seed = async (): Promise<void> => {
  for (const user of users) {
    await prisma.user.upsert({
      where: { username: user.username },
      update: { status: 'ACTIVE' },
      create: { ...user, status: 'ACTIVE' },
    });
  }
};

seed()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
```

Run `yarn db:seed` explicitly. Prisma 7 does not seed automatically after a
migration. Keep the old SQL seed until repeated runs prove the new seed is
equivalent, then remove it in its own focused cleanup commit.

## Step 16: Make integration tests use Prisma migrations

Fresh Testcontainers databases do not need `migrate resolve`; they need the
baseline migration executed. Create `tests/helpers/prisma-migrate.ts`:

```ts
import { execa } from 'execa';

export const deployPrismaMigrations = async (databaseUrl: string): Promise<void> => {
  await execa('yarn', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
};
```

Install its one development dependency:

```powershell
yarn add -D execa
```

In `tests/helpers/postgres.ts`, replace this import:

```ts
import { runMigrations } from '../../src/infrastructure/postgres/migration-runner.js';
```

with:

```ts
import { deployPrismaMigrations } from './prisma-migrate.js';
```

Then replace this line:

```ts
await runMigrations(pool, migrationsDirectory);
```

with:

```ts
await deployPrismaMigrations(container.getConnectionUri());
```

Expose the connection string rather than reaching into `pg.Pool` internals.
Make these exact changes in `tests/helpers/postgres.ts`:

```ts
export interface PostgresHarness {
  connectionString: string;
  pool: Pool;
  reset: () => Promise<void>;
  seed: () => Promise<void>;
  stop: () => Promise<void>;
}
```

Replace the pool construction with:

```ts
const connectionString = container.getConnectionUri();
const pool = new pg.Pool({ connectionString, max: 10 });

await deployPrismaMigrations(connectionString);
```

Add the value to the returned harness object:

```ts
return {
  connectionString,
  pool,
  // Keep the existing reset, seed, and stop implementations here.
};
```

Remove the now-unused `migrationsDirectory` constant and migration-runner
import from that file.

The harness may keep its `pg.Pool` for fixtures and locking tests. A test that
proves a Prisma repository creates a separate Prisma client and disconnects it
in `afterAll`.

Create `tests/integration/communities.prisma.repository.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseEnvironment } from '../../src/config/env.js';
import { createPrismaClient } from '../../src/infrastructure/prisma/client.js';
import { CommunitiesRepository } from '../../src/modules/communities/communities.repository.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type { PostgresHarness } from '../helpers/postgres.js';
import { startPostgresHarness } from '../helpers/postgres.js';

describe('CommunitiesRepository with Prisma', () => {
  let harness: PostgresHarness;
  let prisma: PrismaClient;
  let repository: CommunitiesRepository;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    prisma = createPrismaClient(
      parseEnvironment({
        NODE_ENV: 'test',
        PGHOST: 'unused',
        PGDATABASE: 'unused',
        PGUSER: 'unused',
        PGPASSWORD: 'unused',
        DATABASE_URL: harness.connectionString,
        CORS_ORIGIN: 'http://localhost:5173',
      }),
    );
    repository = new CommunitiesRepository(prisma);
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await harness.stop();
  });

  it('creates the community and active owner atomically', async () => {
    const community = await repository.createWithOwner('00000000-0000-4000-8000-000000000001', {
      name: 'Prisma Chess',
      slug: 'prisma-chess',
      description: 'Repository integration test',
      city: 'Moscow',
      country: 'RU',
    });

    const membership = await harness.pool.query<{ role: string; status: string }>(
      'SELECT role, status FROM community_memberships WHERE community_id = $1',
      [community.id],
    );
    expect(membership.rows).toEqual([{ role: 'OWNER', status: 'ACTIVE' }]);
  });

  it('keeps the existing stable unique-conflict error', async () => {
    const input = { name: 'First', slug: 'taken-slug', description: '', city: null, country: null };
    await repository.createWithOwner('00000000-0000-4000-8000-000000000001', input);

    await expect(
      repository.createWithOwner('00000000-0000-4000-8000-000000000002', {
        ...input,
        name: 'Second',
      }),
    ).rejects.toMatchObject({ code: 'COMMUNITY_SLUG_TAKEN' });
  });
});
```

The test uses raw PostgreSQL to inspect the stored owner membership after the
Prisma write. That proves an implementation change without weakening the
authoritative database assertion.

## Step 17: Create future schema changes through reviewed migrations

After the baseline is committed, the normal workflow is:

```powershell
# 1. Change prisma/schema.prisma deliberately.
# 2. Generate, review, and apply a local development migration.
yarn db:migrate:dev --name add-community-logo-url
yarn prisma:generate

# 3. Review prisma/migrations/<timestamp>_add_community_logo_url/migration.sql.
# 4. Test and commit schema + migration + code together.
yarn typecheck
yarn test
```

Use `migrate dev` only on a disposable local development database. It uses a
shadow database to detect drift. Use `migrate deploy` outside development; it
only applies committed migration files and never creates a new migration.

For a change Prisma cannot represent, create an empty migration and write the
PostgreSQL SQL yourself:

```powershell
yarn prisma migrate dev --create-only --name add-reservation-partial-index
```

Review the SQL and its lock/rollback impact before applying it. Never use
`db push` for this project: it does not create reviewable migration history.

## Step 18: Failure drills

Perform each drill against Testcontainers or the local development volume, then
restore the intended state.

### Stale client

Change a schema field, do not generate, and run `yarn typecheck`. Observe the
generated API mismatch. Run `yarn prisma:generate` before making the matching
repository change.

### Unbaselined database

Against a copy of the Phase 2 database, run `migrate deploy` before `resolve`.
It should fail trying to create existing objects. On the copy, use
`migrate resolve --applied 0_phase2_baseline`. Never resolve a baseline on an
empty database.

### Drift

Manually add a harmless probe column to a disposable database, then run
`yarn db:migrate:dev`. Prisma should report drift rather than silently guess
history. Remove the probe through a deliberate migration or reset disposable
state.

### Reservation race

Run the critical Phase 2 proof before and after every repository conversion:

```powershell
yarn vitest run tests/integration/reservations.integration.test.ts tests/e2e/reservation-lifecycle.e2e.test.ts
```

It must remain a raw-PostgreSQL proof: one confirmed reservation, one
waitlisted user, then exactly one promotion.

## Step 19: Phase completion examination

You are ready for Phase 4 only when you can explain:

1. Why Prisma is behind repositories rather than in controllers.
2. Why generated records are not domain types or DTOs.
3. How `@map` and `@@map` preserve the existing database names.
4. Why the Phase 2 database needs a baseline, not `migrate dev --name init`.
5. The difference between `migrate dev`, `migrate deploy`, `migrate resolve`,
   `db pull`, `db push`, and `generate`.
6. Why Prisma 7 needs config, a generated-client output, and a driver adapter.
7. Why a Prisma transaction does not by itself prove reservation capacity.
8. Which constraints/indexes Prisma cannot model and where they remain.
9. Why raw `pg` remains for capacity and waitlist locking.
10. How both clients participate in readiness and graceful shutdown.

Final proof:

```text
An existing Phase 2 database is baselined without changing data.
A new test database is built only from Prisma migrations.
An ordinary community write uses Prisma and atomically creates an owner membership.
The final-place reservation race still uses PostgreSQL locking and remains correct.
```

## Suggested commit sequence

```text
1. docs: define Prisma persistence boundary
2. chore: add Prisma 7 adapter and environment configuration
3. feat: add reviewed Prisma schema and generated client
4. chore: baseline existing schema in Prisma Migrate
5. feat: add Prisma lifecycle and migrate communities repository
6. feat: migrate memberships and events one slice at a time
7. test: use Prisma migrations in Testcontainers and test repository behavior
8. docs: update setup, migration, and Phase 3 instructions
```

## Common mistakes

```text
Running migrate dev against an existing unbaselined database
Using db push instead of reviewed migrations
Deleting constraints because Prisma cannot express them
Putting Prisma calls in controllers or services
Creating a Prisma Client per request
Leaving raw pg and Prisma pools both at their old maximum
Treating P2002 as an API response
Using count then create for capacity allocation
Using unsafe raw SQL with client-supplied strings
Forgetting prisma generate after schema changes
Resolving a baseline against an empty database
Editing applied migration files
Running migrate dev against production data
```

## Official references

- [Prisma Client setup and PostgreSQL adapter](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/introduction)
- [Prisma 7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7)
- [Prisma config reference](https://www.prisma.io/docs/orm/reference/prisma-config-reference)
- [Introspecting an existing database](https://www.prisma.io/docs/cli/db/pull)
- [Baselining an existing database](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining)
- [Prisma Migrate commands](https://www.prisma.io/docs/cli/migrate)
- [Prisma raw-query safety](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries)
