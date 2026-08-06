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

Initialize `prisma/schema.prisma` with the datasource provider required by
introspection:

```prisma
datasource db {
  provider = "postgresql"
}
```

Prisma 7 reads the connection URL from `prisma.config.ts`, but `db pull` still
requires a datasource declaration in the schema. The reviewed schema in Step 6
will replace this minimal starting point.

`prisma.config.ts` configures the CLI. The application client is configured
separately with its validated environment and driver adapter.

## Step 5: Prepare the development container for introspection

Do this before invoking any Prisma CLI command inside `app`. Otherwise the
container cannot read `prisma.config.ts`, including its `DATABASE_URL`
configuration. The CLI will then fail with a missing datasource URL even if
`DATABASE_URL` is correctly set in Compose.

Replace `Dockerfile` with:

```dockerfile
FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json yarn.lock ./
# Prisma's engine needs OpenSSL in the slim image.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN yarn install --frozen-lockfile

FROM dependencies AS development

ENV NODE_ENV=development
COPY tsconfig.json tsconfig.build.json vitest.config.ts prisma.config.ts ./
COPY prisma ./prisma
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

Add these mounts to `services.app.volumes` in `compose.dev.yaml`:

```yaml
- ./prisma:/app/prisma:ro
- ./prisma.config.ts:/app/prisma.config.ts:ro
```

Rebuild and recreate the development application before continuing:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up --detach --build app
```

Only the dependencies and development stages change here. Do not generate the
client or change the build/runtime stages yet: the reviewed schema and the
`prisma:generate` package script do not exist until Steps 6 and 8. For now the
development container only needs the Prisma CLI, configuration, schema path,
and OpenSSL so that introspection can run.

## Step 6: Write a reviewed schema for the existing database

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
  creator         User                  @relation("CommunityCreator", fields: [createdByUserId], references: [id], onDelete: NoAction, onUpdate: NoAction)
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
  community   Community @relation(fields: [communityId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  user        User      @relation(fields: [userId], references: [id], onDelete: NoAction, onUpdate: NoAction)

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
  community       Community       @relation(fields: [communityId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  creator         User            @relation("EventCreator", fields: [createdByUserId], references: [id], onDelete: NoAction, onUpdate: NoAction)
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
  event              Event     @relation(fields: [eventId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  user               User      @relation(fields: [userId], references: [id], onDelete: NoAction, onUpdate: NoAction)

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
  event       Event     @relation(fields: [eventId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  user        User      @relation(fields: [userId], references: [id], onDelete: NoAction, onUpdate: NoAction)

  @@map("waitlist_entries")
}

model Notification {
  id        String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  type      String
  title     String
  message   String
  data      Json      @default("{}") @db.JsonB
  readAt    DateTime? @map("read_at") @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  user      User      @relation(fields: [userId], references: [id], onDelete: NoAction, onUpdate: NoAction)

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
  user           User      @relation(fields: [userId], references: [id], onDelete: NoAction, onUpdate: NoAction)

  @@unique([userId, scope, key], map: "idempotency_keys_user_scope_key_key")
  @@map("idempotency_keys")
}
```

The second block is a continuation of the first: when typing the actual file,
there is one `generator`, one `datasource`, and all eight models in one file.

The `String` status fields are intentional. The database uses text columns plus
`CHECK` constraints, not PostgreSQL enum types. Inventing Prisma enums would
change the physical model. Keep existing module-owned status unions.

The explicit `onDelete: NoAction, onUpdate: NoAction` relation actions preserve
the foreign keys created by the Phase 2 SQL. Omitting them makes Prisma use its
own referential-action defaults and causes the first later migration to
needlessly drop and recreate every foreign key. The JSON `{}` default likewise
uses Prisma's native JSON-default syntax so it matches the existing PostgreSQL
default without generating an unrelated alteration.

Prisma cannot express the Phase 2 partial unique indexes or `CHECK`
constraints. They remain in the SQL baseline migration and PostgreSQL continues
to enforce them.

Validate without changing the database:

```powershell
yarn prisma validate
yarn prisma format
```

## Step 7: Baseline the existing migration history safely

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

### Retire the Phase 2 migration-runner history table

The old Phase 2 migration runner created a `schema_migrations` bookkeeping
table. It is not part of the product schema or the Prisma baseline. Leaving it
in place makes Prisma report drift as an added table and prevents
`prisma migrate dev --create-only` from generating future migrations.

On an existing **local development** database, first confirm that Prisma has
recorded the baseline, then remove only the obsolete history table:

```powershell
# This must return 0_phase2_baseline before the DROP command is run.
docker compose exec postgres psql -U gatherly -d gatherly -c "SELECT migration_name FROM \"_prisma_migrations\" WHERE migration_name = '0_phase2_baseline' AND finished_at IS NOT NULL;"

# The table holds only the old runner's migration names, not application data.
docker compose exec postgres psql -U gatherly -d gatherly -c "DROP TABLE schema_migrations;"

# This should now succeed without reporting schema_migrations as drift.
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn prisma migrate status
```

Do not drop `schema_migrations` if the baseline query returned no row, on an
empty database, or anywhere still operated by the old `db:migrate` runner. In
those cases, resolve or deploy the Prisma baseline first. Do not use
`prisma migrate reset` merely to remove this obsolete history table: it drops
all development data.

For a fresh disposable database, do not resolve anything. Run:

```powershell
yarn prisma migrate deploy
```

`migrate resolve` records tables that already exist. It is unsafe on an empty
database; `migrate deploy` executes the baseline there.

## Step 8: Generate the client and add stable commands

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

Now add client generation to the development stage in `Dockerfile`, after the
source and Prisma files have been copied and before switching to the `node`
user:

```dockerfile
COPY prisma ./prisma
COPY src ./src
COPY tests ./tests
RUN DATABASE_URL=postgresql://unused:unused@localhost:5432/unused yarn prisma:generate
USER node
```

Compose's `services.app.environment` values exist only when a container starts;
they are not available to Dockerfile `RUN` instructions while the image is
being built. Prisma loads `prisma.config.ts` during `prisma generate`, so
`env('DATABASE_URL')` still requires a syntactically valid URL even though
client generation does not connect to PostgreSQL. Use the deliberately fake
build-only URL above. Never pass the real database password through Docker
`ARG` or `ENV`: build metadata, logs, cache, or intermediate layers may retain
it.

Update the build and runtime stages now as well. In the build stage, replace:

```dockerfile
RUN yarn build
```

with:

```dockerfile
RUN DATABASE_URL=postgresql://unused:unused@localhost:5432/unused yarn build
```

The complete updated build and runtime stages are:

```dockerfile
FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN DATABASE_URL=postgresql://unused:unused@localhost:5432/unused yarn build

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

`yarn build` also needs the fake URL because the package script starts with
`yarn prisma:generate`. The running application still receives the real
container-only URL from `services.app.environment` in `compose.yaml`.

Rebuild the development image now that the reviewed schema and stable command
both exist:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up --detach --build app
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

This step replaces two complete repositories. Do memberships first, prove it,
then do events. Do not convert both files before checking the first one.

### Step 12A: Replace the membership repository

Membership joining is not a single uncomplicated insert. The result depends on
the community's current state and any existing membership, and a concurrent
join must not create two rows. Use a serializable transaction and retry the
serialization/unique-conflict race. PostgreSQL's unique constraint remains the
final guard.

Replace `src/modules/memberships/memberships.repository.ts` completely:

```ts
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

import type { JoinPersistenceOutcome, LeavePersistenceOutcome } from './memberships.types.js';

const membershipSelection = {
  id: true,
  role: true,
  status: true,
} satisfies Prisma.CommunityMembershipSelect;

const isRetryableConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  (error.code === 'P2034' || error.code === 'P2002');

export class MembershipsRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async joinOpenCommunity(
    communityId: string,
    userId: string,
  ): Promise<JoinPersistenceOutcome> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const community = await transaction.community.findFirst({
              where: { id: communityId, status: 'ACTIVE' },
              select: { joinPolicy: true },
            });

            if (community === null) return 'COMMUNITY_NOT_FOUND';
            if (community.joinPolicy !== 'OPEN') return 'JOIN_NOT_AVAILABLE';

            const membership = await transaction.communityMembership.findUnique({
              where: { communityId_userId: { communityId, userId } },
              select: membershipSelection,
            });

            if (membership?.status === 'BANNED' || membership?.status === 'SUSPENDED') {
              return 'BLOCKED';
            }
            if (membership?.status === 'ACTIVE') return 'ALREADY_ACTIVE';

            if (membership === null) {
              await transaction.communityMembership.create({
                data: { communityId, userId, role: 'MEMBER', status: 'ACTIVE' },
                select: { id: true },
              });
              return 'CREATED';
            }

            await transaction.communityMembership.update({
              where: { id: membership.id },
              data: { role: 'MEMBER', status: 'ACTIVE', joinedAt: new Date() },
              select: { id: true },
            });
            return 'REACTIVATED';
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (attempt < 3 && isRetryableConflict(error)) continue;
        throw error;
      }
    }

    throw new Error('Membership join retry loop ended unexpectedly');
  }

  public leaveCommunity(communityId: string, userId: string): Promise<LeavePersistenceOutcome> {
    return this.leaveWithRetry(communityId, userId);
  }

  private async leaveWithRetry(
    communityId: string,
    userId: string,
  ): Promise<LeavePersistenceOutcome> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const membership = await transaction.communityMembership.findUnique({
              where: { communityId_userId: { communityId, userId } },
              select: membershipSelection,
            });

            if (membership?.status !== 'ACTIVE') return 'NOT_ACTIVE';
            if (membership.role === 'OWNER') return 'OWNER';

            await transaction.communityMembership.update({
              where: { id: membership.id },
              data: { status: 'LEFT' },
              select: { id: true },
            });
            return 'LEFT';
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (attempt < 3 && isRetryableConflict(error)) continue;
        throw error;
      }
    }

    throw new Error('Membership leave retry loop ended unexpectedly');
  }
}
```

Why this is more than `createActiveMembership`: the existing public method
contract returns six meaningful outcomes, supports rejoining after `LEFT`, and
must not reactivate a banned or suspended user. Replacing it with a plain
`create` would silently delete those behaviors.

In both `src/server.ts` and `tests/helpers/test-app.ts`, change only the
membership construction from:

```ts
new MembershipsRepository(rawPool);
```

to:

```ts
new MembershipsRepository(prisma);
```

The local variable may still be named `pool` in the test helper before Step 16;
the important point is that this repository receives the one test Prisma
client, not a new client per request or test case.

Run the membership-focused checks before continuing:

```powershell
yarn typecheck
yarn test tests/unit/memberships.service.test.ts tests/api/memberships.api.test.ts
yarn test tests/integration/memberships.repository.test.ts
```

Update the integration-test setup to construct and disconnect a Prisma client
as shown in Step 16. Keep using the raw pool for fixtures and direct assertions.
Add a concurrent-join assertion: two joins for the same user/community must
produce one `CREATED`, one `ALREADY_ACTIVE`, and exactly one stored membership.

### Step 12B: Replace the event repository

Replace `src/modules/events/events.repository.ts` completely:

```ts
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

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

const eventSelection = {
  id: true,
  communityId: true,
  createdByUserId: true,
  title: true,
  slug: true,
  description: true,
  format: true,
  status: true,
  visibility: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  capacity: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EventSelect;

type EventRecord = Prisma.EventGetPayload<{ select: typeof eventSelection }>;

const mapEvent = (record: EventRecord): Event => ({
  ...record,
  format: record.format as EventFormat,
  visibility: record.visibility as EventVisibility,
});

export class EventsRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findCreationAuthorization(
    communityId: string,
    userId: string,
  ): Promise<EventCreationAuthorization | null> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: {
        status: true,
        memberships: {
          where: { userId },
          select: { status: true, role: true },
          take: 1,
        },
      },
    });

    if (community === null) return null;
    const membership = community.memberships[0];
    return {
      communityStatus: community.status,
      membershipStatus: membership?.status ?? null,
      role: membership?.role ?? null,
    };
  }

  public async create(
    communityId: string,
    userId: string,
    input: CreateEventInput,
  ): Promise<Event> {
    try {
      const record = await this.prisma.event.create({
        data: {
          communityId,
          createdByUserId: userId,
          title: input.title,
          slug: input.slug,
          description: input.description,
          format: input.format,
          visibility: input.visibility,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          timezone: input.timezone,
          capacity: input.capacity,
        },
        select: eventSelection,
      });
      return mapEvent(record);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'EVENT_SLUG_TAKEN', 'That event slug is already used here');
      }
      throw error;
    }
  }

  public async findPublicById(eventId: string): Promise<Event | null> {
    const record = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        visibility: 'PUBLIC',
        status: { in: ['PUBLISHED', 'CANCELLED', 'COMPLETED'] },
        community: { status: 'ACTIVE' },
      },
      select: eventSelection,
    });
    return record === null ? null : mapEvent(record);
  }

  public async listPublic(filters: EventFilters): Promise<EventPage> {
    const where: Prisma.EventWhereInput = {
      visibility: 'PUBLIC',
      status:
        filters.status === null ? { in: ['PUBLISHED', 'CANCELLED', 'COMPLETED'] } : filters.status,
      community: { status: 'ACTIVE' },
      ...(filters.communityId === null ? {} : { communityId: filters.communityId }),
      ...(filters.startsAfter === null ? {} : { startsAt: { gte: filters.startsAfter } }),
      ...(filters.startsBefore === null
        ? {}
        : {
            startsAt: {
              ...(filters.startsAfter === null ? {} : { gte: filters.startsAfter }),
              lt: filters.startsBefore,
            },
          }),
    };

    const [records, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        select: eventSelection,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      this.prisma.event.count({ where }),
    ]);

    return {
      items: records.map(mapEvent),
      page: filters.page,
      limit: filters.limit,
      total,
    };
  }
}
```

The casts in `mapEvent` bridge database strings to the narrower module-owned
types. They are acceptable here because the Phase 2 PostgreSQL check
constraints validate `format` and `visibility`. Do not leak the generated
Prisma payload type into the controller or service.

In `src/server.ts` and `tests/helpers/test-app.ts`, change:

```ts
new EventsRepository(rawPool);
```

to:

```ts
new EventsRepository(prisma);
```

Then run:

```powershell
yarn typecheck
yarn test tests/unit/events.schemas.test.ts tests/unit/events.service.test.ts
yarn test tests/api/events.api.test.ts tests/integration/events.repository.test.ts
yarn lint
yarn build
```

The existing integration test must still prove create plus filtered listing.
Also retain API coverage for an inactive community, unauthorized membership,
duplicate community-local slug, all date filters, pagination, and stable error
codes. Commit the membership and event conversions separately.

## Step 13: Use Prisma transactions correctly

The completed repositories now use both Prisma transaction forms. Choose the
form from the dependency between operations, not from the number of queries.

### Independent operations: array transaction

Use the array form when no operation needs a value produced by another. The
event page and its count use the same transaction snapshot but neither query
depends on the other:

```ts
const [records, total] = await this.prisma.$transaction([
  this.prisma.event.findMany({ where, select: eventSelection }),
  this.prisma.event.count({ where }),
]);
```

`Promise.all` would run both queries but would not promise one database
transaction. Use it for unrelated health checks, not when the returned page and
count should describe one transactional view.

### Dependent operations: interactive transaction

Use the callback form when a later write needs an earlier result or the use
case must make one decision atomically. Community creation needs the generated
community ID before it can create the owner membership:

```ts
const community = await prisma.$transaction(async (transaction) => {
  const created = await transaction.community.create({ data: communityData });
  await transaction.communityMembership.create({
    data: { communityId: created.id, userId, role: 'OWNER', status: 'ACTIVE' },
  });
  return created;
});
```

Always use the callback's `transaction` client inside the callback. Calling
`this.prisma.communityMembership.create(...)` there would run outside the
transaction and could leave a community without its owner if the second write
failed.

The membership join in Step 12 additionally requests `Serializable` isolation.
At that level PostgreSQL can reject one of two valid-looking concurrent
transactions. `P2034` is therefore an expected retry signal, not an error to
translate into a client-facing conflict. The retry is bounded at three
attempts; never retry forever.

### Keep transactions short

Inside an interactive transaction, perform only the database reads, decisions,
and writes required for that use case. Do not make HTTP calls, log large
payloads, perform slow computation, or wait for user input. A transaction holds
a scarce connection and may hold locks until it finishes.

### Know what a Prisma transaction does not fix

This remains unsafe for reservation capacity even when wrapped in Prisma:

```ts
const confirmed = await transaction.reservation.count({
  where: { eventId, status: 'CONFIRMED' },
});
if (confirmed < event.capacity) {
  await transaction.reservation.create({ data: { eventId, userId } });
}
```

At ordinary isolation, two requests can observe the same count and both insert.
The Phase 2 reservation transaction instead checks out one `pg` client, locks
the event row with `FOR UPDATE`, checks capacity, mutates the reservation or
waitlist, writes the notification/idempotency result, and commits once. Keep
that complete use case on `pg`.

### Prove transaction behavior

Do not finish this step with only a happy-path test. The repository integration
suite must prove:

1. A duplicate community slug rolls back the attempted owner membership.
2. Two simultaneous joins create exactly one membership row.
3. A `LEFT` membership becomes `ACTIVE` again.
4. `BANNED` and `SUSPENDED` memberships are never reactivated.
5. An owner cannot leave through the normal member endpoint.

Run the complete database-backed suite after Step 16 wires Prisma migrations
and clients into the Testcontainers harness:

```powershell
yarn test tests/integration
yarn test tests/e2e
```

## Step 14: Keep raw SQL safe and explicit

Phase 3 intentionally has two database access paths. At the end of this step,
the ownership is explicit:

| Operation                                     | Access path  | Reason                                           |
| --------------------------------------------- | ------------ | ------------------------------------------------ |
| Community CRUD and owner creation             | Prisma       | Ordinary relational persistence                  |
| Membership join/leave                         | Prisma       | Serializable state transition with bounded retry |
| Event authorization, create, detail, list     | Prisma       | Ordinary reads, filters, and CRUD                |
| Reservation allocation                        | `pg`         | Checked-out client plus event-row lock           |
| Cancellation and waitlist promotion           | `pg`         | Ordered locked promotion in one transaction      |
| Idempotency claim/completion for reservations | `pg`         | Same atomic reservation transaction              |
| PostgreSQL migrations and partial indexes     | reviewed SQL | Database-specific durable invariants             |

Do not delete `src/infrastructure/postgres/pool.ts`,
`src/shared/database/transaction.ts`, or
`src/modules/reservations/reservations.repository.ts`. The server and test
harness must continue to create both `rawPool` and `prisma`, and shutdown must
close both exactly once.

### Parameterize every value

When a small PostgreSQL-specific query belongs beside Prisma, prefer Prisma's
tagged template. Interpolated values become parameters:

```ts
const result = await prisma.$queryRaw<{ id: string; title: string }[]>`
  SELECT id, title
  FROM events
  WHERE community_id = ${communityId}::uuid
    AND status = ${'PUBLISHED'}
  ORDER BY starts_at ASC, id ASC
`;
```

For dynamic SQL fragments, compose trusted fragments with `Prisma.sql`; never
turn a client value into SQL syntax:

```ts
const statusFilter =
  statuses.length === 0 ? Prisma.empty : Prisma.sql`AND status IN (${Prisma.join(statuses)})`;

interface EventTitleRow {
  id: string;
  title: string;
}

const events = await prisma.$queryRaw<EventTitleRow[]>(Prisma.sql`
  SELECT id, title
  FROM events
  WHERE community_id = ${communityId}::uuid
  ${statusFilter}
  ORDER BY starts_at ASC, id ASC
`);
```

Column names, sort directions, and SQL keywords cannot be supplied as value
parameters. If a client chooses one, map it through a fixed allowlist first.
Never concatenate it into the query.

Avoid `$queryRawUnsafe` and `$executeRawUnsafe`. Also do not move the reservation
repository to Prisma raw SQL merely to claim that everything uses Prisma. Its
`withTransaction(pool, callback)` helper guarantees every locking read and
write uses the same checked-out `pg` client; a collection of unrelated
`prisma.$queryRaw` calls would not preserve that guarantee.

### Audit the boundary

Review every remaining raw query before continuing:

```powershell
rg -n "\.query\(|\$queryRaw|\$executeRaw|RawUnsafe" src
```

For each match, confirm all of the following:

1. Client-controlled values are parameters, never concatenated SQL.
2. The query is inside a repository or infrastructure module.
3. All statements in a locking use case share one transaction client.
4. The reason for retaining SQL is locking, atomicity, or a genuinely clearer
   PostgreSQL-specific operation—not convenience alone.
5. No controller, service, or domain type imports Prisma or `pg` types.

Finally run the reservation concurrency and lifecycle proofs unchanged:

```powershell
yarn test tests/integration/reservations.integration.test.ts
yarn test tests/e2e/reservation-lifecycle.e2e.test.ts
yarn typecheck
yarn lint
```

Step 14 is complete only when those tests still pass. Preserving the raw path
without preserving its concurrency tests is not preserving the invariant.

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

Expose the connection string and the harness-owned Prisma client rather than
reaching into `pg.Pool` internals. Make these exact changes in
`tests/helpers/postgres.ts`:

```ts
export interface PostgresHarness {
  connectionString: string;
  pool: Pool;
  prisma: PrismaClient;
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
const prisma = createPrismaClient({ DATABASE_URL: connectionString, PRISMA_POOL_MAX: 5 });
```

Add both values to the returned harness object and close both clients before
stopping the container:

```ts
return {
  connectionString,
  pool,
  prisma,
  // Keep the existing reset and seed implementations here.
  stop: async () => {
    await Promise.all([prisma.$disconnect(), pool.end()]);
    await container.stop();
  },
};
```

Remove the now-unused `migrationsDirectory` constant and migration-runner
import from that file.

The harness keeps its `pg.Pool` for fixtures, direct authoritative assertions,
and reservation locking tests. Ordinary repositories receive `harness.prisma`.
The harness owns both clients, so individual suites call only `harness.stop()`
in `afterAll`; they must not disconnect the shared Prisma client separately.

Update the existing `tests/integration/communities.repository.test.ts` setup:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommunitiesRepository } from '../../src/modules/communities/communities.repository.js';
import { aliceId, bobId } from '../fixtures/database.js';
import type { PostgresHarness } from '../helpers/postgres.js';
import { startPostgresHarness } from '../helpers/postgres.js';

describe('CommunitiesRepository with Prisma', () => {
  let harness: PostgresHarness;
  let repository: CommunitiesRepository;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    repository = new CommunitiesRepository(harness.prisma);
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('creates the community and active owner atomically', async () => {
    const community = await repository.createWithOwner(aliceId, {
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
    await repository.createWithOwner(aliceId, input);

    await expect(
      repository.createWithOwner(bobId, {
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
