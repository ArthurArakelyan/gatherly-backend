# AGENTS.md

This file provides durable context and working rules for AI coding agents contributing to Gatherly. Read it before planning or modifying the repository. Also read `README.md` for the full product model and learning roadmap.

## Project intent

Gatherly is a pet project for learning backend engineering through a coherent community-and-events product. It is not currently a production startup, generic event marketplace, or infrastructure showcase.

The intended audience is one reachable niche of local hobby groups or small organizers. Preserve the narrow-product approach: validate the basic event/reservation flow with real users before adding advanced infrastructure.

## Current product boundary

The first complete version consists of:

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

Target flow:

```text
register → profile → join community → view event → reserve
→ cancel → promote next waitlisted user → notify affected users
```

Later modules are `checkins`, `reviews`, `chat`, `moderation`, and `search`. Do not introduce them into an earlier milestone unless the user explicitly asks.

## Architectural rules

- Use Yarn Classic (`yarn`, version 1.22.x) for dependency and script commands. Do not create an npm or pnpm lockfile; `yarn.lock` is authoritative.
- Keep a TypeScript/Node.js modular monolith: one application and one deployment.
- Use ES modules, strict TypeScript, and `NodeNext` module resolution.
- Prefer `route → controller → service → repository → persistence`.
- Routes wire endpoints and middleware.
- Controllers translate HTTP input/output and remain thin.
- Services own use cases, authorization decisions, and business logic.
- Repositories isolate database access.
- Schemas validate untrusted input at system boundaries.
- Domain/business types must not depend directly on Express or Prisma types.
- Do not access Prisma throughout controllers or unrelated modules.
- Use dependency injection where it improves testing, but avoid framework-heavy abstraction.
- Keep cross-module interaction explicit; do not create circular dependencies.
- PostgreSQL owns durable truth. Redis, Elasticsearch, Kafka, SSE, and WebSockets must never become the sole owners of permanent business data.

Preferred structure:

```text
src/
  app.ts
  server.ts
  config/
  shared/
  modules/<module>/
    <module>.routes.ts
    <module>.controller.ts
    <module>.service.ts
    <module>.repository.ts
    <module>.schemas.ts
    <module>.types.ts
  infrastructure/
  workers/
  tests/
```

Do not create microservices, Kubernetes configuration, or event sourcing unless directly requested.

## Domain summary

- A `User` has one profile and many memberships, reservations, waitlist entries, messages, notifications, and reviews.
- A `Community` has memberships, events, interests, and community conversations.
- An `Event` belongs to a community and creator; it has a location, reservations, waitlist entries, check-ins, reviews, and optionally an event conversation.
- A `Reservation` belongs to a user and event and may later have a check-in.
- A `WaitlistEntry` belongs to a user and event and is initially ordered by `joinedAt ASC`.
- Platform roles and community roles are separate concepts.
- Community deletion initially means transition to `ARCHIVED`, not destructive deletion.

Use the detailed field lists, statuses, relationships, and endpoint suggestions in `README.md` when designing an API or schema. Treat them as project context, not an immutable production contract: if a requested feature exposes a poor model, explain the tradeoff and update documentation together with the implementation.

## Critical invariants

These rules require explicit implementation and tests:

1. A user cannot have two active reservations for one event.
2. Confirmed reservations cannot exceed capacity, even under concurrent requests.
3. Only an authorized active community member can create or manage community events.
4. A banned/suspended member cannot reserve or access restricted community content.
5. Object-level authorization must prevent cross-user and cross-community ID substitution.
6. A moderator must not improperly remove or demote the community owner.
7. A user cannot be both actively waitlisted and confirmed for one event.
8. Cancellation promotes at most the first eligible waitlist entry.
9. Concurrent cancellation/promotion operations cannot allocate one place twice.
10. Only a checked-in attendee may review, once, after the event ends.
11. A reservation may be checked in only once.
12. Repeated idempotent requests return a consistent result and do not duplicate effects.

Capacity and waitlist correctness belong in PostgreSQL transactions, constraints, and locking. Never implement reservation as only:

```text
read capacity → JavaScript if → insert reservation
```

When changing reservations or waitlists, include a concurrency-focused test and explain the transaction/locking strategy.

## Learning sequence

Respect the progressive roadmap unless the user requests a different phase:

1. Phase 0: Node.js/TypeScript foundations without Express. This phase may be implemented by AI and is not a required user-led learning checkpoint.
2. Phase 1: Dockerize the Node foundation and run it beside PostgreSQL with Docker Compose; do not design application tables yet.
3. Phase 2: Build the Express API directly on PostgreSQL repositories using `pg`, handwritten SQL, migrations, and automated HTTP/integration tests. There is no in-memory persistence phase.
4. Phase 3: Introduce Prisma for ordinary persistence while retaining raw SQL where it is clearer or safer.
5. Phase 4: Minimal sign-up/sign-in authentication and thorough object-level authorization.
6. Phase 5: Container hardening and serious behavioral testing.
7. Phase 6: Query measurement and targeted database indexes, followed by Redis, SSE, WebSockets, Elasticsearch, and Kafka—in that order and only with a concrete use.
8. Phase 7: Observability, CI/CD, and production hardening.

The former "first usable MVP and deployment to a small real group" milestone is deliberately skipped. Gatherly remains a pet/learning project, so do not make real-user deployment a prerequisite for continuing the roadmap. This skip does not pull later product modules or advanced infrastructure into Phase 5.

Do not hide a lesson the current phase is intended to teach. During Phase 1, focus on containers, service health, networking, volumes, and shutdown rather than starting the API/domain schema. During Phase 2, use `pg` and handwritten SQL rather than replacing the exercise with Prisma.

## Technology boundaries

- **Express:** REST API, middleware, authentication, and webhooks.
- **PostgreSQL:** authoritative relational data, constraints, transactions, locking, and advanced queries.
- **Prisma:** normal application persistence and migrations after the raw-SQL phase.
- **Redis:** caches, rate limits, temporary codes, presence, Pub/Sub, and carefully selected coordination. Clearing it must not lose business truth.
- **SSE:** one-way notifications, status updates, progress, and organizer counters.
- **WebSockets:** bidirectional chat, typing, presence, moderation, and live Q&A. Persist messages before broadcasting them.
- **Elasticsearch:** rebuildable discovery index, introduced after PostgreSQL search limitations are understood. Provide a full reindex operation.
- **Kafka:** late-stage asynchronous domain events. Use a transactional outbox and idempotent consumers; expect duplicate delivery.
- **OpenTelemetry/Pino:** traces, metrics, and structured logs. Morgan is used earlier to learn HTTP middleware.
- **Docker:** reproducible environments, introduced progressively; ordinary development should not require every optional service.

## Authentication and security expectations

Authentication is deliberately simple because the project owner has already built production-grade authentication and does not want to relearn it here. The owner has also already implemented email delivery elsewhere, so Gatherly must not send email.

- Implement only username/password sign-up and sign-in.
- Use secure password hashing and a simple JWT or similarly small session mechanism sufficient for protected APIs.
- Keep basic credential validation and sign-in rate limiting.
- Do not add email verification, magic links, password recovery, refresh-token rotation, OAuth/OIDC, social providers, or elaborate session/device management unless the user explicitly asks.
- Do not treat authentication as a major learning phase or expand it for production completeness.
- Keep authentication distinct from authorization: community roles, ownership, membership status, bans, and object-level access checks remain core requirements and must be tested thoroughly.
- Hash check-in or shareable invitation codes where applicable.
- Validate every untrusted boundary and return a consistent safe error shape.
- Authorize the requested object, not merely the endpoint role.
- Do not trust client-supplied ownership, capacity, role, or attendance state.
- Never log passwords, authentication tokens, cookie values, or private message content by default.
- Audit sensitive moderation, membership-role, event-cancellation, and reservation-removal actions.

## API conventions

- Keep resource naming and status codes consistent.
- Validate path, query, header, and body inputs.
- Use stable machine-readable error codes plus human-readable messages.
- Include request IDs in logs and error responses where useful.
- Use pagination for collection endpoints; prefer keyset pagination when scale/query shape justifies it.
- Specify sorting and filtering semantics explicitly.
- Add idempotency keys to mutation endpoints with meaningful retry risk, especially reservations.
- Maintain OpenAPI documentation as endpoints stabilize.
- Avoid leaking private-community, session, token, moderation, or internal audit data through DTOs.

Endpoint paths in `README.md` are suggested defaults. Preserve them when practical, but favor coherent REST semantics over blindly copying a list.

## Time handling

- Store instants consistently (normally UTC) and preserve the event’s IANA time-zone identifier for display and recurrence rules.
- Treat recurring events as a later feature requiring explicit DST tests and idempotent generation.
- Model reservation state transitions explicitly.

## Testing expectations

Use the smallest test level that proves the behavior, while keeping critical boundaries covered:

- Unit tests for pure domain rules and state transitions.
- API tests (for example Supertest) for validation, authentication, authorization, pagination, errors, and idempotency.
- Integration tests with real disposable infrastructure for PostgreSQL and, once introduced, Redis/Kafka/Elasticsearch.
- End-to-end tests for the full reservation/waitlist lifecycle.

High-value scenarios:

- Two requests race for the last event place.
- The same idempotency key is submitted twice.
- A transaction fails midway and leaves no partial effects.
- Cancellation promotes exactly one correct user.
- Permission is revoked between operations or during a live connection.
- A dependency is unavailable without corrupting permanent data.
- A Kafka message is processed twice.
- Search indexing fails and is later rebuilt.
- The process receives a shutdown signal during an active request.

Favor behavioral confidence over an arbitrary coverage percentage.

## Database and migration guidance

- Encode invariants with primary keys, foreign keys, unique/partial unique constraints, check constraints, and transactions wherever possible.
- Use parameterized SQL only.
- Make migrations reviewable and safe for the current deployment stage.
- Do not add speculative indexes. For each meaningful index, document the query, plan before/after, measured benefit, and write/storage cost.
- Prefer explicit selection over returning entire database records from API endpoints.
- Avoid destructive schema/data operations without clear user authorization and a recovery plan.
- Keep raw SQL for complex locking, specialized indexes, analytics, or PostgreSQL features when it is superior to generated queries.

## Asynchronous and real-time guidance

- Do not add an email provider, Mailpit, email templates, email workers, or email-based notification/authentication flows. User-facing updates are in-app; push notifications may be considered later only if explicitly requested.
- Complete authoritative state changes in PostgreSQL before sending live updates.
- Database-originated Kafka events use a transactional outbox.
- Consumers record/process idempotently and tolerate retries or duplicates.
- SSE supports heartbeat, `Last-Event-ID`/replay where required, reconnection, authentication, and cleanup.
- WebSockets reauthorize meaningful actions; an authenticated connection does not grant permanent authorization.
- Implement heartbeats, rate limits, validation, backpressure awareness, and disconnect cleanup.
- Redis Pub/Sub may fan out across instances but must not be the only message store.

## Observability and operations

- Nginx is the chosen future reverse proxy; do not introduce Apache. Nginx is deployment-only and should not be installed or configured during ordinary local development.
- Development may use readable Morgan request output plus Pino application logs.
- Production logs should be structured and correlate request, trace, user, community, and event IDs where safe.
- Health endpoints are `/health/live` and `/health/ready`; metrics are exposed at `/metrics` when observability is introduced.
- Graceful shutdown stops accepting work, drains active requests/connections within a bound, closes consumers/workers, and releases resources.
- Useful future metrics include latency/errors, event-loop lag, DB pool saturation, reservation conflicts, waitlist size, outbox backlog, consumer lag, cache ratio, indexing failures, and live connection counts.
- When search observability is introduced, record projection attempts, successes,
  failures, and last-success time; alert on failures or sustained projection
  staleness. Add a reconciliation check between eligible PostgreSQL events and
  Elasticsearch documents because a best-effort post-commit update can be lost
  during a process crash or Elasticsearch outage. Treat full reindexing as the
  repair runbook, not routine synchronization, until a transactional outbox and
  durable retry worker make projection delivery self-healing. Keep search
  excluded from general readiness while it remains a non-critical projection.

## Scope control

Avoid speculative completeness. In particular, defer:

- Multi-place reservations
- Recurring events until core one-time events work
- QR check-in, chat, advanced moderation, and recommendations until the MVP flow works
- Elasticsearch until PostgreSQL search has measured shortcomings
- Kafka until there is real asynchronous work
- Native apps, video/livestreaming, custom email/OAuth systems, crypto, Kubernetes, microservices, and event sourcing
- All transactional and marketing email delivery, including verification, reset, invitation, reminder, and announcement emails

When the user asks what API to build next, identify the current roadmap phase, propose the smallest vertical slice, list its business rules and tests, and avoid pulling later infrastructure forward merely because it appears in the long-term roadmap.

## Documentation maintenance

- Update `README.md` when product scope, domain terminology, endpoint contracts, milestone status, or setup commands change.
- Update this file when agent-facing implementation rules or durable architectural decisions change.
- Once code exists, add concrete installation, environment, migration, test, and run commands to `README.md` rather than inventing them in advance.
- If implementation intentionally differs from the documented model, document the decision and rationale in the same change.
