# Gatherly Backend

Gatherly is a learning-focused backend for local hobby communities and small event organizers. It combines community membership, event discovery, reservations, automatic waitlists, notifications, and eventually real-time interaction.

The project is deliberately a **modular monolith**. Its purpose is to learn backend engineering through one coherent product, not to imitate a production startup or justify unnecessary infrastructure.

## Docker quick reference

Run these commands from the repository root.

### Development stack

Always include both Compose files for development. The override bind-mounts the
source and runs `tsx watch`, so TypeScript changes restart the application.

```powershell
# Validate the merged configuration
docker compose -f compose.yaml -f compose.dev.yaml config --quiet

# Start in the foreground and build changed images
docker compose -f compose.yaml -f compose.dev.yaml up --build

# Start in the background
docker compose -f compose.yaml -f compose.dev.yaml up --detach --build

# Show container status
docker compose -f compose.yaml -f compose.dev.yaml ps

# Follow all logs, or only application/PostgreSQL logs
docker compose -f compose.yaml -f compose.dev.yaml logs --follow
docker compose -f compose.yaml -f compose.dev.yaml logs --follow app
docker compose -f compose.yaml -f compose.dev.yaml logs --follow postgres

# Restart one service
docker compose -f compose.yaml -f compose.dev.yaml restart app
docker compose -f compose.yaml -f compose.dev.yaml restart postgres

# Stop containers without removing them, then start them again
docker compose -f compose.yaml -f compose.dev.yaml stop
docker compose -f compose.yaml -f compose.dev.yaml start

# Stop and remove containers and the network; keep PostgreSQL data
docker compose -f compose.yaml -f compose.dev.yaml down
```

Rebuild the development image after changing `package.json`, `yarn.lock`, or the
Dockerfile. Ordinary changes below `src/` do not require a rebuild.

### Production-style local stack

The base Compose file builds the immutable runtime image, sets
`NODE_ENV=production`, and runs compiled JavaScript. This is useful for checking
the production image locally; it is not a complete production deployment.

```powershell
# Validate and build the runtime image
docker compose config --quiet
docker compose build app

# Start in the foreground or background
docker compose up --build
docker compose up --detach --build

# Inspect status and logs
docker compose ps
docker compose logs --follow app
docker compose logs --follow postgres

# Rebuild and recreate only the application after a source change
docker compose up --detach --build app

# Stop without removing, or remove while retaining database data
docker compose stop
docker compose down
```

Unlike the development stack, the production-style image does not mount
`src/`. Rebuild it to include source changes.

### Observability interfaces

Start the production-style stack with its optional observability services:

```powershell
docker compose -f compose.yaml -f compose.observability.yaml up --detach --build
```

The local interfaces bind only to loopback:

- Prometheus: `http://127.0.0.1:9090`
- Alertmanager: `http://127.0.0.1:9093`
- Grafana: `http://127.0.0.1:3001`
- Uptime Kuma: `http://127.0.0.1:3002`

OpenTelemetry has no separate UI. Traces are queried in Grafana through the
Tempo data source. Application and worker metrics, plus the Collector's own
internal telemetry, are queried through Prometheus or Grafana's Prometheus data
source. Prometheus scrapes the private `otel-collector:8888/metrics` endpoint;
port `8888` is deliberately not published to the host.

Useful starter PromQL queries are:

```promql
up{job="otel-collector"}
{__name__=~"otelcol_.*"}
rate(otelcol_receiver_accepted_spans_total[5m])
rate(otelcol_exporter_sent_spans_total[5m])
rate(otelcol_exporter_send_failed_spans_total[5m])
```

### PostgreSQL and database commands

The commands below use the example database and user names from `.env.example`.
Replace `gatherly` if your `.env` uses different values.

```powershell
# Check PostgreSQL readiness
docker compose exec postgres pg_isready -U gatherly -d gatherly

# Open an interactive psql session (exit with \q)
docker compose exec postgres psql -U gatherly -d gatherly

# List tables and inspect migration history
docker compose exec postgres psql -U gatherly -d gatherly -c "\dt"
docker compose exec postgres psql -U gatherly -d gatherly -c "TABLE schema_migrations;"

# Run migrations and the development seed in the running development app
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn db:migrate
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn db:seed

# Run migrations as a one-off production-image command
docker compose run --rm app yarn db:migrate:prod

# Inspect the deterministic development users
docker compose exec postgres psql -U gatherly -d gatherly -c "TABLE users;"

# Create a SQL backup on the host
docker compose exec -T postgres pg_dump -U gatherly -d gatherly > gatherly-backup.sql
```

### Elasticsearch reindex commands

The full rebuild reads canonical rows through `DATABASE_URL` and writes a new
versioned Elasticsearch index before atomically moving the read/write aliases.
Run it with application writers stopped:

```powershell
# Start the two required dependencies without starting the application writer
docker compose -f compose.yaml -f compose.dev.yaml up --detach postgres elasticsearch

# If the development application is already running, stop it during the rebuild
docker compose -f compose.yaml -f compose.dev.yaml stop app

# Uses DATABASE_URL, PRISMA_POOL_MAX, and ELASTICSEARCH_* from .env
yarn search:reindex

# Inspect the aliases through the configured published port
$elasticAddress = docker compose -f compose.yaml -f compose.dev.yaml port elasticsearch 9200
$elasticUrl = "http://$elasticAddress"
Invoke-RestMethod -Uri "$elasticUrl/_cat/aliases?format=json"

# Restart the application if it was running before the maintenance window
docker compose -f compose.yaml -f compose.dev.yaml start app
```

The worker deliberately does not require the HTTP server's `PGHOST`,
`PGDATABASE`, `PGUSER`, `PGPASSWORD`, JWT, Redis, SSE, or WebSocket variables.
Deleting the Elasticsearch volume loses only this rebuildable projection; run
the same command to reconstruct it from PostgreSQL.

### Cleanup and disk-space recovery

First inspect what Docker is using:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml ps --all
docker system df -v
```

For the development environment, this removes Gatherly's containers, network,
locally built application image, and PostgreSQL volume:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml down --volumes --remove-orphans --rmi local
```

This is a **complete, destructive local reset**. The source checkout remains,
but all data in `gatherly-backend_postgres_data` is deleted. Recreate an empty
development environment with:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up --detach --build
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn db:migrate
docker compose -f compose.yaml -f compose.dev.yaml exec app yarn db:seed
```

For the production-style Compose environment, normal cleanup should retain the
database volume:

```powershell
# Remove containers, network, and the locally built app image; retain DB data
docker compose down --remove-orphans --rmi local
```

Only when permanently decommissioning that environment, and only after creating
and verifying a backup, delete its database volume too:

```powershell
# DESTRUCTIVE: permanently deletes the Compose-managed PostgreSQL data
docker compose down --volumes --remove-orphans --rmi local
```

These commands do not remove shared base images such as
`postgres:17-bookworm`, because another project may use them. If no container
uses that image and you deliberately want to remove it, run:

```powershell
docker image rm postgres:17-bookworm
```

Docker build cache is engine-wide rather than reliably project-scoped. Inspect
it first, then optionally remove unused cache from all projects:

```powershell
docker builder prune

# More aggressive: remove all unused build cache, including reusable old layers
docker builder prune --all
```

Cache pruning never deletes the Gatherly source or PostgreSQL volume, but future
builds may need to download and rebuild dependencies again. Avoid
`docker system prune --all --volumes` for project cleanup: it affects unrelated
Docker projects and can delete their unused volumes. Docker Desktop's virtual
disk may remain physically large after cleanup even though Docker can reuse the
freed internal space.

## Local development setup

Requirements:

- Node.js 22.14 or newer (Node 24 is supported)
- Yarn Classic 1.22.x

Install and verify the project:

```bash
yarn install
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn build
```

Start the Express API in watch mode:

```bash
yarn dev
```

For Docker development, use the quick-reference commands above. The development
override bind-mounts the source and enables polling so file watching works
reliably through Docker Desktop. Plain `docker compose up --build` runs the
immutable production-style image, where source edits require rebuilding.

The current API exposes `GET /health/live`, `GET /health/ready`, minimal
username/password identity endpoints, communities, memberships, public events,
reservations, and waitlists. Protected endpoints require a JWT in the
`Authorization: Bearer <token>` header. The full implemented contract is in
[`docs/openapi.yaml`](./docs/openapi.yaml), assembled from module-specific files
under [`docs/openapi/`](./docs/openapi/). The WebSocket upgrade, commands,
events, and close codes are documented separately in
[`docs/websocket-protocol.md`](./docs/websocket-protocol.md).

### Available scripts

```text
yarn dev               Run src/server.ts in watch mode with tsx
yarn build             Compile production files to dist/
yarn start             Run the compiled server
yarn typecheck         Check strict TypeScript without emitting files
yarn lint              Run ESLint
yarn lint:fix          Apply safe ESLint fixes
yarn format            Format the repository with Prettier
yarn format:check      Check formatting without changing files
yarn test              Run all tests once with Vitest
yarn test:watch        Run Vitest in watch mode
yarn test:coverage     Generate text, HTML, and LCOV coverage
yarn test:unit         Run tests/unit
yarn test:api          Run tests/api
yarn test:integration  Run tests/integration
yarn test:e2e          Run tests/e2e
yarn db:migrate        Apply pending migrations from TypeScript
yarn db:migrate:prod   Apply pending migrations from compiled JavaScript
yarn db:seed           Insert repeatable development data
yarn search:reindex    Rebuild the Elasticsearch event index
yarn kafka:outbox      Run the Kafka outbox publisher worker
yarn kafka:search-consumer  Run the Kafka search-projection consumer
```

Integration and API tests start an isolated PostgreSQL Testcontainers database,
apply the same SQL migrations, and never use the Compose development volume.
Docker must be running for `yarn test`, `yarn test:api`, and
`yarn test:integration`.

### Installed package groups

- API and validation: Express 5, Zod, CORS, Helmet, and Express Rate Limit.
- Minimal authentication: Argon2 and JSON Web Token.
- Configuration and logging: dotenv, Morgan, Pino, Pino HTTP, and Pino Pretty.
- Data and infrastructure clients: PostgreSQL (`pg`), Prisma, Redis, KafkaJS, Elasticsearch, and `ws`.
- Observability: OpenTelemetry Node SDK, automatic instrumentation, OTLP HTTP exporters, and Pino instrumentation.
- TypeScript runtime/build: TypeScript and tsx.
- Tests: Vitest, V8 coverage, Supertest, Testcontainers, service-specific PostgreSQL/Redis/Kafka/Elasticsearch containers, and required type packages.
- Code quality: ESLint flat config, TypeScript-ESLint, Prettier, and ESLint’s Prettier compatibility config.

Infrastructure clients are activated only when their roadmap increment is
implemented. PostgreSQL, Prisma, Redis, WebSockets, Elasticsearch, Kafka, and
OpenTelemetry are now configured:

```text
Raw PostgreSQL phase  pg
Prisma phase          prisma + @prisma/client
Integration tests     Testcontainers service modules
Redis phase           redis
WebSocket phase       ws
Elasticsearch phase   @elastic/elasticsearch (active)
Kafka phase           kafkajs (active)
OpenTelemetry phase   Node SDK, auto-instrumentation, Pino instrumentation, OTLP exporters (active)
```

Having a package installed does not move that technology earlier in the
roadmap. Do not initialize or connect a deferred client until its phase begins
or the user explicitly asks.

## Product focus

The first real release should serve one reachable niche—for example board-game groups, language exchanges, university clubs, local sports groups, tech meetups, or creative workshops. Pick one niche, recruit roughly five organizers, and solve their concrete problems before broadening the product.

Do not launch as a generic marketplace with an empty global directory. Start with an existing community such as one university, neighborhood, hobby, sport, or organizer network.

The first product test is simple:

> Can one organizer create an event and get ten people to reserve through Gatherly?

## Core user journey

1. A user registers and creates a profile.
2. An organizer creates a community and publishes a limited-capacity event.
3. Users join the community and reserve places.
4. Once capacity is reached, later users enter an ordered waitlist.
5. When a confirmed attendee cancels, the first eligible waitlisted user is promoted safely.
6. Users receive announcements and reservation updates.
7. Later, attendees can check in, chat, and review the event.

## Roles

Platform roles:

- `USER`
- `PLATFORM_MODERATOR`
- `PLATFORM_ADMIN`

Community roles:

- `MEMBER`
- `MODERATOR`
- `ORGANIZER`
- `OWNER`

Regular users discover communities and events, join groups, reserve or waitlist, save events, follow organizers, receive notifications, check in, review attended events, and report abuse.

Organizers manage communities, roles, events, capacity, reservations, waitlists, announcements, check-ins, members, exports, and basic statistics.

Administrators review reports, moderate content, suspend accounts, inspect audit logs, and manage platform categories or featured content.

## First complete version

Build only these modules for the first end-to-end version:

```text
identity
profiles
communities
memberships
events
reservations
waitlists
notifications
```

The initial end-to-end flow is:

```text
Register
→ create profile
→ join community
→ open event
→ reserve a place
→ cancel reservation
→ promote the next waitlisted user
→ receive a notification
```

Add `checkins`, `reviews`, `chat`, `moderation`, and `search` progressively.

## Architecture

Use a modular monolith with one application and one deployment:

```text
src/
  app.ts
  server.ts

  config/
    env.ts
    index.ts

  shared/
    auth/
    errors/
    events/
    logging/
    pagination/
    validation/

  modules/
    identity/
    profiles/
    communities/
    memberships/
    events/
    reservations/
    waitlists/
    checkins/
    chat/
    notifications/
    reviews/
    moderation/
    search/

  infrastructure/
    postgres/
    prisma/
    redis/
    kafka/
    elasticsearch/
    telemetry/

  workers/
    outbox-publisher.ts
    notification-consumer.ts
    search-indexer.ts
    event-reminder-worker.ts
    recurring-event-worker.ts

  tests/
    fixtures/
    integration/
    api/
    e2e/
```

Each module may use:

```text
module.routes.ts       HTTP endpoints and middleware wiring
module.controller.ts  HTTP request/response translation
module.service.ts     Business rules and use cases
module.repository.ts  Persistence operations
module.schemas.ts     Input validation
module.types.ts       Module-owned TypeScript types
```

Keep the dependency flow explicit:

```text
route → controller → service → repository → persistence
```

Business logic must not depend directly on Express or Prisma types.

## Domain model

### Identity

Authentication is intentionally minimal in this project. A production-grade authentication system has already been built elsewhere, so Gatherly should not spend learning time on rebuilding email verification, password recovery, magic links, refresh-token rotation, OAuth/OIDC, social login, or elaborate session management. Gatherly does not send emails at all.

`users`

```text
id, username, passwordHash, status, createdAt, updatedAt, lastLoginAt
```

`username` must be unique. User status: `ACTIVE`, `SUSPENDED`, `DELETED`.

Primary endpoints:

```text
POST /auth/sign-up
POST /auth/sign-in
GET  /auth/me
```

Use username/password credentials, hash passwords securely, and issue a simple JWT (or similarly small session mechanism) sufficient to authenticate protected APIs. Rate-limit sign-up separately from sign-in: the former protects hashing resources and durable account creation, while the latter limits credential guessing. `GET /auth/me` returns the current active user loaded while authenticating the bearer token. Do not turn authentication into a major project module. Authorization remains important: community roles, ownership, bans, and object-level access checks are core Gatherly lessons even though account authentication is deliberately simple.

### Profiles and interests

`profiles`

```text
id, userId, displayName, bio, avatarUrl, city, country,
timezone, preferredLanguage, createdAt, updatedAt
```

`userId` is unique. The public username belongs to `users`; profile routes may resolve a user by that username. `interests` contains `id`, `name`, `slug`, and `createdAt`; `user_interests(userId, interestId, createdAt)` is the join table.

```text
GET   /profiles/:username
GET   /profiles/me
PATCH /profiles/me
PUT   /profiles/me/interests
```

### Communities and memberships

`communities`

```text
id, name, slug, description, logoUrl, coverImageUrl, city, country,
visibility, joinPolicy, status, createdByUserId, createdAt, updatedAt
```

- Visibility: `PUBLIC`, `UNLISTED`, `PRIVATE`
- Join policy: `OPEN`, `APPROVAL_REQUIRED`, `INVITE_ONLY`
- Status: `ACTIVE`, `ARCHIVED`, `SUSPENDED`

Use `community_interests(communityId, interestId, createdAt)` for categorization. “Deleting” a community can initially archive it.

`community_memberships`

```text
id, communityId, userId, role, status, joinedAt, createdAt, updatedAt
```

- Role: `MEMBER`, `MODERATOR`, `ORGANIZER`, `OWNER`
- Status: `PENDING`, `ACTIVE`, `REJECTED`, `SUSPENDED`, `BANNED`, `LEFT`
- Constraint: one membership record per user and community

Primary endpoints:

```text
POST   /communities
GET    /communities
GET    /communities/:communityId
PATCH  /communities/:communityId
DELETE /communities/:communityId

POST   /communities/:communityId/join
POST   /communities/:communityId/leave
GET    /communities/:communityId/members
PATCH  /communities/:communityId/members/:userId
DELETE /communities/:communityId/members/:userId
```

Invitations are deferred. If added later, use an in-app invitation for an existing user or a shareable invite code; do not introduce email delivery.

### Events

`events`

```text
id, communityId, createdByUserId, title, slug, description, imageUrl,
format, status, visibility, startsAt, endsAt, timezone, capacity,
reservationOpensAt, reservationClosesAt, cancellationDeadline,
createdAt, updatedAt, publishedAt, cancelledAt
```

- Format: `IN_PERSON`, `ONLINE`, `HYBRID`
- Status: `DRAFT`, `PUBLISHED`, `CANCELLED`, `COMPLETED`, `ARCHIVED`
- Visibility: `PUBLIC`, `COMMUNITY_ONLY`, `INVITE_ONLY`
  All Gatherly events are free. The domain does not model prices or financial transactions.

`event_locations` stores venue/address/geolocation, online meeting URL, and instructions. `event_interests` connects events to interests.

```text
POST   /communities/:communityId/events
GET    /events
GET    /events/:eventId
PATCH  /events/:eventId
POST   /events/:eventId/publish
POST   /events/:eventId/cancel
DELETE /events/:eventId
```

### Reservations and waitlists

`reservations`

```text
id, eventId, userId, status, numberOfPlaces, reservedAt, confirmedAt,
cancelledAt, cancellationReason, idempotencyKey, createdAt, updatedAt
```

Status: `PENDING`, `CONFIRMED`, `CANCELLED_BY_USER`, `CANCELLED_BY_ORGANIZER`, `EXPIRED`.

Initially, `numberOfPlaces` is always `1`. Enforce one active reservation per user/event, idempotency, and capacity in PostgreSQL—not with a check-then-write JavaScript condition.

`waitlist_entries`

```text
id, eventId, userId, status, joinedAt, offeredAt, offerExpiresAt,
promotedAt, cancelledAt, createdAt, updatedAt
```

Status: `WAITING`, `PLACE_OFFERED`, `PROMOTED`, `OFFER_EXPIRED`, `CANCELLED`, `REMOVED`.

Initially order the queue by `joinedAt ASC`; a stored position is optional. Cancellation and promotion must share an appropriate transaction/locking strategy so two workers cannot promote into the same place.

```text
POST   /events/:eventId/reservations
GET    /events/:eventId/reservations/me
DELETE /events/:eventId/reservations/me
GET    /events/:eventId/reservations
DELETE /events/:eventId/reservations/:reservationId

POST   /events/:eventId/waitlist
GET    /events/:eventId/waitlist/me
DELETE /events/:eventId/waitlist/me
GET    /events/:eventId/waitlist
POST   /events/:eventId/waitlist/promote-next
```

### Notifications

`notifications`

```text
id, userId, type, title, message, data, readAt, createdAt
```

The JSON `data` field may reference an event, community, or reservation. Notification types include reservation confirmation/cancellation, waitlist entry/promotion, event update/cancellation, new message, and membership approval.

`notification_preferences` controls in-app reminders, chat notifications, and community announcements. A later `notification_deliveries` table can track in-app or push delivery status, attempts, timestamps, and failure reasons. Email is not a supported channel.

```text
GET   /notifications
PATCH /notifications/:notificationId/read
POST  /notifications/read-all
GET   /notification-preferences
PATCH /notification-preferences
```

### Later modules

- **Check-ins:** one check-in per reservation; manual, QR, or self-check-in. Short-lived hashed QR tokens must prevent replay.
- **Chat:** community/event conversations and persisted PostgreSQL messages. WebSockets transport updates but never replace durable storage.
- **Reviews:** rating 1–5, one per attendee/event, allowed only after event end and only for checked-in attendees.
- **Moderation:** reports, community bans, user blocks, platform actions, and append-oriented audit logs.
- **Search:** start with PostgreSQL; add Elasticsearch only when product requirements justify typo tolerance, autocomplete, facets, geo-distance, or ranking.

## Essential data relationships

```text
User
  ├─ has one Profile
  ├─ has many Memberships, Reservations, WaitlistEntries
  └─ has many Messages, Notifications, and Reviews

Community
  ├─ has many Memberships and Events
  └─ has many Conversations and CommunityInterests

Event
  ├─ belongs to Community and creator User
  ├─ has one Location and optionally one Conversation
  └─ has many Reservations, WaitlistEntries, Checkins, and Reviews

Reservation
  ├─ belongs to User and Event
  └─ may have one Checkin
```

## Non-negotiable business invariants

- A user cannot have two active reservations for the same event.
- Confirmed attendance cannot exceed event capacity, including under concurrent requests.
- Only sufficiently privileged active community members can create or manage its events.
- Banned users cannot reserve, participate in private content, or bypass restrictions by changing URL IDs.
- A moderator cannot remove or demote the community owner improperly.
- Cancelling a confirmed reservation promotes at most the first eligible waitlisted user.
- A user cannot be simultaneously confirmed and actively waiting for the same event.
- Only checked-in attendees can review, once, after the event ends.
- One reservation can be checked in only once.
- PostgreSQL owns permanent truth; caches, search indexes, and brokers hold rebuildable or transient state.

The defining database exercise is two concurrent users attempting to reserve the final place. Solve it with transactions, constraints, and row locking, and be able to explain why overbooking cannot occur.

## Progressive learning roadmap

### 0. Node.js and TypeScript foundations

This foundation may be scaffolded or completed by AI; it is no longer a required user-led learning checkpoint. The current repository already contains the native HTTP server. Optional foundation exercises are:

1. A `node:http` server.
2. A CLI that reads events from JSON.
3. An event reminder using timers and `EventEmitter`.

Use ES modules (`"type": "module"`), strict TypeScript, and `NodeNext` resolution. Learn the event loop, promises, streams, buffers, signals, environment configuration, error handling, graceful shutdown, and `AbortController`.

### 1. Docker, Docker Compose, and PostgreSQL foundation

Containerize the current Node application and run it with PostgreSQL through Docker Compose. Add a Dockerfile, `.dockerignore`, Compose configuration, environment variables, an isolated network, a named PostgreSQL volume, and health checks for both services.

Follow the detailed, build-it-yourself guide in [`PHASE_1_DOCKER_HANDBOOK.md`](./PHASE_1_DOCKER_HANDBOOK.md).

At this stage, prove that:

- `docker compose up --build` starts the Node and PostgreSQL services.
- The Node health endpoint is reachable from the host.
- The application can resolve PostgreSQL by its Compose service name.
- PostgreSQL data survives an ordinary container restart through its named volume.
- Health checks and dependency conditions behave predictably.
- Ctrl+C or `docker compose stop` allows the Node process to shut down gracefully.

Do not introduce application tables, Prisma, Nginx, or production deployment machinery yet.

### 2. Express API with PostgreSQL and raw SQL

Replace the manual `node:http` request routing with Express and build communities, events, reservations, cancellation, waitlists, pagination, filtering, request IDs, validation, centralized errors, OpenAPI, and automated HTTP tests. Repositories use `pg` and PostgreSQL from the beginning; there is no in-memory persistence phase.

Follow the detailed, build-it-yourself guide in [`PHASE_2_EXPRESS_POSTGRES_HANDBOOK.md`](./PHASE_2_EXPRESS_POSTGRES_HANDBOOK.md).

Create tables and migrations manually and learn parameterized queries, joins, transactions, isolation, row locks, aggregation, constraints, normalization, timestamps, and pagination. Add Morgan to understand request middleware.

Directly implement the core invariants in SQL, especially concurrent final-place reservation and transactional waitlist promotion.

### 3. Prisma

Move ordinary persistence behind repositories using Prisma migrations, relations, seeds, generated types, and transactions. Retain raw SQL for reservation locking, specialized indexes, advanced PostgreSQL, and complex analytics.

### 4. Minimal authentication and authorization

Add only username/password sign-up and sign-in plus the small token/session mechanism required by protected routes. Then focus on platform/community roles, ownership, bans, and object-level authorization. Email verification, magic links, password recovery, refresh-token rotation, OAuth/OIDC, and social login are intentionally outside this project’s learning scope.

Follow the detailed, build-it-yourself guide in
[`PHASE_4_MINIMAL_AUTH_HANDBOOK.md`](./PHASE_4_MINIMAL_AUTH_HANDBOOK.md).

### Skipped milestone: real-user MVP and deployment

The former Phase 5 asked for a complete frontend, a deployment to a small real group, and feedback from real users. Gatherly is intentionally a pet/learning project, so that milestone is skipped rather than treated as a gate. Product modules that are not already required by the current backend flow remain deferred until explicitly requested.

### 5. Container hardening and serious behavioral tests

Improve the Phase 1 containers with production-oriented multi-stage builds, tighter non-root execution, secret handling, image caching, graceful draining, and safe migration handling.

Use unit, integration, API, end-to-end, and process-level tests. Test concurrency, repeated idempotency keys, mid-transaction failure, authentication revocation, object-level authorization, PostgreSQL outages, shutdown during active requests, duplicate Kafka delivery, and live-connection behavior.

Follow the planning and implementation guide in
[`PHASE_5_CONTAINER_HARDENING_TESTING_HANDBOOK.md`](./PHASE_5_CONTAINER_HARDENING_TESTING_HANDBOOK.md).

### 6. Performance and advanced infrastructure

Add each technology only when there is a demonstrated lesson or product need:

1. Study realistic PostgreSQL data with `EXPLAIN ANALYZE`; document the benefit and cost of each index.
2. Add Redis for disposable cache, throttling, temporary codes, presence, Pub/Sub, and selected coordination.
3. Add SSE for one-way notifications and live organizer counters, including heartbeat, replay, reconnection, and cleanup.
4. Add WebSockets for persisted chat, typing, presence, and moderation.
5. Add Elasticsearch as a rebuildable search projection with a full reindex command.
6. Add Kafka for domain events and asynchronous consumers using a transactional outbox and idempotent processing.

Start Phase 6 with the build-it-yourself PostgreSQL measurement and Redis
implementation guide in
[`PHASE_6_POSTGRES_PERFORMANCE_REDIS_HANDBOOK.md`](./PHASE_6_POSTGRES_PERFORMANCE_REDIS_HANDBOOK.md).
It deliberately stops before SSE, WebSockets, Elasticsearch, and Kafka so each
later technology still needs a concrete lesson and product use.

Continue with the build-it-yourself SSE implementation guide in
[`PHASE_6_SSE_HANDBOOK.md`](./PHASE_6_SSE_HANDBOOK.md). It adds durable
PostgreSQL replay, authenticated notification and organizer-counter streams,
Redis Pub/Sub wake-ups, reconnection, heartbeat, authorization rechecks, and
graceful cleanup. Automated test implementation is isolated in a final AI
handoff checkpoint so the transport remains a user-led learning exercise.

Then follow the build-it-yourself WebSocket and persisted event-chat guide in
[`PHASE_6_WEBSOCKETS_HANDBOOK.md`](./PHASE_6_WEBSOCKETS_HANDBOOK.md). It adds
one-use handshake tickets, PostgreSQL-backed message history and moderation,
idempotent sends, current authorization checks, Redis Pub/Sub fan-out, typing,
leased presence, ping/pong liveness, backpressure limits, reconnect recovery,
and graceful upgraded-socket cleanup. Its automated tests are likewise kept in
a final AI handoff checkpoint after the learner implements and manually
inspects the protocol.

Next use the build-it-yourself Elasticsearch event-discovery guide in
[`PHASE_6_ELASTICSEARCH_HANDBOOK.md`](./PHASE_6_ELASTICSEARCH_HANDBOOK.md). It
adds a strict rebuildable public-event projection, versioned indices and atomic
aliases, typo-tolerant search, autocomplete, filters, facets, PIT cursor
pagination, best-effort post-commit indexing, a full maintenance-window
reindex command, and explicit search-outage behavior. PostgreSQL remains the
source of truth; the later Kafka increment replaces the best-effort trigger.

The Kafka, transactional-outbox, and idempotent-consumer implementation follows
[`PHASE_6_KAFKA_HANDBOOK.md`](./PHASE_6_KAFKA_HANDBOOK.md). It replaces the
best-effort event-search projection trigger with an atomic PostgreSQL outbox,
an at-least-once Kafka publisher, and a duplicate-safe Elasticsearch consumer.
The HTTP server and worker roles remain one modular-monolith codebase;
PostgreSQL remains authoritative, malformed records have an explicit
dead-letter path, and the guide proves the publish/mark and consume/commit crash
windows with real infrastructure.

Phase 7 adds explicit search-projection signals: attempt, success, failure,
last-success time, failure alerts, and a scheduled reconciliation check between
eligible PostgreSQL events and the Elasticsearch projection. Normal projection
delivery is self-healing through the transactional outbox and durable consumer;
full reindex remains the repair for confirmed drift, schema changes, and
disaster recovery rather than a routine deployment or schedule action.
Elasticsearch remains excluded from general readiness so a discovery outage
does not take PostgreSQL-backed APIs out of service.

Do not add Kubernetes or split the modular monolith into microservices for this project.

### 7. Observability, CI/CD, and production hardening

Add Pino production request/audit logging, OpenTelemetry traces, bounded
Prometheus metrics, Prometheus/Grafana/Tempo, and Uptime Kuma. Then build CI/CD
around immutable runtime and migration image digests from the same commit,
separate staging and production environments, safe forward migrations, smoke
checks, backups and restore drills, and failure/load testing.

Follow the complete build-it-yourself guide in
[`PHASE_7_OBSERVABILITY_CICD_PRODUCTION_HARDENING_HANDBOOK.md`](./PHASE_7_OBSERVABILITY_CICD_PRODUCTION_HARDENING_HANDBOOK.md).
It adapts the proven inactive-slot/readiness/Nginx-switch/rollback pattern from
the local `parinry-wpalchemy-backend` reference while accounting for Gatherly's
PostgreSQL source of truth, separate worker roles, Kafka/Elasticsearch
projection path, and long-lived SSE/WebSocket connections.

The deployment question for this phase is:

When the application is deployed with Docker, investigate:

> How can Gatherly deploy a new immutable application image without stopping the currently working container first, so users do not experience a minute of total downtime?

Use this question to learn readiness checks, graceful shutdown, reverse-proxy traffic switching, running old and new containers simultaneously, blue/green deployments, backward-compatible database migrations, automated traffic rollback, and draining long-lived HTTP/SSE/WebSocket connections. This is one-host zero-planned-downtime deployment, not host or database high availability.

**Reverse-proxy decision:** use Nginx rather than Apache if Gatherly is eventually deployed. Nginx will sit in front of the Node/Express container to terminate TLS, expose ports 80/443, proxy HTTP/WebSocket/SSE traffic, and later help switch traffic between old and new application containers. It is not needed for local development and should not be installed or configured until the deployment stage.

## Testing priorities

Prioritize behavior over a coverage percentage:

- Two users attempt the last place concurrently.
- A reservation request repeats with the same idempotency key.
- A transaction fails halfway through.
- Cancellation promotes exactly one eligible waitlisted user.
- A banned user or cross-community organizer is denied.
- Changing a resource ID never exposes another user’s private data.
- Redis is unavailable without loss of permanent data.
- Kafka delivers an event twice and the consumer remains correct.
- Search indexing fails and can be rebuilt.
- A connected user loses permission.
- The server shuts down during an active request.

## Infrastructure principles

- PostgreSQL is authoritative for users, memberships, events, reservations, waitlists, and messages.
- Redis is disposable acceleration and temporary coordination.
- Elasticsearch is a rebuildable projection.
- WebSocket and SSE connections are transports, not databases.
- Kafka consumers are idempotent; producers use a transactional outbox for database-originated domain events.
- Normal HTTP responses do not wait for unrelated asynchronous consumers.
- Logs never contain passwords, authentication tokens, cookies, or private chat bodies by default.

## Deferred scope

Do not build these unless the learning goal changes materially:

- Video calls or livestreaming
- Native mobile apps
- A custom recommendation model
- Cryptocurrency
- A custom email service or OAuth provider
- Advanced authentication flows such as email verification, password reset, refresh-token rotation, OAuth/OIDC, and social login
- Any transactional or marketing email delivery; use in-app notifications instead
- Kubernetes or microservices
- Event sourcing

Useful later topics include HTTP/TCP/DNS/TLS, CORS/CSRF/XSS defenses, API versioning, generated clients, S3-compatible uploads, background jobs, backups/restoration, feature flags, rate limiting, abuse prevention, retention/deletion, account export, time zones/DST, accessibility, and product analytics.

## Suggested milestone order

```text
1. Node and TypeScript foundations
2. Dockerize Node and run PostgreSQL with Docker Compose
3. Express REST API backed by PostgreSQL and raw SQL
4. Prisma
5. Minimal authentication and authorization
6. Communities and events
7. Reservations and waitlists
8. Skip the former real-user deployment milestone for this pet project
9. Automated testing and container hardening
10. Database indexes
11. Redis
12. SSE
13. WebSockets and chat
14. Elasticsearch
15. Kafka and transactional outbox
16. Structured logs, metrics, traces, dashboards, and alerts
17. CI/CD, immutable images, staging, and blue/green production deployment
18. Backups, restore drills, production hardening, and failure/load testing
```

The former real-user MVP gate is intentionally skipped. Later infrastructure
still requires a concrete learning objective and measured behavior rather than
speculative product completeness.
