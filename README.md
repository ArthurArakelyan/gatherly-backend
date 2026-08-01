# Gatherly Backend

Gatherly is a learning-focused backend for local hobby communities and small event organizers. It combines community membership, event discovery, reservations, automatic waitlists, notifications, and eventually real-time interaction.

The project is deliberately a **modular monolith**. Its purpose is to learn backend engineering through one coherent product, not to imitate a production startup or justify unnecessary infrastructure.

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

Start the current foundation server in watch mode:

```bash
yarn dev
```

It currently uses `node:http`, intentionally matching Phase 0, and exposes `GET /health`. Express is installed for the next phase but has not replaced the foundation exercise yet.

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
```

### Installed package groups

- API and validation: Express 5, Zod, CORS, Helmet, and Express Rate Limit.
- Minimal authentication: Argon2 and JSON Web Token.
- Configuration and logging: dotenv, Morgan, Pino, Pino HTTP, and Pino Pretty.
- Data and infrastructure clients: PostgreSQL (`pg`), Prisma, Redis, KafkaJS, Elasticsearch, and `ws`.
- Observability and payments: OpenTelemetry Node SDK, automatic instrumentation, OTLP HTTP exporters, Pino instrumentation, and Stripe.
- TypeScript runtime/build: TypeScript and tsx.
- Tests: Vitest, V8 coverage, Supertest, Testcontainers, service-specific PostgreSQL/Redis/Kafka/Elasticsearch containers, and required type packages.
- Code quality: ESLint flat config, TypeScript-ESLint, Prettier, and ESLint’s Prettier compatibility config.

The later-phase clients are installed and locked, but deliberately remain unconfigured and unused until their learning phase:

```text
Raw PostgreSQL phase  pg
Prisma phase          prisma + @prisma/client
Integration tests     Testcontainers service modules
Redis phase           redis
WebSocket phase       ws
Elasticsearch phase   @elastic/elasticsearch
Kafka phase           kafkajs
OpenTelemetry phase   Node SDK, auto-instrumentation, Pino instrumentation, OTLP exporters
Payments phase        Stripe SDK
```

Having a package installed does not move that technology earlier in the roadmap. Do not initialize, configure, connect, or introduce it into application code until its phase begins or the user explicitly asks.

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

Add `checkins`, `reviews`, `chat`, `moderation`, `search`, and `payments` progressively.

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
    payments/
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
```

Use username/password credentials, hash passwords securely, and issue a simple JWT (or similarly small session mechanism) sufficient to authenticate protected APIs. Keep basic input validation and login rate limiting, but do not turn authentication into a major project module. Authorization remains important: community roles, ownership, bans, and object-level access checks are core Gatherly lessons even though account authentication is deliberately simple.

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
priceAmount, priceCurrency, createdAt, updatedAt, publishedAt, cancelledAt
```

- Format: `IN_PERSON`, `ONLINE`, `HYBRID`
- Status: `DRAFT`, `PUBLISHED`, `CANCELLED`, `COMPLETED`, `ARCHIVED`
- Visibility: `PUBLIC`, `COMMUNITY_ONLY`, `INVITE_ONLY`
- Free event: `priceAmount = 0`; currency may be null

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

The JSON `data` field may reference an event, community, or reservation. Notification types include reservation confirmation/cancellation, waitlist entry/promotion, event update/cancellation, new message, membership approval, and later payment results.

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
- **Payments:** start with free, pay-at-location, or external-link events. Later use a fake provider and then hosted Stripe Checkout with verified, idempotent webhooks.

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
  └─ may have one Checkin and one Payment
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

Before Express, build:

1. A `node:http` server.
2. A CLI that reads events from JSON.
3. An event reminder using timers and `EventEmitter`.

Use ES modules (`"type": "module"`), strict TypeScript, and `NodeNext` resolution. Learn the event loop, promises, streams, buffers, signals, environment configuration, error handling, graceful shutdown, and `AbortController`.

### 1. Express and in-memory API

Implement communities, events, reservations, cancellation, pagination, filtering, request IDs, validation, centralized errors, OpenAPI, and automated HTTP tests using maps/arrays. Add Morgan to understand request middleware.

### 2. PostgreSQL with raw SQL

Run PostgreSQL in Docker Compose while Node runs locally. Use `pg`, manual tables, parameterized queries, joins, transactions, isolation, row locks, aggregation, constraints, normalization, timestamps, and pagination.

Directly implement the core invariants in SQL, especially concurrent final-place reservation and transactional waitlist promotion.

### 3. Prisma

Move ordinary persistence behind repositories using Prisma migrations, relations, seeds, generated types, and transactions. Retain raw SQL for reservation locking, specialized indexes, advanced PostgreSQL, and complex analytics.

### 4. Minimal authentication and authorization

Add only username/password sign-up and sign-in plus the small token/session mechanism required by protected routes. Then focus on platform/community roles, ownership, bans, and object-level authorization. Email verification, magic links, password recovery, refresh-token rotation, OAuth/OIDC, and social login are intentionally outside this project’s learning scope.

### 5. First usable MVP and deployment

Finish accounts, profiles, communities, membership, events, reservations, waitlists, announcements, in-app notifications, PostgreSQL search, and a mobile-friendly frontend. Deploy to a small real group and collect feedback before adding advanced infrastructure.

### 6. Docker and serious tests

Dockerize the Node app and PostgreSQL with multi-stage builds, health checks, non-root users, volumes, networks, secrets, graceful shutdown, and safe migration handling.

Use unit, integration, API, and end-to-end tests. Test concurrency, repeated idempotency keys, mid-transaction failure, dependency outages, duplicate messages, permission loss during a socket, and shutdown during active requests.

### 7. Performance and advanced infrastructure

Add each technology only when there is a demonstrated lesson or product need:

1. Study realistic PostgreSQL data with `EXPLAIN ANALYZE`; document the benefit and cost of each index.
2. Add Redis for disposable cache, throttling, temporary codes, presence, Pub/Sub, and selected coordination.
3. Add SSE for one-way notifications and live organizer counters, including heartbeat, replay, reconnection, and cleanup.
4. Add WebSockets for persisted chat, typing, presence, and moderation.
5. Add Elasticsearch as a rebuildable search projection with a full reindex command.
6. Add Kafka for domain events and asynchronous consumers using a transactional outbox and idempotent processing.
7. Add hosted payments only after reservations are reliable.
8. Add Pino structured logs, OpenTelemetry traces, metrics, Prometheus/Grafana/Tempo, and Uptime Kuma.
9. Add CI/CD, immutable images, staging, smoke tests, backups, restore tests, rollback planning, and failure/load testing.

Do not add Kubernetes or split the modular monolith into microservices for this project.

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

- PostgreSQL is authoritative for users, memberships, events, reservations, waitlists, payments, and messages.
- Redis is disposable acceleration and temporary coordination.
- Elasticsearch is a rebuildable projection.
- WebSocket and SSE connections are transports, not databases.
- Kafka consumers are idempotent; producers use a transactional outbox for database-originated domain events.
- Normal HTTP responses do not wait for unrelated asynchronous consumers.
- Payments are confirmed only from a verified provider webhook/API, never from browser claims.
- Logs never contain passwords, authentication tokens, cookies, payment data, or private chat bodies by default.

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
- Complex subscriptions, international tax, or marketplace payouts

Useful later topics include HTTP/TCP/DNS/TLS, CORS/CSRF/XSS defenses, API versioning, generated clients, S3-compatible uploads, background jobs, backups/restoration, feature flags, rate limiting, abuse prevention, retention/deletion, account export, time zones/DST, accessibility, and product analytics.

## Suggested milestone order

```text
1. Node and TypeScript foundations
2. Express in-memory REST API
3. PostgreSQL and raw SQL
4. Prisma
5. Minimal authentication and authorization
6. Communities and events
7. Reservations and waitlists
8. First deployment and real users
9. Automated testing
10. Docker improvements
11. Database indexes
12. Redis
13. SSE
14. WebSockets and chat
15. Elasticsearch
16. Kafka and transactional outbox
17. Payments
18. Logging and tracing
19. CI/CD and production hardening
20. Performance and failure testing
```

Real users intentionally appear before most advanced infrastructure. Their behavior should determine which later capabilities deserve investment.
