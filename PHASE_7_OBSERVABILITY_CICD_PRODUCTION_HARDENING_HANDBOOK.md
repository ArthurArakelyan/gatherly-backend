# Phase 7 Handbook: Observability, CI/CD, and Blue/Green Production Hardening

This is the final build-it-yourself phase for Gatherly. It turns the Phase 6
modular monolith into an observable, repeatably releasable application without
changing the product into microservices or Kubernetes.

The deployment design is adapted from the blue/green setup in
`C:\projects\parinry-wpalchemy-backend`: publish an immutable application
image, start it in the inactive slot, prove readiness, switch an Nginx
upstream, verify the public path, drain the old slot, and roll traffic back if
verification fails. Gatherly also publishes the existing dedicated migration
target from the same commit instead of putting Prisma CLI in the runtime image.
Gatherly adds requirements that the reference application does not have:

- PostgreSQL is the authoritative store and migrations must tolerate old and
  new code running at the same time.
- The HTTP process, outbox publisher, and search consumer are separate roles
  from one image.
- Redis, Kafka, and Elasticsearch are not allowed to make the core API
  unready merely because an optional capability is degraded.
- SSE and WebSocket connections must be deliberately drained and allowed to
  reconnect after traffic changes.
- Search projection delivery, outbox age, consumer lag, and reconciliation
  drift need first-class operational signals.

This handbook designs and rehearses one-host zero-planned-downtime deployment.
It does not claim host, Docker daemon, Nginx, or database high availability.

## How to use this handbook

Work through one checkpoint at a time. Every checkpoint produces evidence, not
just configuration. Keep the evidence in a private operations notebook or in
sanitized repository documentation; never commit real hostnames, credentials,
backup contents, tokens, or private telemetry.

Each checkpoint has four parts:

1. **Reason:** the lesson and failure mode.
2. **Implementation:** the files and behavior to add.
3. **Verification:** commands or drills that prove the behavior.
4. **Exit evidence:** the artifact that makes completion reviewable.

Code blocks labelled **complete file** replace or create the whole named file.
Blocks labelled **exact edits** are deliberately smaller because replacing a
large existing Gatherly file would hide the lesson and overwrite unrelated
Phase 6 wiring. Apply checkpoints in order: later samples assume earlier logger,
metrics, tracing, and build-info files exist. Run the checkpoint verification
before continuing. Keep Yarn Classic authoritative and commit the resulting
`yarn.lock`. Verify external image releases in staging and pin third-party
GitHub Actions to reviewed commit SHAs even when examples use readable major
tags.

Before starting, preserve a clean Phase 6 commit and record the image digest,
database migration status, test result, and current Compose configuration.

---

## Phase outcome

At the end of Phase 7, the system has this request path:

```text
Internet
  -> host firewall
  -> Nginx :443 (TLS, request limits, proxy rules)
  -> active application slot only
       blue  127.0.0.1:3101 -> container :3000
       green 127.0.0.1:3102 -> container :3000
  -> shared PostgreSQL / Redis / Kafka / Elasticsearch
```

Only the inactive HTTP slot is replaced during deployment. Long-running worker
roles are updated separately from the same runtime image after the HTTP cutover:

```text
one immutable runtime image digest
  +-> blue or green HTTP role
  +-> outbox-publisher role
  +-> search-projection-consumer role
  +-> maintenance roles such as search reindex or reconciliation

one immutable migration image digest from the same commit
  +-> one-shot Prisma migration role
```

The observability path is intentionally small enough for one learning host:

```text
Pino JSON -> container stdout -> bounded Docker logs

Node/OpenTelemetry -> OTLP -> OpenTelemetry Collector -> Tempo

GET /metrics -> Prometheus -> Grafana dashboards and alert rules

public /health/live -> Uptime Kuma external-style availability check
internal /health/ready -> deployment and operator check
```

Loki or another log store may be added later if querying one host's retained
Docker logs becomes a demonstrated limitation. It is not required merely to
claim three product names under an "observability stack."

### Success criteria

- Production logs are structured, redacted, correlated, bounded, and useful
  during a real incident.
- Traces cross Express, PostgreSQL, Redis, Kafka, and Elasticsearch where the
  supported instrumentations allow it, with manual spans only around important
  domain boundaries.
- Metrics describe user-visible service, capacity conflicts, dependency state,
  asynchronous backlogs, live connections, and search projection health.
- Dashboards and alerts answer a small set of explicit operational questions.
- Pull requests run deterministic quality and behavioral gates.
- A reviewed commit produces immutable runtime and migration images and deploys
  those exact digests to staging before production.
- Production starts an inactive candidate, checks it, switches Nginx without
  stopping the active slot, verifies the public path, and drains the old slot.
- A failed candidate never receives traffic; a failed public verification
  restores the previous upstream automatically.
- Application rollback never automatically reverses a database migration.
- Encrypted Restic backups are stored on the application host and restore drills
  are timed. Complete host or disk loss remains an accepted limitation.
- Deployment, rollback, dependency outage, disk pressure, and restore runbooks
  have been rehearsed rather than merely written.

### Deliberate non-goals

Do not add any of these in Phase 7:

- Kubernetes, Docker Swarm, Nomad, or a service mesh;
- microservices or separate repositories for the workers;
- multi-region or multi-host high availability disguised as a one-host lab;
- event sourcing or Kafka as a database;
- public Prometheus, Grafana, Tempo, Docker, PostgreSQL, Redis, Kafka, or
  Elasticsearch ports;
- a custom secrets platform before host files and GitHub environments are
  handled correctly;
- automatic destructive migration rollback;
- email delivery for product or operator notifications;
- dashboards with no decision, owner, or runbook attached.

---

## Reliability contract before tooling

Observability and deployment automation should encode a service contract. Use
this initial one and revise it only from measured evidence:

| Capability                              | User-visible promise                        | Readiness dependency    | Repair source               |
| --------------------------------------- | ------------------------------------------- | ----------------------- | --------------------------- |
| Core REST and authorization             | available when PostgreSQL is usable         | PostgreSQL              | PostgreSQL backup           |
| Reservations and waitlists              | never overbook or double-promote            | PostgreSQL              | PostgreSQL backup           |
| Event cache and rate-limit acceleration | may degrade safely                          | not Redis               | PostgreSQL / expiry         |
| SSE and WebSocket fan-out               | may reconnect or temporarily degrade        | not Redis               | PostgreSQL replay/history   |
| Search                                  | may return an explicit unavailable response | not Elasticsearch/Kafka | PostgreSQL reindex          |
| Async search projection                 | may lag, must catch up                      | not Kafka/Elasticsearch | outbox + PostgreSQL reindex |

Initial learning objectives, not contractual production promises:

```text
core API availability target:        99.5% per 30 days
core HTTP p95 latency target:         < 500 ms excluding streams
core HTTP server error target:        < 1% over 15 minutes
reservation invariant target:        zero violations
oldest unpublished outbox target:    < 60 seconds
search projection freshness target:  < 5 minutes
restore-time objective (RTO):         2 hours
restore-point objective (RPO):        24 hours initially
```

Do not alert on an aspirational percentage before the metric and traffic volume
make it meaningful. In a low-traffic pet project, synthetic checks, backlog
age, and invariant failures are often more useful than percentile alerts.

---

## Checkpoint 1: Record the Phase 6 baseline and operational inventory

### Reason

A release process cannot distinguish a regression from an existing failure
without a baseline. The inventory also prevents a production Compose file from
silently omitting a worker, volume, environment value, or shutdown requirement.

### Implementation

Record:

```text
date and Git commit:
Node and Yarn versions:
Prisma migration status:
tests passed:
runtime image digest and size:
services and container roles:
named volumes and authoritative data:
host-bound ports:
current readiness dependencies:
shutdown timeout for HTTP, SSE, WebSockets, and workers:
PostgreSQL combined connection budget:
Redis / Kafka / Elasticsearch outage behavior:
current backup location and most recent verified restore:
```

Classify every environment variable as one of:

```text
public configuration | secret | build metadata | operational tuning
```

Build metadata such as `APP_REVISION` and `APP_IMAGE_DIGEST` is injected by the
release process. Secrets remain on the target host or in the target
environment; they are never baked into an image or copied into a CI artifact.

Create `docs/phase7-baseline.md` from this **complete file** and fill it with
the command output from this checkpoint:

```markdown
# Phase 7 baseline

## Revision

- Recorded at (UTC):
- Git commit:
- Node version:
- Yarn version:
- Docker version:
- Docker Compose version:

## Quality gate

- Prisma generate:
- Prisma validate:
- Typecheck:
- Lint:
- Format check:
- Tests:
- Build:

## Runtime image

- Image reference:
- Image ID/digest:
- Size:
- Uncached build duration:
- Cached build duration:
- Runs as UID/GID:
- Root filesystem read-only check:

## Process roles

| Role             | Command                                           | Readiness/liveness              | Graceful-stop bound |
| ---------------- | ------------------------------------------------- | ------------------------------- | ------------------- |
| HTTP API         | `node dist/server.js`                             | `/health/live`, `/health/ready` | 10 seconds          |
| Outbox publisher | `node dist/workers/outbox-publisher.js`           | logs/metrics                    | bounded batch       |
| Search consumer  | `node dist/workers/search-projection-consumer.js` | logs/metrics                    | Kafka stop          |
| Search reindex   | `node dist/workers/search-reindex.js`             | one-shot result                 | command timeout     |

## Data ownership

| System        | State                                          | Authoritative? | Recovery                            |
| ------------- | ---------------------------------------------- | -------------- | ----------------------------------- |
| PostgreSQL    | users, events, reservations, waitlists, outbox | yes            | verified backup restore             |
| Redis         | cache, limits, presence, tickets, Pub/Sub      | no             | clear/rebuild/expire                |
| Kafka         | asynchronous transport                         | no             | outbox replay or projection rebuild |
| Elasticsearch | event-search projection                        | no             | PostgreSQL reindex                  |

## Port inventory

| Port | Bind address | Purpose             | Public? |
| ---- | ------------ | ------------------- | ------- |
| 3000 | 127.0.0.1    | current local API   | no      |
| 5432 | 127.0.0.1    | local PostgreSQL    | no      |
| 6379 | 127.0.0.1    | local Redis         | no      |
| 9092 | 127.0.0.1    | local Kafka         | no      |
| 9200 | 127.0.0.1    | local Elasticsearch | no      |

## Recovery baseline

- Backup destination:
- Most recent backup UTC:
- Most recent successful restore UTC:
- Measured RPO:
- Measured RTO:
- Known gaps:
```

Use this **complete PowerShell collector** as
`scripts/phase7-record-baseline.ps1`. It prints safe metadata only; copy the
result into the template after reviewing it:

```powershell
$ErrorActionPreference = 'Stop'

Write-Output "recorded_at_utc=$([DateTime]::UtcNow.ToString('O'))"
Write-Output "git_commit=$(git rev-parse HEAD)"
Write-Output "node_version=$(node --version)"
Write-Output "yarn_version=$(yarn --version)"
Write-Output "docker_version=$(docker version --format '{{.Server.Version}}')"
Write-Output "compose_version=$(docker compose version --short)"

yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn build

docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose build app
docker compose images
```

### Verification

```powershell
yarn install --frozen-lockfile
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn build

docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose build app
docker compose images
docker image inspect gatherly-backend-app
```

Also inspect `docker compose config` for expanded secrets before saving or
sharing its output. A merged Compose configuration can contain sensitive
values.

### Exit evidence

The baseline is reproducible and every process role, durable volume, host port,
and readiness dependency has an owner.

---

## Checkpoint 2: Make production logs structured, safe, and correlated

### Reason

The server currently creates a Pino logger in `src/server.ts`, while production
HTTP access logging is disabled and request IDs are response-only. Phase 7
needs one logger factory, a request context, production request completion
logs, trace correlation, and a stronger redaction contract.

### Implementation

Refactor logging beneath `src/shared/logging/`:

```text
logger.ts                   create the configured root logger
request-context.ts          AsyncLocalStorage for request/trace/user context
request-id.middleware.ts    accept a trusted-format ID or create one
http-logger.middleware.ts   one completion log per ordinary HTTP request
audit-logger.ts             append-oriented sensitive-action event shape
```

Use stable keys:

```text
timestamp, level, message, service, environment, version
requestId, traceId, spanId, method, route, statusCode, durationMs
userId, communityId, eventId
error.type, error.message, error.stack
```

Identifiers are included only where they help investigation. Do not attach
unbounded request bodies, query strings, chat content, profile text, search
terms, tokens, cookies, invitation codes, passwords, password hashes, or raw
Kafka messages.

Redact at least:

```text
req.headers.authorization
req.headers.cookie
res.headers.set-cookie
authorization
cookie
set-cookie
password
passwordHash
token
accessToken
refreshToken
ticket
invitationCode
```

Treat client request IDs as untrusted. Either always generate a UUID or accept
only a bounded UUID/trace-compatible value from the trusted Nginx boundary.
Return the chosen value in `x-request-id`.

Production HTTP logs should be emitted by Pino rather than Morgan. Keep Morgan
as the readable development lesson. Exclude or sample successful `/health/live`
and `/metrics` requests so probes do not bury useful traffic.

Add audit events for existing sensitive actions such as membership role/status
changes, event cancellation, organizer reservation removal, and moderation.
An audit event records actor, target, action, result, and safe reason code; it
does not record private content or credentials.

Pino is the operational copy of an audit event, not its only durable owner. If
an action requires a durable security audit trail, write a minimal
append-oriented audit record in the same PostgreSQL transaction as the action
or through the existing transactional-outbox boundary. A remote log backend
must never decide whether the business transaction succeeds.

Configure Docker log rotation for every production service:

```yaml
logging:
  driver: json-file
  options:
    max-size: '10m'
    max-file: '5'
```

This bounds local disk use. It is retention, not an off-host audit archive.

Add these implementation files.

`src/shared/logging/request-context.ts` (**complete file**):

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(requestContext: RequestContext, callback: () => T): T =>
  requestContextStorage.run(requestContext, callback);

export const getRequestContext = (): RequestContext | undefined => requestContextStorage.getStore();
```

`src/shared/logging/logger.ts` (**complete file**, replacing the current
Morgan-only file):

```ts
import { context, trace } from '@opentelemetry/api';
import type { RequestHandler } from 'express';
import morgan from 'morgan';
import pino, { type DestinationStream, type Logger } from 'pino';

import { getRequestContext } from './request-context.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  'request.headers.authorization',
  'request.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.ticket',
  '*.invitationCode',
];

export const createLogger = (
  input: NodeJS.ProcessEnv = process.env,
  destination?: DestinationStream,
): Logger => {
  const options: pino.LoggerOptions = {
    level: input['LOG_LEVEL'] ?? (input['NODE_ENV'] === 'production' ? 'info' : 'debug'),
    base: {
      service: input['OTEL_SERVICE_NAME'] ?? 'gatherly-api',
      environment: input['DEPLOYMENT_ENVIRONMENT'] ?? input['NODE_ENV'] ?? 'development',
      version: input['APP_REVISION'] ?? 'development',
      slot: input['DEPLOYMENT_SLOT'] ?? 'local',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    mixin: () => {
      const requestContext = getRequestContext();
      const spanContext = trace.getSpan(context.active())?.spanContext();

      return {
        ...(requestContext === undefined ? {} : { requestId: requestContext.requestId }),
        ...(spanContext === undefined
          ? {}
          : { traceId: spanContext.traceId, spanId: spanContext.spanId }),
      };
    },
    ...(input['NODE_ENV'] === 'development' && destination === undefined
      ? { transport: { target: 'pino-pretty' } }
      : {}),
  };

  return destination === undefined ? pino(options) : pino(options, destination);
};

morgan.token('request-id', (_request, response) => {
  const value = response.getHeader('x-request-id');
  return typeof value === 'string' ? value : '-';
});

morgan.token('trace-id', (_request, response) => {
  const value = response.getHeader('x-trace-id');
  return typeof value === 'string' ? value : '-';
});

export const createDevelopmentHttpLogger = (): RequestHandler =>
  morgan(':method :url :status :response-time ms request=:request-id trace=:trace-id');
```

`src/shared/logging/request-id.middleware.ts` (**complete file**):

```ts
import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

import { runWithRequestContext } from './request-context.js';

const trustedRequestId =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export const requestIdMiddleware: RequestHandler = (request, response, next) => {
  const forwarded = request.get('x-request-id');
  const requestId =
    forwarded !== undefined && trustedRequestId.test(forwarded) ? forwarded : randomUUID();

  response.locals['requestId'] = requestId;
  response.setHeader('x-request-id', requestId);
  runWithRequestContext({ requestId }, next);
};
```

`src/shared/logging/trace-id.middleware.ts` (**complete file**):

```ts
import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import type { RequestHandler } from 'express';

export const traceIdMiddleware: RequestHandler = (_request, response, next) => {
  const spanContext = trace.getSpan(context.active())?.spanContext();

  if (spanContext !== undefined && isSpanContextValid(spanContext)) {
    response.locals['traceId'] = spanContext.traceId;
    response.setHeader('x-trace-id', spanContext.traceId);
  }

  next();
};
```

`src/shared/logging/http-logger.middleware.ts` (**complete file**):

```ts
import { performance } from 'node:perf_hooks';

import type { Request, RequestHandler } from 'express';
import type { Logger } from 'pino';

const routeTemplate = (request: Request): string => {
  const route = request.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string' ? `${request.baseUrl}${route.path}` : 'unmatched';
};

const shouldSkip = (request: Request): boolean =>
  request.path === '/health/live' || request.path === '/metrics';

export const createProductionHttpLogger =
  (logger: Logger): RequestHandler =>
  (request, response, next) => {
    if (shouldSkip(request)) {
      next();
      return;
    }

    const startedAt = performance.now();
    response.once('finish', () => {
      const requestId: unknown = response.locals['requestId'];
      const traceId: unknown = response.locals['traceId'];
      const statusClass = `${String(Math.floor(response.statusCode / 100))}xx`;
      const fields = {
        ...(typeof requestId === 'string' ? { requestId } : {}),
        ...(typeof traceId === 'string' ? { traceId } : {}),
        method: request.method,
        route: routeTemplate(request),
        statusCode: response.statusCode,
        statusClass,
        durationMs: Number((performance.now() - startedAt).toFixed(3)),
      };

      if (response.statusCode >= 500) logger.error(fields, 'HTTP request completed');
      else if (response.statusCode >= 400) logger.warn(fields, 'HTTP request completed');
      else logger.info(fields, 'HTTP request completed');
    });

    next();
  };
```

`src/shared/logging/audit-logger.ts` (**complete file**):

```ts
import type { Logger } from 'pino';

export interface AuditEvent {
  action: string;
  actorUserId: string;
  targetType: 'community' | 'event' | 'membership' | 'reservation';
  targetId: string;
  communityId?: string;
  eventId?: string;
  result: 'allowed' | 'denied' | 'completed';
  reasonCode?: string;
}

export const logAuditEvent = (logger: Logger, event: AuditEvent): void => {
  logger.info({ audit: event }, 'Security-sensitive action');
};
```

Make these exact edits in `src/app.ts`:

```diff
 import { createDevelopmentHttpLogger } from './shared/logging/logger.js';
+import { createProductionHttpLogger } from './shared/logging/http-logger.middleware.js';
 import { requestIdMiddleware } from './shared/logging/request-id.middleware.js';
+import { traceIdMiddleware } from './shared/logging/trace-id.middleware.js';
@@
-  app.use(cors({ origin: dependencies.corsOrigin }));
+  app.use(
+    cors({
+      origin: dependencies.corsOrigin,
+      exposedHeaders: ['x-request-id', 'x-trace-id'],
+    }),
+  );
   app.use(requestIdMiddleware);
+  app.use(traceIdMiddleware);
@@
  if (dependencies.enableHttpLogging) app.use(createDevelopmentHttpLogger());
+  else app.use(createProductionHttpLogger(dependencies.logger));
```

Make these exact edits in `src/server.ts`:

```diff
-import pino from 'pino';
+import { createLogger } from './shared/logging/logger.js';
@@
-const pinoConfig = { /* existing inline configuration */ };
-const logger = pino(/* existing options */);
+const logger = createLogger();
```

Delete the complete old inline `pinoConfig` block when applying the second
diff. Do not leave two logger configurations.

`tests/unit/logging.test.ts` (**complete file**):

```ts
import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/shared/logging/logger.js';
import { runWithRequestContext } from '../../src/shared/logging/request-context.js';

describe('production logging', () => {
  it('correlates request IDs and redacts credentials', () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write: (line) => {
        lines.push(line);
      },
    };
    const logger = createLogger(
      { NODE_ENV: 'test', OTEL_SERVICE_NAME: 'gatherly-test' },
      destination,
    );

    runWithRequestContext({ requestId: '0f6a5ba4-ff26-47a1-8bf0-a52f03125f64' }, () => {
      logger.info(
        {
          password: 'do-not-log',
          req: { headers: { authorization: 'Bearer secret', cookie: 'sid=secret' } },
        },
        'test record',
      );
    });

    const record = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(record['requestId']).toBe('0f6a5ba4-ff26-47a1-8bf0-a52f03125f64');
    expect(JSON.stringify(record)).not.toContain('do-not-log');
    expect(JSON.stringify(record)).not.toContain('Bearer secret');
    expect(JSON.stringify(record)).not.toContain('sid=secret');
  });
});
```

### Verification

- Make successful, validation-failing, unauthorized, and server-error requests.
- Confirm each response request ID matches the completion log.
- Confirm an active trace adds `traceId` and `spanId` to correlated Pino logs.
- Submit passwords, bearer tokens, cookies, WebSocket tickets, and private chat
  text in a disposable test environment and prove none appears in captured logs.
- Confirm health probes do not create high-volume noise.
- Run a sensitive membership change and inspect its audit event.

Add tests for redaction and stable log keys. Assert absence of secrets, not the
entire Pino JSON serialization.

### Exit evidence

Given a request ID from an error response, an operator can find the request,
its trace, safe domain identifiers, outcome, and associated error without
finding a secret or private message.

---

## Checkpoint 3: Expose bounded application and business metrics

### Reason

Logs explain individual events. Metrics expose rates, latency, saturation, and
backlog trends. Instrumenting everything creates cardinality and cost problems,
so begin with questions an operator must answer.

### Implementation

Add a Prometheus-format registry and expose `GET /metrics` on an internal-only
listener or protect it at the network boundary. The public Nginx site must not
proxy `/metrics`.

If using `prom-client`, add it with Yarn Classic and commit the lockfile:

```powershell
yarn add prom-client
```

This handbook uses Prometheus scrape metrics and OpenTelemetry traces. Do not
also export the same metric instruments through OTLP, or every series will be
reported twice. Remove an unused deferred metrics exporter when implementing
the final pipeline, or document a single non-duplicating reason to retain it.

Keep metric definitions in `src/infrastructure/observability/metrics.ts` and
middleware in `src/infrastructure/observability/http-metrics.middleware.ts`.
Make worker metric ownership explicit if workers expose separate internal
ports; do not merge independent in-process registries by pretending they are
one process.

Start with:

```text
gatherly_http_requests_total{method,route,status_class}
gatherly_http_request_duration_seconds{method,route,status_class}
gatherly_http_in_flight_requests
gatherly_process_event_loop_lag_seconds

gatherly_pg_pool_connections{state,pool}
gatherly_pg_pool_waiting_requests{pool}
gatherly_reservation_conflicts_total{reason}
gatherly_waitlist_promotions_total{result}
gatherly_idempotency_replays_total{operation}

gatherly_redis_operations_total{operation,result}
gatherly_cache_requests_total{cache,result}
gatherly_sse_connections
gatherly_websocket_connections
gatherly_websocket_disconnects_total{reason}

gatherly_outbox_unpublished
gatherly_outbox_oldest_unpublished_age_seconds
gatherly_outbox_publish_total{result}
gatherly_outbox_publish_delay_seconds
gatherly_kafka_consumer_records_total{result}
gatherly_kafka_consumer_lag{topic,partition}
gatherly_dead_letter_records_total{reason}

gatherly_search_projection_total{operation,result}
gatherly_search_projection_last_success_timestamp_seconds
gatherly_search_reconciliation_drift{kind}
```

Metric rules:

- Use normalized Express route templates, never raw URLs or UUIDs.
- Never label by user, community, event, request, trace, error message, search
  term, Kafka event ID, or idempotency key.
- Keep status as a class (`2xx`, `4xx`, `5xx`) unless exact codes answer a
  defined question.
- Counters only increase; gauges represent current state; histograms use
  buckets chosen from measured latency.
- A reservation conflict is a business outcome, not automatically a server
  error.
- Compute outbox age and reconciliation drift with bounded queries outside the
  hot request path.

The existing readiness rule remains:

```text
/health/live  process can answer HTTP
/health/ready process is accepting work and PostgreSQL is usable
```

Redis, Kafka, and Elasticsearch stay out of general readiness. Publish their
state as metrics and capability-specific responses instead.

Install the scrape client:

```powershell
yarn add prom-client
```

Create `src/infrastructure/observability/metrics.ts` (**complete file**):

```ts
import type { RequestHandler } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface ApplicationMetrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status_class'>;
  httpDuration: Histogram<'method' | 'route' | 'status_class'>;
  httpInFlight: Gauge;
  reservationConflicts: Counter<'reason'>;
  waitlistPromotions: Counter<'result'>;
  idempotencyReplays: Counter<'operation'>;
  sseConnections: Gauge;
  websocketConnections: Gauge;
  outboxPublished: Counter<'result'>;
  outboxUnpublished: Gauge;
  outboxOldestAge: Gauge;
  projectionResults: Counter<'operation' | 'result'>;
  projectionLastSuccess: Gauge;
  reconciliationDrift: Gauge<'kind'>;
}

export const createApplicationMetrics = (): ApplicationMetrics => {
  const registry = new Registry();
  registry.setDefaultLabels({
    service: process.env['OTEL_SERVICE_NAME'] ?? 'gatherly-api',
    environment: process.env['DEPLOYMENT_ENVIRONMENT'] ?? 'development',
    slot: process.env['DEPLOYMENT_SLOT'] ?? 'local',
    version: process.env['APP_REVISION'] ?? 'development',
  });
  collectDefaultMetrics({ register: registry, prefix: 'gatherly_nodejs_' });

  const registers = [registry];
  return {
    registry,
    httpRequests: new Counter({
      name: 'gatherly_http_requests_total',
      help: 'Completed HTTP requests',
      labelNames: ['method', 'route', 'status_class'],
      registers,
    }),
    httpDuration: new Histogram({
      name: 'gatherly_http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status_class'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    }),
    httpInFlight: new Gauge({
      name: 'gatherly_http_in_flight_requests',
      help: 'HTTP requests currently executing',
      registers,
    }),
    reservationConflicts: new Counter({
      name: 'gatherly_reservation_conflicts_total',
      help: 'Reservation conflicts by stable reason',
      labelNames: ['reason'],
      registers,
    }),
    waitlistPromotions: new Counter({
      name: 'gatherly_waitlist_promotions_total',
      help: 'Waitlist promotion outcomes',
      labelNames: ['result'],
      registers,
    }),
    idempotencyReplays: new Counter({
      name: 'gatherly_idempotency_replays_total',
      help: 'Idempotent mutation replays',
      labelNames: ['operation'],
      registers,
    }),
    sseConnections: new Gauge({
      name: 'gatherly_sse_connections',
      help: 'Open SSE connections',
      registers,
    }),
    websocketConnections: new Gauge({
      name: 'gatherly_websocket_connections',
      help: 'Open WebSocket connections',
      registers,
    }),
    outboxPublished: new Counter({
      name: 'gatherly_outbox_publish_total',
      help: 'Outbox publication outcomes',
      labelNames: ['result'],
      registers,
    }),
    outboxUnpublished: new Gauge({
      name: 'gatherly_outbox_unpublished',
      help: 'Current unpublished outbox rows',
      registers,
    }),
    outboxOldestAge: new Gauge({
      name: 'gatherly_outbox_oldest_unpublished_age_seconds',
      help: 'Age of the oldest unpublished outbox row',
      registers,
    }),
    projectionResults: new Counter({
      name: 'gatherly_search_projection_total',
      help: 'Search projection outcomes',
      labelNames: ['operation', 'result'],
      registers,
    }),
    projectionLastSuccess: new Gauge({
      name: 'gatherly_search_projection_last_success_timestamp_seconds',
      help: 'Unix time of the last successful search projection',
      registers,
    }),
    reconciliationDrift: new Gauge({
      name: 'gatherly_search_reconciliation_drift',
      help: 'Search reconciliation drift by kind',
      labelNames: ['kind'],
      registers,
    }),
  };
};

const routeTemplate = (request: Parameters<RequestHandler>[0]): string => {
  const route = request.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string' ? `${request.baseUrl}${route.path}` : 'unmatched';
};

export const createHttpMetricsMiddleware =
  (metrics: ApplicationMetrics): RequestHandler =>
  (request, response, next) => {
    if (request.path === '/metrics') {
      next();
      return;
    }

    metrics.httpInFlight.inc();
    const stopTimer = metrics.httpDuration.startTimer();
    response.once('finish', () => {
      const labels = {
        method: request.method,
        route: routeTemplate(request),
        status_class: `${Math.floor(response.statusCode / 100)}xx`,
      };
      metrics.httpInFlight.dec();
      metrics.httpRequests.inc(labels);
      stopTimer(labels);
    });
    next();
  };

export const createMetricsHandler =
  (metrics: ApplicationMetrics): RequestHandler =>
  (_request, response, next) => {
    void metrics.registry
      .metrics()
      .then((body) => {
        response.type(metrics.registry.contentType).send(body);
      })
      .catch(next);
  };
```

Create `src/infrastructure/observability/internal-metrics-server.ts`
(**complete file**) for worker roles:

```ts
import { createServer, type Server } from 'node:http';

import type { Logger } from 'pino';

import type { ApplicationMetrics } from './metrics.js';

export const startInternalMetricsServer = (
  metrics: ApplicationMetrics,
  port: number,
  logger: Logger,
): Server => {
  const server = createServer((request, response) => {
    if (request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }

    void metrics.registry
      .metrics()
      .then((body) => {
        response.writeHead(200, { 'content-type': metrics.registry.contentType });
        response.end(body);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Could not render worker metrics');
        response.writeHead(500).end();
      });
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Internal metrics server started');
  });
  return server;
};
```

Wire the metrics server into `src/workers/outbox-publisher.ts` with these exact
edits:

```diff
+import { createApplicationMetrics } from '../infrastructure/observability/metrics.js';
+import { startInternalMetricsServer } from '../infrastructure/observability/internal-metrics-server.js';
@@
 const logger = createLogger();
+const metrics = createApplicationMetrics();
+const metricsServer = startInternalMetricsServer(
+  metrics,
+  Number(process.env['METRICS_PORT'] ?? 9464),
+  logger,
+);
@@
 } finally {
   await Promise.allSettled([producer.disconnect(), prisma.$disconnect()]);
+  await new Promise<void>((resolvePromise) => metricsServer.close(() => resolvePromise()));
   logger.info('Outbox publisher stopped');
 }
```

KafkaJS `consumer.run()` resolves after its runner starts; it does not represent
the lifetime of the consumer. Create
`src/workers/kafka-consumer-lifetime.ts` (**complete file**) so a worker waits
for operator shutdown or an unrecoverable consumer crash:

```ts
import type { Consumer, ConsumerCrashEvent } from 'kafkajs';

type LifetimeConsumer = Pick<Consumer, 'events' | 'on'>;

export interface KafkaConsumerLifetime {
  completion: Promise<void>;
  complete: () => void;
  dispose: () => void;
}

export const createKafkaConsumerLifetime = (
  consumer: LifetimeConsumer,
  onRestartingCrash: (error: Error) => void,
): KafkaConsumerLifetime => {
  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;

  const completion = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = rejectPromise;
  });
  void completion.catch(() => undefined);

  const complete = (): void => {
    if (settled) return;
    settled = true;
    resolveCompletion();
  };

  const removeCrashListener = consumer.on(
    consumer.events.CRASH,
    (event: ConsumerCrashEvent): void => {
      if (event.payload.restart) {
        onRestartingCrash(event.payload.error);
        return;
      }
      if (settled) return;
      settled = true;
      rejectCompletion(event.payload.error);
    },
  );

  return { completion, complete, dispose: removeCrashListener };
};
```

Replace `src/workers/search-projection-consumer.ts` with this complete file.
The worker exposes its private metrics endpoint on port `9465` by default:

```ts
import 'dotenv/config';

import { parseSearchConsumerEnvironment } from '../config/kafka-worker-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { EventSearchIndex } from '../infrastructure/elasticsearch/event-search-index.js';
import { createKafkaClient } from '../infrastructure/kafka/client.js';
import { publishDeadLetter } from '../infrastructure/kafka/dead-letter.js';
import { ProcessedEventsRepository } from '../infrastructure/kafka/processed-events.repository.js';
import { startInternalMetricsServer } from '../infrastructure/observability/internal-metrics-server.js';
import { createApplicationMetrics } from '../infrastructure/observability/metrics.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { EventSearchProjector } from '../modules/search/event-search-projector.js';
import { EventSearchSourceRepository } from '../modules/search/event-search-source.repository.js';
import {
  PoisonKafkaRecordError,
  SearchProjectionConsumer,
} from '../modules/search/search-projection-consumer.js';
import { createLogger } from '../shared/logging/logger.js';
import { createKafkaConsumerLifetime } from './kafka-consumer-lifetime.js';

const logger = createLogger();
const environment = parseSearchConsumerEnvironment(process.env);
const metrics = createApplicationMetrics();
const metricsServer = startInternalMetricsServer(
  metrics,
  Number(process.env['METRICS_PORT'] ?? 9465),
  logger,
);

const prisma = createPrismaClient(environment);
const elasticsearch = createElasticsearchClient(environment, logger);
const kafka = createKafkaClient(environment, 'search-consumer');
const consumer = kafka.consumer({
  groupId: environment.KAFKA_SEARCH_GROUP_ID,
  allowAutoTopicCreation: false,
  sessionTimeout: 30_000,
  heartbeatInterval: 3_000,
});
const deadLetterProducer = kafka.producer({
  allowAutoTopicCreation: false,
  idempotent: true,
  maxInFlightRequests: 5,
});

const source = new EventSearchSourceRepository(prisma);
const index = new EventSearchIndex(elasticsearch, environment.ELASTICSEARCH_INDEX_PREFIX, logger);
const handler = new SearchProjectionConsumer(
  environment.KAFKA_SEARCH_GROUP_ID,
  new ProcessedEventsRepository(prisma),
  new EventSearchProjector(source, index),
);
const lifetime = createKafkaConsumerLifetime(consumer, (error) => {
  logger.warn({ err: error }, 'Kafka consumer crashed and will restart');
});

const shutdownController = new AbortController();

const stopConsumer = async (): Promise<void> => {
  try {
    await consumer.stop();
  } catch (error) {
    logger.error({ err: error }, 'Could not stop Kafka consumer cleanly');
    process.exitCode = 1;
  } finally {
    lifetime.complete();
  }
};

const requestShutdown = (signal: NodeJS.Signals): void => {
  if (shutdownController.signal.aborted) return;

  shutdownController.abort(signal);
  logger.info({ signal }, 'Search projection consumer shutdown requested');
  void stopConsumer();
};

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

try {
  await Promise.all([consumer.connect(), deadLetterProducer.connect()]);
  await consumer.subscribe({
    topic: environment.KAFKA_DOMAIN_EVENTS_TOPIC,
    fromBeginning: true,
  });

  logger.info({ groupId: environment.KAFKA_SEARCH_GROUP_ID }, 'Search projection consumer started');

  await consumer.run({
    partitionsConsumedConcurrently: 2,
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const outcome = await handler.handle({
          topic,
          partition,
          offset: message.offset,
          message,
        });

        metrics.projectionResults.inc({ operation: 'consume', result: outcome });
        if (outcome === 'indexed' || outcome === 'deleted') {
          metrics.projectionLastSuccess.set(Date.now() / 1_000);
        }

        logger.debug({ topic, partition, offset: message.offset, outcome }, 'Domain event handled');
      } catch (error) {
        if (!(error instanceof PoisonKafkaRecordError)) {
          metrics.projectionResults.inc({ operation: 'consume', result: 'failure' });
          throw error;
        }

        await publishDeadLetter(
          deadLetterProducer,
          environment.KAFKA_DEAD_LETTER_TOPIC,
          { topic, partition, message },
          error.message,
          environment.KAFKA_REQUEST_TIMEOUT_MS,
        );
        metrics.projectionResults.inc({
          operation: 'consume',
          result: 'dead_letter',
        });

        logger.warn(
          { topic, partition, offset: message.offset, reason: error.message },
          'Domain event moved to dead-letter topic',
        );
      }
    },
  });

  if (shutdownController.signal.aborted) await stopConsumer();
  await lifetime.completion;
} catch (error) {
  logger.error({ err: error }, 'Search projection consumer stopped unexpectedly');
  process.exitCode = 1;
} finally {
  process.off('SIGINT', requestShutdown);
  process.off('SIGTERM', requestShutdown);
  lifetime.dispose();
  await Promise.allSettled([
    consumer.disconnect(),
    deadLetterProducer.disconnect(),
    prisma.$disconnect(),
    closeElasticsearchClient(elasticsearch),
  ]);
  await new Promise<void>((resolvePromise) => {
    metricsServer.close(() => resolvePromise());
  });
  logger.info('Search projection consumer stopped');
}
```

Record `dead_letter` only after `publishDeadLetter` succeeds. If publishing to
the dead-letter topic fails, the error must escape so Kafka does not treat the
source record as successfully handled. Transient handler failures are counted
as `failure` and then rethrown for Kafka's retry behavior.

Add a unit test proving the lifetime remains pending after `consumer.run()`
starts, remains pending for a crash KafkaJS will restart, rejects for a crash
KafkaJS cannot restart, and removes the instrumentation listener on disposal.

Add `METRICS_PORT=9464` to the outbox-publisher environment and
`METRICS_PORT=9465` to the search-consumer environment in the production
Compose sample. These ports stay on the private Compose network and are not
published to the host.

Make these exact edits in `src/app.ts`:

```diff
+import type { ApplicationMetrics } from './infrastructure/observability/metrics.js';
+import {
+  createHttpMetricsMiddleware,
+  createMetricsHandler,
+} from './infrastructure/observability/metrics.js';
@@
 export interface AppDependencies {
+  metrics?: ApplicationMetrics;
@@
   app.use(express.json({ limit: '1mb' }));
+
+  if (dependencies.metrics !== undefined) {
+    app.get('/metrics', createMetricsHandler(dependencies.metrics));
+    app.use(createHttpMetricsMiddleware(dependencies.metrics));
+  }
```

Make these exact edits in `src/server.ts`:

```diff
+import { createApplicationMetrics } from './infrastructure/observability/metrics.js';
@@
 const logger = createLogger();
+const metrics = createApplicationMetrics();
@@
 const app = createApp({
+  metrics,
```

At stable domain outcome branches, record metrics explicitly. For example:

```ts
metrics.reservationConflicts.inc({ reason: 'capacity_full' });
metrics.idempotencyReplays.inc({ operation: 'reservation_create' });
metrics.waitlistPromotions.inc({ result: 'promoted' });
```

Pass the metrics object into services through constructor dependencies; do not
import a global registry from domain services.

Create `tests/unit/metrics.test.ts` (**complete file**):

```ts
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  createApplicationMetrics,
  createHttpMetricsMiddleware,
  createMetricsHandler,
} from '../../src/infrastructure/observability/metrics.js';

describe('application metrics', () => {
  it('uses the route template instead of a resource ID', async () => {
    const metrics = createApplicationMetrics();
    const app = express();
    app.use(createHttpMetricsMiddleware(metrics));
    app.get('/events/:eventId', (_request, response) => response.sendStatus(204));
    app.get('/metrics', createMetricsHandler(metrics));

    const eventId = '772a6b84-1ad6-49b9-9077-f90eb19d5f4c';
    await request(app).get(`/events/${eventId}`).expect(204);
    const response = await request(app).get('/metrics').expect(200);

    expect(response.text).toContain('route="/events/:eventId"');
    expect(response.text).not.toContain(eventId);
  });
});
```

### Verification

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3000/metrics
```

Generate one success, one validation error, one reservation conflict, one SSE
connection, and one WebSocket connection. Confirm values change and that the
number of time series remains bounded when different resource IDs are used.

Add tests that prove raw paths and identifiers never become labels.

### Exit evidence

The metrics endpoint answers operational questions without leaking data or
creating unbounded label cardinality.

---

## Checkpoint 4: Initialize OpenTelemetry before application imports

### Reason

Automatic Node instrumentation patches libraries as they load. Starting the
SDK after Express, `pg`, Redis, KafkaJS, or Elasticsearch imports produces
missing or partial traces. Gatherly uses ESM, so instrumentation startup order
must be proven rather than assumed.

### Implementation

The required OpenTelemetry packages are already installed but intentionally
deferred. Create:

```text
src/instrumentation.ts
src/infrastructure/observability/tracing.ts
```

Configure a `NodeSDK` with:

- service name `gatherly-api`, `gatherly-outbox-publisher`, or
  `gatherly-search-consumer` according to the process role;
- `deployment.environment.name` and application revision resource attributes;
- OTLP/HTTP trace export to the collector;
- parent-based sampling with a configurable ratio in production;
- automatic instrumentation with noisy or unsafe instrumentation disabled;
- Pino instrumentation for trace/log correlation;
- bounded batch export and graceful SDK shutdown.

Load instrumentation before application code. For compiled ESM, follow the
currently supported OpenTelemetry ESM loader/import method and prove Express
and PostgreSQL spans appear. Do not rely on importing `instrumentation.ts` as
the first line of `server.ts` if dependencies are already evaluated first.

Each role must stop its telemetry SDK during graceful shutdown after useful
final logs and spans have been emitted, but within the container stop grace
period.

Add manual spans only where auto-instrumentation cannot express the use case:

```text
reservation.create
reservation.cancel_and_promote
outbox.publish_batch
search_projection.consume
search.reconcile
search.reindex
```

Record stable, non-sensitive attributes such as operation result, conflict
reason, event format, batch size, retry count, or Kafka partition. Do not add
usernames, chat bodies, tokens, raw SQL parameters, or full event documents.

Create `src/instrumentation.ts` (**complete file**):

```ts
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

const enabled = process.env['OTEL_SDK_DISABLED'] !== 'true';

const sdk = enabled
  ? new NodeSDK({
      serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'gatherly-api',
      traceExporter: new OTLPTraceExporter({
        url: process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ?? 'http://127.0.0.1:4318/v1/traces',
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-http': {
            ignoreIncomingRequestHook: (request) =>
              request.url === '/health/live' || request.url === '/metrics',
          },
        }),
      ],
    })
  : undefined;

sdk?.start();

export const shutdownTelemetry = async (): Promise<void> => {
  await sdk?.shutdown();
};
```

Create `src/infrastructure/observability/tracing.ts` (**complete file**):

```ts
import { SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('gatherly-domain');

export const withSpan = async <T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  operation: () => Promise<T>,
): Promise<T> =>
  tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      if (error instanceof Error) span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
```

Wrap only a use-case boundary, not every helper. This is the complete shape to
use inside a service method:

```ts
return withSpan(
  'reservation.cancel_and_promote',
  { 'gatherly.operation': 'cancel_and_promote' },
  () => this.repository.cancelAndPromote(input),
);
```

Update the relevant `package.json` scripts exactly as follows. Keep the other
scripts unchanged:

```json
{
  "scripts": {
    "dev": "tsx watch --import ./src/instrumentation.ts src/server.ts",
    "start": "node --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import ./dist/instrumentation.js dist/server.js",
    "kafka:outbox:prod": "node --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import ./dist/instrumentation.js dist/workers/outbox-publisher.js",
    "kafka:search-consumer:prod": "node --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import ./dist/instrumentation.js dist/workers/search-projection-consumer.js"
  }
}
```

Do not replace the complete `scripts` object with this abbreviated block; edit
only the four values.

In `src/server.ts`, import and shut down telemetry after application
dependencies close:

```diff
+import { shutdownTelemetry } from './instrumentation.js';
@@
   closeDependencies: async () => {
     await Promise.all([
       /* existing dependency close promises */
     ]);
+    await shutdownTelemetry();
   },
```

Use the same `shutdownTelemetry()` call in the `finally` block of both worker
entrypoints after their dependency disconnects. Because the process command
preloads `instrumentation.js`, importing it from the entrypoint returns the
already-started module rather than initializing a second SDK.

Add these values to `.env.example`:

```dotenv
# OpenTelemetry
OTEL_SDK_DISABLED=false
OTEL_SERVICE_NAME=gatherly-api
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=1.0
DEPLOYMENT_ENVIRONMENT=development
APP_REVISION=development
DEPLOYMENT_SLOT=local
```

### Verification

- Start the collector and Tempo before the application.
- Exercise one HTTP request that queries PostgreSQL and one cached request.
- Inspect a trace rooted at the incoming HTTP span.
- Confirm a Pino record contains the same trace ID.
- Stop the collector and prove the API continues serving; telemetry export is
  never authoritative work.
- Send SIGTERM and confirm the SDK shuts down within the existing graceful
  shutdown bound.
- Confirm health and metrics traffic is excluded or heavily sampled.

### Exit evidence

One user-visible request can be followed from Nginx request ID through Express
and its important dependency operations, while a collector outage leaves the
business request path correct.

---

## Checkpoint 5: Run a private observability stack

### Reason

Instrumentation without storage and queries is only extra work in the request
path. The smallest useful stack for this phase is Prometheus, Grafana, Tempo,
an OpenTelemetry Collector, and Uptime Kuma.

### Implementation

Create an optional local file such as `compose.observability.yaml` and a
production-only equivalent beneath `deploy/`. Use pinned image versions rather
than floating `latest` tags.

Suggested files:

```text
deploy/observability/otel-collector.yaml
deploy/observability/prometheus.yaml
deploy/observability/tempo.yaml
deploy/observability/grafana/provisioning/datasources.yaml
deploy/observability/grafana/provisioning/dashboards.yaml
deploy/observability/grafana/dashboards/gatherly-overview.json
deploy/observability/alerts/gatherly.rules.yaml
```

Network rules:

- Prometheus scrapes application and worker metric endpoints over a private
  Docker network or loopback binding.
- The OTLP receiver is not exposed to the Internet.
- Grafana and Uptime Kuma bind to loopback and are reached through an SSH
  tunnel, VPN, or separately authenticated Nginx location.
- Tempo, PostgreSQL, Redis, Kafka, Elasticsearch, and Docker never receive
  public host bindings.
- `/metrics` is explicitly denied on the public API virtual host.

Prometheus stores time series on a named volume with finite retention. Tempo
uses a named volume and finite local retention suitable for the learning host.
Grafana dashboards and data sources are provisioned from Git; credentials are
not. Uptime Kuma state is backed up because monitor configuration is useful,
but it is not application business truth.

Set memory, CPU, PID, logging, and restart bounds. Observability components
must not be able to exhaust the host and take the API down. Reserve headroom for
both blue and green HTTP containers during deployment.

Create `compose.observability.yaml` (**complete file**). These are example
pins; verify each image in staging before adopting a newer pin:

```yaml
services:
  app:
    environment:
      OTEL_SDK_DISABLED: 'false'
      OTEL_SERVICE_NAME: gatherly-api
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
    depends_on:
      otel-collector:
        condition: service_started

  outbox-publisher:
    environment:
      OTEL_SDK_DISABLED: 'false'
      OTEL_SERVICE_NAME: gatherly-outbox-publisher
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
    depends_on:
      otel-collector:
        condition: service_started

  search-consumer:
    environment:
      OTEL_SDK_DISABLED: 'false'
      OTEL_SERVICE_NAME: gatherly-search-consumer
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
    depends_on:
      otel-collector:
        condition: service_started

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.135.0
    command: ['--config=/etc/otelcol-contrib/config.yaml']
    expose:
      - '8888'
    volumes:
      - ./deploy/observability/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp:size=32m,mode=1777
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 256m
    pids_limit: 100

  tempo:
    image: grafana/tempo:2.8.2
    command: ['-config.file=/etc/tempo.yaml']
    volumes:
      - ./deploy/observability/tempo.yaml:/etc/tempo.yaml:ro
      - tempo_data:/var/tempo
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 512m
    pids_limit: 200

  prometheus:
    image: prom/prometheus:v3.5.0
    command:
      - --config.file=/etc/prometheus/prometheus.yaml
      - --storage.tsdb.path=/prometheus
      - --storage.tsdb.retention.time=15d
      - --web.enable-lifecycle
    ports:
      - '127.0.0.1:${PROMETHEUS_PORT:-9090}:9090'
    volumes:
      - ./deploy/observability/prometheus.yaml:/etc/prometheus/prometheus.yaml:ro
      - ./deploy/observability/alerts:/etc/prometheus/alerts:ro
      - prometheus_data:/prometheus
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 512m
    pids_limit: 200

  alertmanager:
    image: prom/alertmanager:v0.28.1
    command: ['--config.file=/etc/alertmanager/alertmanager.yaml']
    ports:
      - '127.0.0.1:${ALERTMANAGER_PORT:-9093}:9093'
    volumes:
      - ./deploy/observability/alertmanager.yaml:/etc/alertmanager/alertmanager.yaml:ro
      - alertmanager_data:/alertmanager
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 128m
    pids_limit: 100

  grafana:
    image: grafana/grafana:12.1.0
    environment:
      GF_SECURITY_ADMIN_USER: ${GRAFANA_ADMIN_USER:-admin}
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:?set GRAFANA_ADMIN_PASSWORD}
      GF_USERS_ALLOW_SIGN_UP: 'false'
      GF_SERVER_ROOT_URL: ${GRAFANA_ROOT_URL:-http://127.0.0.1:3001}
    ports:
      - '127.0.0.1:${GRAFANA_PORT:-3001}:3000'
    volumes:
      - ./deploy/observability/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./deploy/observability/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    depends_on:
      - prometheus
      - tempo
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 384m
    pids_limit: 200

  uptime-kuma:
    image: louislam/uptime-kuma:2.0.0
    ports:
      - '127.0.0.1:${UPTIME_KUMA_PORT:-3002}:3001'
    volumes:
      - uptime_kuma_data:/app/data
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    mem_limit: 256m
    pids_limit: 200

volumes:
  tempo_data:
  prometheus_data:
  alertmanager_data:
  grafana_data:
  uptime_kuma_data:
```

Do not add `cap_drop: [ALL]` to the Uptime Kuma service. Its standard image
performs startup ownership preparation for the writable `/app/data` volume;
removing every capability can leave that volume unwritable and cause `EACCES`
errors for `data/upload` and `error.log`. Keep the named volume private and
retain `no-new-privileges:true`. This exception applies to the third-party
Uptime Kuma image, not to Gatherly's application containers.

Create `deploy/observability/otel-collector.yaml` (**complete file**):

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 192
  batch:
    send_batch_size: 512
    timeout: 5s

exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true

service:
  telemetry:
    logs:
      level: info
    metrics:
      readers:
        - pull:
            exporter:
              prometheus:
                host: 0.0.0.0
                port: 8888
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp/tempo]
```

Create `deploy/observability/tempo.yaml` (**complete file**):

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318

ingester:
  max_block_duration: 5m

compactor:
  compaction:
    block_retention: 168h

storage:
  trace:
    backend: local
    wal:
      path: /var/tempo/wal
    local:
      path: /var/tempo/blocks
```

Create `deploy/observability/prometheus.yaml` (**complete file**):

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/alerts/*.yaml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

scrape_configs:
  - job_name: gatherly-api-local
    metrics_path: /metrics
    static_configs:
      - targets: ['app:3000']

  - job_name: gatherly-api-slots
    metrics_path: /metrics
    static_configs:
      - targets: ['app-blue:3000', 'app-green:3000']

  - job_name: gatherly-workers
    metrics_path: /metrics
    static_configs:
      - targets: ['outbox-publisher:9464', 'search-consumer:9465']

  - job_name: otel-collector
    metrics_path: /metrics
    static_configs:
      - targets: ['otel-collector:8888']

  - job_name: prometheus
    static_configs:
      - targets: ['prometheus:9090']
```

Create `deploy/observability/alertmanager.yaml` (**complete local file**):

```yaml
route:
  receiver: local-only
  group_by: [alertname, service]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
  - name: local-only

inhibit_rules:
  - source_matchers: ['severity="critical"']
    target_matchers: ['severity="warning"']
    equal: [alertname, service]
```

This receiver deliberately keeps alerts in the local Alertmanager UI. Replace
it with one reviewed webhook/chat receiver in production; do not commit its
secret URL.

Create
`deploy/observability/grafana/provisioning/datasources/datasources.yaml`
(**complete file**):

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false

  - name: Tempo
    uid: tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    editable: false
    jsonData:
      tracesToMetrics:
        datasourceUid: prometheus
        tags:
          - key: service.name
            value: service
```

Create
`deploy/observability/grafana/provisioning/dashboards/dashboards.yaml`
(**complete file**):

```yaml
apiVersion: 1

providers:
  - name: Gatherly
    folder: Gatherly
    type: file
    disableDeletion: true
    editable: false
    options:
      path: /var/lib/grafana/dashboards
```

Add these environment values to `.env.example`:

```dotenv
# Local-only observability UI ports
PROMETHEUS_PORT=9090
ALERTMANAGER_PORT=9093
GRAFANA_PORT=3001
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=replace-with-a-local-password
GRAFANA_ROOT_URL=http://127.0.0.1:3001
UPTIME_KUMA_PORT=3002
```

### Verification

- Prometheus target status shows only intended internal targets.
- The `otel-collector` Prometheus target is up, and an `otelcol_*` query shows
  accepted, exported, failed, queue, process, and runtime telemetry from the
  Collector itself. Port `8888` remains private to the Compose network.
- Grafana can query one request-rate metric and open a linked trace.
- Tempo receives spans from all enabled process roles.
- Uptime Kuma checks the public TLS `/health/live` endpoint from outside the
  application container network.
- Host firewall inspection proves none of the private ports is public.
- Stop the whole observability stack and prove reservations remain correct.

### Exit evidence

The stack answers queries and can fail independently without changing durable
Gatherly state or core API readiness.

---

## Checkpoint 6: Build dashboards, alerts, and runbook links

### Reason

A dashboard should answer a question; an alert should require action. A large
catalog of default panels and noisy alerts teaches neither.

### Implementation

Create these initial dashboards:

1. **Service overview:** synthetic uptime, request rate, status classes,
   latency, in-flight requests, event-loop lag, restarts, and active revision.
2. **PostgreSQL and reservations:** pool use/waiters, query latency,
   reservation conflicts, idempotency replays, promotions, and invariant
   failures.
3. **Realtime:** active SSE/WebSocket connections, disconnect reasons,
   backpressure closures, Redis failures, and reconnect rate.
4. **Async and search:** outbox count/age, publish results, consumer lag,
   dead letters, projection results, last success, search latency, and drift.
5. **Deployment:** active slot, deployed digest, readiness, error/latency change
   around cutover, worker revision, and last successful deployment timestamp.

Begin with a small alert set:

```text
public liveness check fails repeatedly
core 5xx rate is elevated with sufficient request volume
PostgreSQL pool has sustained waiters or readiness fails
oldest unpublished outbox age exceeds the recovery window
consumer lag or last-success age grows continuously
dead-letter count increases
search reconciliation reports drift
disk free space crosses warning/critical thresholds
backup age exceeds the RPO
TLS certificate expiry approaches the renewal window
container restart loop detected
```

Every alert contains:

```text
summary | impact | likely causes | dashboard | runbook | owner | silence rule
```

Use a separate operator channel such as Uptime Kuma's supported webhook or
chat integration. Do not add email delivery to Gatherly.

Create `deploy/observability/alerts/gatherly.rules.yaml` (**complete file**):

```yaml
groups:
  - name: gatherly-core
    rules:
      - alert: GatherlyApiTargetDown
        expr: sum(up{job=~"gatherly-api.*"}) < 1
        for: 2m
        labels:
          severity: critical
          service: gatherly-api
        annotations:
          summary: Gatherly API metrics target is down
          impact: The process or private metrics path is unavailable.
          runbook: deploy/runbooks/api-target-down.md

      - alert: GatherlyElevatedServerErrors
        expr: |
          sum(rate(gatherly_http_requests_total{status_class="5xx"}[10m]))
          /
          clamp_min(sum(rate(gatherly_http_requests_total[10m])), 0.01)
          > 0.05
        for: 10m
        labels:
          severity: critical
          service: gatherly-api
        annotations:
          summary: More than 5% of Gatherly requests are server errors
          impact: Core API users are receiving failed requests.
          runbook: deploy/runbooks/elevated-http-errors.md

      - alert: GatherlyHighP95Latency
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (rate(gatherly_http_request_duration_seconds_bucket[10m]))
          ) > 0.5
        for: 15m
        labels:
          severity: warning
          service: gatherly-api
        annotations:
          summary: Gatherly p95 HTTP latency exceeds 500 ms
          impact: API responses are slower than the learning objective.
          runbook: deploy/runbooks/high-http-latency.md

  - name: gatherly-async
    rules:
      - alert: GatherlyOutboxStale
        expr: gatherly_outbox_oldest_unpublished_age_seconds > 60
        for: 5m
        labels:
          severity: warning
          service: gatherly-outbox-publisher
        annotations:
          summary: Gatherly outbox publication is stale
          impact: Search projection changes are delayed.
          runbook: deploy/runbooks/outbox-stale.md

      - alert: GatherlySearchProjectionStale
        expr: |
          time() - gatherly_search_projection_last_success_timestamp_seconds > 300
        for: 10m
        labels:
          severity: warning
          service: gatherly-search-consumer
        annotations:
          summary: Search projection has no recent success
          impact: Event discovery may be stale.
          runbook: deploy/runbooks/search-projection-stale.md

      - alert: GatherlySearchProjectionDrift
        expr: sum(gatherly_search_reconciliation_drift) > 0
        for: 5m
        labels:
          severity: warning
          service: gatherly-search
        annotations:
          summary: Elasticsearch differs from PostgreSQL
          impact: Search results are missing, stale, or ineligible.
          runbook: deploy/runbooks/search-drift.md
```

Create `deploy/observability/grafana/dashboards/gatherly-overview.json`
(**complete minimal dashboard**):

```json
{
  "annotations": { "list": [] },
  "editable": false,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 1,
  "links": [],
  "panels": [
    {
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "reqps" }, "overrides": [] },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "id": 1,
      "options": { "legend": { "displayMode": "table", "placement": "bottom" } },
      "targets": [
        {
          "expr": "sum by (status_class) (rate(gatherly_http_requests_total[5m]))",
          "legendFormat": "{{status_class}}",
          "refId": "A"
        }
      ],
      "title": "HTTP request rate",
      "type": "timeseries"
    },
    {
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "s" }, "overrides": [] },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "id": 2,
      "options": { "legend": { "displayMode": "list", "placement": "bottom" } },
      "targets": [
        {
          "expr": "histogram_quantile(0.95, sum by (le) (rate(gatherly_http_request_duration_seconds_bucket[5m])))",
          "legendFormat": "p95",
          "refId": "A"
        }
      ],
      "title": "HTTP latency",
      "type": "timeseries"
    },
    {
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "s" }, "overrides": [] },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "id": 3,
      "options": { "reduceOptions": { "calcs": ["lastNotNull"], "values": false } },
      "targets": [
        {
          "expr": "gatherly_outbox_oldest_unpublished_age_seconds",
          "refId": "A"
        }
      ],
      "title": "Oldest unpublished outbox row",
      "type": "stat"
    },
    {
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": {}, "overrides": [] },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "id": 4,
      "options": { "reduceOptions": { "calcs": ["lastNotNull"], "values": false } },
      "targets": [
        {
          "expr": "sum by (kind) (gatherly_search_reconciliation_drift)",
          "legendFormat": "{{kind}}",
          "refId": "A"
        }
      ],
      "title": "Search projection drift",
      "type": "stat"
    }
  ],
  "refresh": "30s",
  "schemaVersion": 41,
  "tags": ["gatherly"],
  "templating": { "list": [] },
  "time": { "from": "now-6h", "to": "now" },
  "timezone": "browser",
  "title": "Gatherly overview",
  "uid": "gatherly-overview",
  "version": 1
}
```

Create at least the referenced Markdown runbook files beneath
`deploy/runbooks/`. This is the **complete starter file** for
`deploy/runbooks/search-drift.md`; use the same structure for the other alert
links:

```markdown
# Search projection drift

## Impact

Public event search may contain missing, stale, or ineligible documents. Core
PostgreSQL-backed APIs remain available.

## Checks

1. Inspect reconciliation counts by kind.
2. Inspect outbox oldest age and Kafka consumer lag.
3. Check Elasticsearch health and the active read/write aliases.
4. Check dead-letter records without printing payload bodies.

## Recovery

1. Let ordinary backlog recover if lag is decreasing.
2. Repair a poison record deliberately if one blocks progress.
3. Run `yarn search:reindex:prod` only for confirmed drift/index loss.
4. Run reconciliation again and require every drift count to be zero.

## Verification

- Core readiness stayed healthy.
- Search returns only currently eligible events.
- Reconciliation drift is zero.
```

### Verification

Trigger every rule safely in staging. Confirm it fires, reaches the chosen
operator channel, links to the right dashboard/runbook, and resolves after
recovery. Record time-to-detect and time-to-recover.

### Exit evidence

No alert exists without a safe action, and the operator can move from symptom
to relevant logs, metrics, traces, and a tested runbook.

---

## Checkpoint 7: Observe and reconcile the search projection

### Reason

Kafka and an outbox make normal projection delivery recoverable, but they do
not prove Elasticsearch matches eligible PostgreSQL events forever. Cleanup,
operator mistakes, index changes, or lost infrastructure can still create
drift.

### Implementation

Instrument projection attempts, successes, failures, duplicates, ignored
records, dead letters, and last-success time. Add a bounded reconciliation role
that compares PostgreSQL-eligible event IDs/versions with the active
Elasticsearch alias.

The check should report at least:

```text
missing documents
stale-version documents
documents that are no longer eligible
unexpected index/alias state
```

For large data sets, compare deterministic pages or hashes rather than loading
everything into memory. The checker observes and reports; it does not silently
rewrite the index during every schedule.

Repair rules:

- ordinary lag: let the outbox publisher and consumer catch up;
- poison record: inspect the dead-letter record without logging private data,
  fix the cause, and replay deliberately;
- confirmed drift or index loss: run the documented full reindex from
  PostgreSQL;
- search outage: keep core readiness healthy and return the documented search
  capability error.

Create `src/modules/search/search-reconciler.ts` (**complete simple first
implementation**). It intentionally keeps ID/version maps in memory; measure
before replacing it with hash/page reconciliation:

```ts
import type { Client } from '@elastic/elasticsearch';

import { EVENT_SEARCH_READ_ALIAS } from '../../infrastructure/elasticsearch/event-index-definition.js';
import type { EventSearchSourceRepository } from './event-search-source.repository.js';

interface IndexedVersion {
  id: string;
  updatedAt: string;
}

export interface SearchReconciliationResult {
  eligible: number;
  indexed: number;
  missing: number;
  stale: number;
  ineligible: number;
}

export class SearchReconciler {
  public constructor(
    private readonly source: EventSearchSourceRepository,
    private readonly elasticsearch: Client,
  ) {}

  public async reconcile(): Promise<SearchReconciliationResult> {
    const eligible = new Map<string, string>();
    for await (const document of this.source.iterateEligible()) {
      eligible.set(document.id, document.updatedAt);
    }

    const indexed = new Map<string, string>();
    let searchAfter: unknown[] | undefined;

    for (;;) {
      const response = await this.elasticsearch.search<IndexedVersion>({
        index: EVENT_SEARCH_READ_ALIAS,
        size: 500,
        _source: ['id', 'updatedAt'],
        sort: [{ id: 'asc' }],
        ...(searchAfter === undefined ? {} : { search_after: searchAfter }),
      });

      for (const hit of response.hits.hits) {
        if (hit._source !== undefined) indexed.set(hit._source.id, hit._source.updatedAt);
      }

      const lastHit = response.hits.hits.at(-1);
      if (lastHit?.sort === undefined || response.hits.hits.length < 500) break;
      searchAfter = lastHit.sort;
    }

    let missing = 0;
    let stale = 0;
    for (const [eventId, updatedAt] of eligible) {
      const indexedVersion = indexed.get(eventId);
      if (indexedVersion === undefined) missing += 1;
      else if (indexedVersion !== updatedAt) stale += 1;
    }

    let ineligible = 0;
    for (const eventId of indexed.keys()) {
      if (!eligible.has(eventId)) ineligible += 1;
    }

    return {
      eligible: eligible.size,
      indexed: indexed.size,
      missing,
      stale,
      ineligible,
    };
  }
}
```

Create `src/infrastructure/postgres/advisory-lock.ts` (**complete file**):

```ts
import type { Client } from 'pg';

interface LockRow {
  acquired: boolean;
}

export const withPostgresAdvisoryLock = async <T>(
  client: Client,
  lockName: string,
  operation: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> => {
  const lockResult = await client.query<LockRow>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
    [lockName],
  );
  const acquired = lockResult.rows[0]?.acquired === true;
  if (!acquired) return { acquired: false };

  try {
    return { acquired: true, value: await operation() };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
  }
};
```

Create `src/workers/search-reconcile.ts` (**complete file**):

```ts
import 'dotenv/config';

import { Client as PostgresClient } from 'pg';

import { parseSearchReindexEnvironment } from '../config/search-reindex-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { createApplicationMetrics } from '../infrastructure/observability/metrics.js';
import { withPostgresAdvisoryLock } from '../infrastructure/postgres/advisory-lock.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { EventSearchSourceRepository } from '../modules/search/event-search-source.repository.js';
import { SearchReconciler } from '../modules/search/search-reconciler.js';
import { createLogger } from '../shared/logging/logger.js';

const logger = createLogger();
const environment = parseSearchReindexEnvironment(process.env);
const metrics = createApplicationMetrics();
const prisma = createPrismaClient(environment);
const elasticsearch = createElasticsearchClient(environment, logger);
const lockClient = new PostgresClient({ connectionString: environment.DATABASE_URL });

try {
  await lockClient.connect();
  const reconciler = new SearchReconciler(new EventSearchSourceRepository(prisma), elasticsearch);
  const outcome = await withPostgresAdvisoryLock(lockClient, 'gatherly:search-reconciliation', () =>
    reconciler.reconcile(),
  );

  if (!outcome.acquired) {
    logger.info('Search reconciliation skipped because another run owns the lock');
  } else {
    const result = outcome.value;
    metrics.reconciliationDrift.set({ kind: 'missing' }, result.missing);
    metrics.reconciliationDrift.set({ kind: 'stale' }, result.stale);
    metrics.reconciliationDrift.set({ kind: 'ineligible' }, result.ineligible);
    logger.info(result, 'Search reconciliation completed');
    if (result.missing + result.stale + result.ineligible > 0) process.exitCode = 2;
  }
} catch (error) {
  logger.error({ err: error }, 'Search reconciliation failed');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([
    lockClient.end(),
    prisma.$disconnect(),
    closeElasticsearchClient(elasticsearch),
  ]);
}
```

Add these exact `package.json` script entries:

```json
{
  "scripts": {
    "search:reconcile": "tsx src/workers/search-reconcile.ts",
    "search:reconcile:prod": "node dist/workers/search-reconcile.js"
  }
}
```

### Verification

In staging, delete one document, make one stale, and insert one ineligible test
document. Prove reconciliation reports all three and a full reindex returns
drift to zero.

### Exit evidence

Search freshness is measured, drift is detected, and the repair source is
always PostgreSQL rather than a blind scheduled rebuild.

---

## Checkpoint 8: Separate staging and production configuration

### Reason

CI/CD needs a safe place to prove migrations, image startup, proxy behavior,
smoke checks, and failure drills before production. Staging is useful only if
its release shape resembles production.

### Implementation

Use separate GitHub environments, host configuration, credentials, databases,
JWT secrets, volumes, and public names for `staging` and `production`. Never
point staging at the production PostgreSQL, Redis, Kafka, or Elasticsearch.

Keep target secrets in a root-owned or deployment-group-readable host env file
with mode `0600` or an equivalent Docker secret mechanism. CI stores only what
it needs to connect and authorize deployment. The image contains no target
secrets.

Add build metadata:

```text
APP_REVISION=<full Git SHA>
APP_IMAGE_DIGEST=sha256:...
DEPLOYMENT_ENVIRONMENT=staging|production
DEPLOYMENT_SLOT=blue|green
```

Expose a safe internal build-info endpoint or include these values in readiness
and metrics. It must not reveal environment variables or dependency URLs.

Production should use a dedicated unprivileged deployment account. Remember
that Docker daemon access is effectively host-root authority; limit SSH keys,
source addresses where practical, and commands accordingly.

Add these fields to `src/config/env.ts` inside `environmentSchema`:

```diff
 const environmentSchema = z.object({
   NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
+  DEPLOYMENT_ENVIRONMENT: z
+    .enum(['development', 'test', 'staging', 'production'])
+    .default('development'),
+  DEPLOYMENT_SLOT: z.enum(['local', 'blue', 'green']).default('local'),
+  APP_REVISION: z.string().regex(/^[0-9a-f]{7,40}$|^development$/).default('development'),
+  APP_IMAGE_DIGEST: z
+    .string()
+    .regex(/^sha256:[0-9a-f]{64}$/)
+    .optional(),
```

Create `src/config/build-info.ts` (**complete file**):

```ts
export interface BuildInfo {
  environment: string;
  revision: string;
  imageDigest?: string;
  slot: string;
}

export const createBuildInfo = (input: NodeJS.ProcessEnv = process.env): BuildInfo => ({
  environment: input['DEPLOYMENT_ENVIRONMENT'] ?? 'development',
  revision: input['APP_REVISION'] ?? 'development',
  ...(input['APP_IMAGE_DIGEST'] === undefined ? {} : { imageDigest: input['APP_IMAGE_DIGEST'] }),
  slot: input['DEPLOYMENT_SLOT'] ?? 'local',
});
```

Make these exact edits in `src/app.ts`:

```diff
+import type { BuildInfo } from './config/build-info.js';
@@
 export interface AppDependencies {
+  buildInfo?: BuildInfo;
@@
   app.get('/health/live', (_request, response) => {
     response.status(200).json({ status: 'ok' });
   });
+  app.get('/health/version', (_request, response) => {
+    response.status(200).json(
+      dependencies.buildInfo ?? {
+        environment: 'test',
+        revision: 'development',
+        slot: 'local',
+      },
+    );
+  });
```

Make these exact edits in `src/server.ts`:

```diff
+import { createBuildInfo } from './config/build-info.js';
@@
 const app = createApp({
+  buildInfo: createBuildInfo(),
```

Add this test to `tests/api/health.test.ts` inside its existing `describe`
suite:

```ts
it('reports only safe build metadata', async () => {
  const response = await request(app).get('/health/version');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    environment: 'test',
    revision: 'development',
    slot: 'local',
  });
  expect(JSON.stringify(response.body)).not.toContain('DATABASE_URL');
  expect(JSON.stringify(response.body)).not.toContain('JWT_SECRET');
});
```

Create `.env.production.example` (**complete safe template**; never copy real
values back into Git):

```dotenv
NODE_ENV=production
DEPLOYMENT_ENVIRONMENT=production
DEPLOYMENT_SLOT=blue
APP_REVISION=0000000000000000000000000000000000000000
APP_IMAGE_DIGEST=sha256:0000000000000000000000000000000000000000000000000000000000000000
LOG_LEVEL=info

PORT=3000
BLUE_PORT=3101
GREEN_PORT=3102
CORS_ORIGIN=https://app.example.invalid

POSTGRES_DB=gatherly
POSTGRES_USER=gatherly
POSTGRES_PASSWORD=replace-on-host
PGHOST=postgres
PGPORT=5432
PGDATABASE=gatherly
PGUSER=gatherly
PGPASSWORD=replace-on-host
PGPOOL_MAX=5
PRISMA_POOL_MAX=5
DATABASE_URL=postgresql://gatherly:replace-on-host@postgres:5432/gatherly

JWT_SECRET=replace-with-at-least-32-random-characters
JWT_ISSUER=gatherly-api
JWT_AUDIENCE=gatherly-client
JWT_ACCESS_TOKEN_TTL_SECONDS=900

REDIS_URL=redis://redis:6379
REDIS_CONNECT_TIMEOUT_MS=1000
EVENT_CACHE_TTL_SECONDS=60

ELASTICSEARCH_URL=http://elasticsearch:9200
ELASTICSEARCH_REQUEST_TIMEOUT_MS=2000
ELASTICSEARCH_INDEX_PREFIX=gatherly-events

KAFKA_BROKERS=kafka:29092
KAFKA_CLIENT_ID=gatherly
KAFKA_DOMAIN_EVENTS_TOPIC=gatherly.domain-events.v1
KAFKA_DEAD_LETTER_TOPIC=gatherly.domain-events.dlq.v1
KAFKA_SEARCH_GROUP_ID=gatherly-search-projection-v1
KAFKA_REQUEST_TIMEOUT_MS=5000
KAFKA_OUTBOX_POLL_INTERVAL_MS=500
KAFKA_OUTBOX_BATCH_SIZE=25

OTEL_SDK_DISABLED=false
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://otel-collector:4318/v1/traces
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

### Verification

- Print the resolved image digest and safe build metadata in each environment.
- Prove staging credentials cannot access production services.
- Search the built image history and filesystem for known test secrets.
- Confirm host env files and SSH keys have restrictive permissions.

### Exit evidence

The same runtime/migration image pair can run in staging and production while
configuration and secrets remain target-specific and outside the images.

---

## Checkpoint 9: Add pull-request continuous integration

### Reason

The deployable artifact must be downstream of the same behavioral gates used
for review. Building a different commit or rebuilding after tests breaks that
chain of evidence.

### Implementation

Create `.github/workflows/ci.yml` with least-privilege `contents: read` and a
pull-request concurrency group that cancels stale runs.

The quality job uses the repository's supported Node version and Yarn Classic:

```yaml
- uses: actions/checkout@v6
- uses: actions/setup-node@v6
  with:
    node-version: 24
    cache: yarn
- run: yarn install --frozen-lockfile
- run: yarn prisma:generate
- run: yarn prisma:validate
- run: yarn typecheck
- run: yarn lint
- run: yarn format:check
- run: yarn test
- run: yarn build
- run: docker build --target runtime --tag gatherly-ci:${{ github.sha }} .
```

The real workflow should pin Actions to reviewed full commit SHAs. Dependabot
or a deliberate maintenance task can propose updates.

The current test suite uses Testcontainers for real dependencies, so run it on
a runner with a supported Docker daemon. Do not replace concurrency and outage
tests with mocks merely to make CI cheaper.

Split jobs only when it improves feedback or resource use. If tests run in
parallel, account for image pulls and runner memory. Upload test reports or
coverage only if they are actually reviewed, and never upload `.env` files or
container logs that may contain secrets.

Create `.github/workflows/ci.yml` (**complete file**):

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  quality:
    name: Quality and behavioral tests
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Check out repository
        uses: actions/checkout@v6

      - name: Use Node.js 24
        uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: yarn

      - name: Install frozen dependencies
        run: yarn install --frozen-lockfile

      - name: Generate Prisma client
        run: yarn prisma:generate

      - name: Validate Prisma schema
        run: yarn prisma:validate

      - name: Typecheck
        run: yarn typecheck

      - name: Lint
        run: yarn lint

      - name: Check formatting
        run: yarn format:check

      - name: Run behavioral suite
        run: yarn test

      - name: Build application
        run: yarn build

      - name: Build runtime image
        run: docker build --target runtime --tag gatherly-ci:${{ github.sha }} .

      - name: Inspect runtime user
        run: |
          test "$(docker run --rm --entrypoint id gatherly-ci:${{ github.sha }} -u)" != "0"
```

Readable major tags make the lesson legible. Before merging, replace every
third-party `uses:` tag with its reviewed full commit SHA and leave a comment
with the human-readable release.

### Verification

- Open a deliberately failing pull request and prove merge protection blocks
  it.
- Fix it and prove all gates pass from a clean runner.
- Change only documentation and decide explicitly whether full behavioral CI
  still runs; simple is preferable to a fragile path filter.
- Confirm a stale PR run is cancelled but a deployment is never cancelled
  halfway through.

### Exit evidence

The protected branch requires a clean, frozen-lockfile build and the full
behavioral suite before merge.

---

## Checkpoint 10: Publish immutable runtime and migration images

### Reason

Rebuilding on a target host can produce a different artifact from the one CI
tested. A mutable `latest` tag cannot identify what is running or guarantee a
rollback target.

### Implementation

On a push to the protected `main` branch:

1. Require the quality job.
2. Build the runtime target once with BuildKit.
3. Add OCI source, revision, created-time, and version labels.
4. Push to GHCR using the workflow `GITHUB_TOKEN` with only
   `contents: read` and `packages: write`.
5. Record the registry digest from the build step.
6. Generate provenance/SBOM attestations if supported by the chosen registry
   and retention policy.
7. Pass `ghcr.io/<owner>/gatherly-backend@sha256:<digest>` to deployment jobs.

Human-friendly tags such as the full commit SHA or `main` may coexist, but
deployment and rollback use a digest. Never deploy `latest`.

Use GitHub build cache for speed, not as evidence. The digest is the artifact
identity. Configure registry retention so at least the current and several
known-good previous digests remain available.

Create `.github/workflows/publish-image.yml` (**complete reusable workflow**):

```yaml
name: Publish immutable image

on:
  workflow_call:
    outputs:
      runtime_image:
        description: Immutable GHCR runtime image reference
        value: ${{ jobs.publish.outputs.runtime_image }}
      migration_image:
        description: Immutable GHCR migration image reference
        value: ${{ jobs.publish.outputs.migration_image }}

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      packages: write
    outputs:
      runtime_image: ${{ steps.result.outputs.runtime_image }}
      migration_image: ${{ steps.result.outputs.migration_image }}

    steps:
      - name: Check out reviewed revision
        uses: actions/checkout@v6

      - name: Derive lowercase image repository
        id: repository
        shell: bash
        run: |
          repository="ghcr.io/${GITHUB_REPOSITORY,,}"
          echo "value=$repository" >> "$GITHUB_OUTPUT"

      - name: Log in to GHCR
        uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Buildx
        uses: docker/setup-buildx-action@v4

      - name: Build and push runtime image
        id: runtime
        uses: docker/build-push-action@v7
        with:
          context: .
          target: runtime
          push: true
          tags: ${{ steps.repository.outputs.value }}:${{ github.sha }}-runtime
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: mode=max
          sbom: true

      - name: Build and push migration image
        id: migration
        uses: docker/build-push-action@v7
        with:
          context: .
          target: migration
          push: true
          tags: ${{ steps.repository.outputs.value }}:${{ github.sha }}-migration
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: mode=max
          sbom: true

      - name: Return immutable references
        id: result
        shell: bash
        env:
          REPOSITORY: ${{ steps.repository.outputs.value }}
          RUNTIME_DIGEST: ${{ steps.runtime.outputs.digest }}
          MIGRATION_DIGEST: ${{ steps.migration.outputs.digest }}
        run: |
          case "$RUNTIME_DIGEST" in sha256:*) ;; *) exit 1 ;; esac
          case "$MIGRATION_DIGEST" in sha256:*) ;; *) exit 1 ;; esac
          echo "runtime_image=${REPOSITORY}@${RUNTIME_DIGEST}" >> "$GITHUB_OUTPUT"
          echo "migration_image=${REPOSITORY}@${MIGRATION_DIGEST}" >> "$GITHUB_OUTPUT"
```

The workflow deliberately publishes no `latest` tag. Deployment consumes both
returned digest references and verifies their OCI revision labels match the
same reviewed commit.

### Verification

```bash
docker pull ghcr.io/<owner>/gatherly-backend@sha256:<digest>
docker image inspect ghcr.io/<owner>/gatherly-backend@sha256:<digest>
```

Confirm both revision labels equal the reviewed commit and that staging reports
the same digest pair. Re-run the deployment workflow and prove it reuses those
digests rather than building on the server.

### Exit evidence

There is an auditable line from pull-request checks to commit, runtime/migration
digests, staging deployment, and production deployment.

---

## Checkpoint 11: Prepare the production Compose roles

### Reason

Blue/green deployment needs two interchangeable HTTP services but only one set
of durable dependencies. It must not recreate PostgreSQL, Redis, Kafka,
Elasticsearch, or volumes during an application release.

### Implementation

Create a production deployment file under `deploy/`, keeping local development
commands unchanged. Define a reusable hardened HTTP service shape and these
profiles/roles:

```text
app-blue       profile blue   127.0.0.1:${BLUE_PORT:-3101}:3000
app-green      profile green  127.0.0.1:${GREEN_PORT:-3102}:3000
migration      profile tools  one-shot Prisma migrate deploy
outbox-publisher              singleton operational role
search-consumer               singleton operational role
search-reconcile profile tools/scheduled
```

Every application role uses `${APP_IMAGE:?set an immutable image reference}`.
Do not leave a production fallback to a local build or `latest`. Use
`pull_policy: never` after the deployment step explicitly pulls the digest, or
an equally explicit policy.

Both HTTP slots share the same target environment and dependencies but have
different `DEPLOYMENT_SLOT` values. Preserve existing hardening:

```yaml
init: true
read_only: true
cap_drop: [ALL]
security_opt: [no-new-privileges:true]
tmpfs:
  - /tmp:size=64m,mode=1777
restart: unless-stopped
stop_grace_period: 30s
```

The application currently bounds its internal graceful shutdown at 10 seconds.
The Compose grace period must be longer than the application's bound. The Nginx
drain delay is a separate period before SIGTERM.

Give the host enough memory for both HTTP slots during overlap plus worker and
infrastructure peaks. A blue/green process that OOM-kills PostgreSQL is not a
safe deployment.

Add health checks:

```text
container health: /health/live
deployment admission: /health/ready
```

Liveness must not restart a process because PostgreSQL is temporarily down.
Readiness must become false as soon as graceful shutdown begins.

Do not put migrations in an application container startup command. Run the
one-shot migration role once per release before the candidate starts.

Create `deploy/compose.production.yaml` (**complete file**). It is an overlay
for the existing `compose.yaml`, so routine local Compose behavior stays
unchanged:

```yaml
x-gatherly-api: &gatherly-api
  image: ${APP_IMAGE:?APP_IMAGE must be an immutable digest reference}
  pull_policy: never
  env_file:
    - .env.production
  init: true
  read_only: true
  tmpfs:
    - /tmp:size=64m,mode=1777
  restart: unless-stopped
  stop_grace_period: 30s
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL
  pids_limit: 100
  mem_limit: 512m
  healthcheck:
    test:
      - CMD
      - node
      - -e
      - fetch('http://127.0.0.1:3000/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))
    interval: 5s
    timeout: 3s
    retries: 12
    start_period: 10s
  logging:
    driver: json-file
    options:
      max-size: 10m
      max-file: '5'

services:
  # The base development/local service remains available outside this overlay,
  # but is never part of a production profile.
  app:
    profiles: [local-only]

  app-blue:
    <<: *gatherly-api
    profiles: [blue]
    environment:
      NODE_ENV: production
      PORT: 3000
      DEPLOYMENT_ENVIRONMENT: ${DEPLOYMENT_ENVIRONMENT:-production}
      DEPLOYMENT_SLOT: blue
      APP_REVISION: ${APP_REVISION:?set APP_REVISION}
      APP_IMAGE_DIGEST: ${APP_IMAGE_DIGEST:?set APP_IMAGE_DIGEST}
      OTEL_SERVICE_NAME: gatherly-api
    ports:
      - '127.0.0.1:${BLUE_PORT:-3101}:3000'

  app-green:
    <<: *gatherly-api
    profiles: [green]
    environment:
      NODE_ENV: production
      PORT: 3000
      DEPLOYMENT_ENVIRONMENT: ${DEPLOYMENT_ENVIRONMENT:-production}
      DEPLOYMENT_SLOT: green
      APP_REVISION: ${APP_REVISION:?set APP_REVISION}
      APP_IMAGE_DIGEST: ${APP_IMAGE_DIGEST:?set APP_IMAGE_DIGEST}
      OTEL_SERVICE_NAME: gatherly-api
    ports:
      - '127.0.0.1:${GREEN_PORT:-3102}:3000'

  migration:
    image: ${MIGRATION_IMAGE:?MIGRATION_IMAGE must be an immutable digest reference}
    pull_policy: never
    profiles: [tools]
    env_file:
      - .env.production
    restart: 'no'
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'

  outbox-publisher:
    image: ${APP_IMAGE:?APP_IMAGE must be an immutable digest reference}
    pull_policy: never
    env_file:
      - .env.production
    environment:
      DEPLOYMENT_ENVIRONMENT: ${DEPLOYMENT_ENVIRONMENT:-production}
      APP_REVISION: ${APP_REVISION:?set APP_REVISION}
      APP_IMAGE_DIGEST: ${APP_IMAGE_DIGEST:?set APP_IMAGE_DIGEST}
      OTEL_SERVICE_NAME: gatherly-outbox-publisher
      METRICS_PORT: 9464
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '5'

  search-consumer:
    image: ${APP_IMAGE:?APP_IMAGE must be an immutable digest reference}
    pull_policy: never
    env_file:
      - .env.production
    environment:
      DEPLOYMENT_ENVIRONMENT: ${DEPLOYMENT_ENVIRONMENT:-production}
      APP_REVISION: ${APP_REVISION:?set APP_REVISION}
      APP_IMAGE_DIGEST: ${APP_IMAGE_DIGEST:?set APP_IMAGE_DIGEST}
      OTEL_SERVICE_NAME: gatherly-search-consumer
      METRICS_PORT: 9465
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '5'

  search-reconcile:
    image: ${APP_IMAGE:?APP_IMAGE must be an immutable digest reference}
    pull_policy: never
    profiles: [tools]
    command: node dist/workers/search-reconcile.js
    env_file:
      - .env.production
    environment:
      DEPLOYMENT_ENVIRONMENT: ${DEPLOYMENT_ENVIRONMENT:-production}
      APP_REVISION: ${APP_REVISION:?set APP_REVISION}
      APP_IMAGE_DIGEST: ${APP_IMAGE_DIGEST:?set APP_IMAGE_DIGEST}
      OTEL_SERVICE_NAME: gatherly-search-reconcile
    restart: 'no'
    init: true
    read_only: true
    tmpfs:
      - /tmp:size=32m,mode=1777
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 384m
    pids_limit: 100
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'
```

Always invoke the production model with the host env file and both Compose
files:

```bash
docker compose \
  --env-file .env.production \
  -f compose.yaml \
  -f deploy/compose.production.yaml \
  --profile blue --profile green --profile tools \
  config --quiet
```

The deploy script uses targeted `run`, `up`, and `stop` commands. It never
starts the base `app` service and never runs `down`.

### Verification

Render production configuration with non-secret disposable values:

```bash
APP_IMAGE='gatherly-backend:test' \
  docker compose -f compose.yaml -f deploy/compose.production.yaml \
  --profile blue --profile green --profile tools config --quiet
```

Start both slots against disposable infrastructure and confirm:

- both report liveness;
- both report readiness against the same PostgreSQL;
- their build metadata differs only by slot;
- stopping one does not stop dependencies or the other slot;
- `docker compose down` is absent from routine deployment code.

### Exit evidence

One immutable image can perform every process role, two HTTP slots can overlap,
and stable infrastructure is outside the release replacement boundary.

---

## Checkpoint 12: Put Nginx in front of HTTP, SSE, and WebSockets

### Reason

Nginx owns the stable public socket and TLS certificate. A small included
upstream file lets a deployment switch one loopback target and gracefully
reload Nginx without restarting it.

### Implementation

On the Linux host, create:

```text
/etc/nginx/gatherly-backend-upstream.inc
```

Initial managed content:

```nginx
server 127.0.0.1:3101;
```

At `http` scope:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream gatherly_backend {
    include /etc/nginx/gatherly-backend-upstream.inc;
    keepalive 32;
}
```

The TLS server keeps certificate configuration and security headers. Its core
proxy shape is:

```nginx
location / {
    proxy_pass http://gatherly_backend;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Request-ID $request_id;
}

location = /api/realtime/stream {
    proxy_pass http://gatherly_backend;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 15m;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /api/chat/socket {
    proxy_pass http://gatherly_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 15m;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /metrics {
    return 404;
}
```

The exact paths match the current router and WebSocket protocol. Recheck them
if either protocol changes rather than leaving deployment configuration behind.

Align proxy timeouts with Gatherly's maximum SSE/WebSocket connection duration
and heartbeat behavior. Set request-body limits and timeouts from actual API
needs. Configure Express `trust proxy` narrowly for the single trusted Nginx
hop before using forwarded client IPs for logging or rate limiting.

The deployment account receives narrow passwordless sudo access only for:

```text
install the one exact upstream include
nginx -t
nginx -s reload
```

Do not grant arbitrary passwordless sudo or permission to replace the complete
site configuration.

Create `deploy/nginx/gatherly-backend-upstream.inc.example` (**complete file**):

```nginx
server 127.0.0.1:3101;
```

Create `deploy/nginx/gatherly-backend-site.conf.example` (**complete file**;
replace the example hostname and certificate paths on the host):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream gatherly_backend {
    include /etc/nginx/gatherly-backend-upstream.inc;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name api.gatherly.example;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.gatherly.example;

    ssl_certificate /etc/letsencrypt/live/api.gatherly.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.gatherly.example/privkey.pem;

    client_max_body_size 1m;
    proxy_connect_timeout 5s;
    proxy_send_timeout 30s;
    proxy_read_timeout 30s;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;

    location = /metrics {
        return 404;
    }

    location = /api/realtime/stream {
        proxy_pass http://gatherly_backend;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 15m;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Request-ID $request_id;
    }

    location = /api/chat/socket {
        proxy_pass http://gatherly_backend;
        proxy_http_version 1.1;
        proxy_read_timeout 15m;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Request-ID $request_id;
    }

    location / {
        proxy_pass http://gatherly_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Request-ID $request_id;
    }
}
```

Instead of allowing CI to run arbitrary `install` and Nginx commands as root,
create `deploy/nginx/gatherly-switch-upstream` from this **complete file**, then
install it root-owned as `/usr/local/sbin/gatherly-switch-upstream`:

```bash
#!/usr/bin/env bash
set -euo pipefail

readonly upstream_file='/etc/nginx/gatherly-backend-upstream.inc'
readonly requested_port="${1:-}"

case "$requested_port" in
  3101|3102) ;;
  *)
    echo 'Expected managed port 3101 or 3102.' >&2
    exit 2
    ;;
esac

readonly previous="$(cat "$upstream_file")"
readonly temporary="$(mktemp /tmp/gatherly-upstream.XXXXXX)"
trap 'rm -f "$temporary"' EXIT

printf 'server 127.0.0.1:%s;\n' "$requested_port" > "$temporary"
install -o root -g root -m 0644 "$temporary" "$upstream_file"

if ! nginx -t; then
  printf '%s\n' "$previous" > "$temporary"
  install -o root -g root -m 0644 "$temporary" "$upstream_file"
  nginx -t
  echo 'Rejected invalid Nginx target and restored the previous upstream.' >&2
  exit 1
fi

nginx -s reload
```

Install it once as root:

```bash
sudo install -o root -g root -m 0755 \
  deploy/nginx/gatherly-switch-upstream \
  /usr/local/sbin/gatherly-switch-upstream
```

Create `/etc/sudoers.d/gatherly-deploy` (**complete file**, replacing `deploy`
with the actual dedicated account if needed):

```sudoers
deploy ALL=(root) NOPASSWD: /usr/local/sbin/gatherly-switch-upstream 3101
deploy ALL=(root) NOPASSWD: /usr/local/sbin/gatherly-switch-upstream 3102
```

Validate it with:

```bash
sudo visudo -cf /etc/sudoers.d/gatherly-deploy
```

### Verification

```bash
sudo nginx -t
sudo nginx -s reload
curl --fail https://<staging-api>/health/live
curl --fail https://<staging-api>/health/ready
```

Open an SSE connection and WebSocket session through Nginx. Reload Nginx and
confirm existing connections continue or reconnect according to the documented
client protocol. Confirm `/metrics` is unavailable publicly.

### Exit evidence

Nginx can move new HTTP and upgraded traffic between loopback slots with a
validated graceful reload, while telemetry and dependencies remain private.

---

## Checkpoint 13: Automate blue/green deployment and rollback

### Reason

The dangerous part of deployment is ordering. The script must leave the active
slot untouched until the candidate is proven and must retain enough state to
restore traffic when a post-cutover check fails.

### Implementation

Create `scripts/deploy-blue-green.mjs` and a Yarn command such as
`deploy:production`. The script runs only on the Linux deployment host and
requires an immutable `--image` digest.

Use this state machine:

```text
acquire host deployment lock
  -> validate host, tools, upstream file, image digests, and free disk
  -> read and preserve exact original upstream content
  -> determine active and inactive managed slots
  -> pull immutable runtime and migration image digests
  -> verify recent local Restic backup status before a schema-changing release
  -> run one-shot forward migrations
  -> start/recreate only inactive HTTP slot with --no-deps
  -> poll candidate /health/ready on loopback with a deadline
  -> run read-only candidate smoke checks on loopback
  -> atomically install candidate upstream include
  -> run nginx -t
  -> gracefully reload Nginx
  -> verify public TLS health, build revision, and representative read path
  -> update singleton workers from the same runtime digest and verify progress
  -> observe error, latency, readiness, and backlog signals
  -> wait the configured connection-drain period
  -> SIGTERM old HTTP slot and let its bounded shutdown finish
  -> record successful digest, slot, revision, operator, and time
release lock
```

On any failure before the upstream changes:

```text
leave Nginx on active slot -> stop candidate -> report diagnostics -> fail
```

On a failure after the upstream changes:

```text
restore exact original include -> nginx -t -> graceful reload
-> stop candidate -> retain old slot -> report diagnostics -> fail
```

If restoring Nginx fails, do not stop either slot. Print the exact manual
recovery command and fail loudly.

Use both protections against concurrent deployment:

- a GitHub production concurrency group with `cancel-in-progress: false`;
- a host-local `flock` around the deployment command so manual and CI releases
  cannot overlap.

Do not implement rollback as `prisma migrate reset`, `migrate down`, volume
replacement, or automatic data restore. Traffic rollback selects the previous
application digest and slot only.

Create `scripts/deploy-blue-green.mjs` (**complete file**):

```js
#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const composeFile = resolve(repositoryRoot, 'compose.yaml');
const productionComposeFile = resolve(repositoryRoot, 'deploy/compose.production.yaml');
const productionEnvFile = resolve(repositoryRoot, '.env.production');
const upstreamFile =
  process.env['NGINX_UPSTREAM_FILE'] ?? '/etc/nginx/gatherly-backend-upstream.inc';
const switchHelper =
  process.env['NGINX_SWITCH_HELPER'] ?? '/usr/local/sbin/gatherly-switch-upstream';
const stateFile = process.env['DEPLOYMENT_STATE_FILE'] ?? '/var/lib/gatherly/deployment-state.json';
const backupMarker =
  process.env['BACKUP_SUCCESS_MARKER'] ?? '/var/lib/gatherly/last-backup-success';
const readinessTimeoutSeconds = Number(process.env['DEPLOY_READINESS_TIMEOUT_SECONDS'] ?? 120);
const drainSeconds = Number(process.env['DEPLOY_DRAIN_SECONDS'] ?? 60);
const publicBaseUrl = process.env['DEPLOY_VERIFY_URL'];

const slots = {
  blue: { name: 'blue', port: Number(process.env['BLUE_PORT'] ?? 3101), service: 'app-blue' },
  green: {
    name: 'green',
    port: Number(process.env['GREEN_PORT'] ?? 3102),
    service: 'app-green',
  },
};

const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
};

const runtimeImage = argument('--runtime-image');
const migrationImage = argument('--migration-image');
const revision = argument('--revision');

const requireImmutableImage = (name, value) => {
  if (value === undefined || !/@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be an immutable @sha256 image reference.`);
  }
  return value;
};

const requireRevision = (value) => {
  if (value === undefined || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('--revision must be a full lowercase Git SHA.');
  }
  return value;
};

const run = (command, args, options = {}) => {
  console.log(`> ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
};

const capture = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();

const digestFrom = (image) => image.slice(image.indexOf('@') + 1);

const releaseEnvironment = (image, releaseRevision) => ({
  ...process.env,
  APP_IMAGE: image,
  MIGRATION_IMAGE: checkedMigrationImage,
  APP_REVISION: releaseRevision,
  APP_IMAGE_DIGEST: digestFrom(image),
});

const composeArguments = (args) => [
  'compose',
  '--env-file',
  productionEnvFile,
  '--file',
  composeFile,
  '--file',
  productionComposeFile,
  ...args,
];

const compose = (environment, args) => run('docker', composeArguments(args), { env: environment });

const composeCapture = (environment, args) =>
  capture('docker', composeArguments(args), { env: environment });

const readActiveSlot = () => {
  const upstream = readFileSync(upstreamFile, 'utf8');
  const match = upstream.match(/^server 127\.0\.0\.1:(\d+);\s*$/);
  if (!match) throw new Error(`Could not parse managed upstream ${upstreamFile}.`);
  const port = Number(match[1]);
  if (port === slots.blue.port) return slots.blue;
  if (port === slots.green.port) return slots.green;
  throw new Error(`Upstream port ${port} is not a managed deployment slot.`);
};

const inactiveSlot = (active) => (active.name === 'blue' ? slots.green : slots.blue);

const inspectService = (environment, service) => {
  const containerId = composeCapture(environment, ['ps', '--quiet', service]);
  if (!containerId) throw new Error(`No container exists for ${service}.`);
  const [inspection] = JSON.parse(capture('docker', ['inspect', containerId]));
  return inspection;
};

const environmentValue = (inspection, name) => {
  const entry = inspection.Config.Env.find((value) => value.startsWith(`${name}=`));
  return entry?.slice(name.length + 1);
};

const assertServiceRunning = (environment, service) => {
  const inspection = inspectService(environment, service);
  if (inspection.State.Running !== true) throw new Error(`${service} is not running.`);
};

const wait = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const fetchOk = async (url, timeoutMs = 5_000) => {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response;
};

const waitForCandidate = async (slot, expectedRevision) => {
  const deadline = Date.now() + readinessTimeoutSeconds * 1_000;
  const base = `http://127.0.0.1:${slot.port}`;

  while (Date.now() < deadline) {
    try {
      await fetchOk(`${base}/health/ready`, 3_000);
      const version = await (await fetchOk(`${base}/health/version`, 3_000)).json();
      if (version.revision !== expectedRevision || version.slot !== slot.name) {
        throw new Error(`Candidate reported unexpected revision or slot.`);
      }
      await fetchOk(`${base}/api/events?limit=1`, 5_000);
      return;
    } catch {
      await wait(2_000);
    }
  }

  throw new Error(`Candidate ${slot.name} did not become ready before the deadline.`);
};

const verifyPublicPath = async (expectedRevision) => {
  if (publicBaseUrl === undefined) throw new Error('DEPLOY_VERIFY_URL is required.');
  await fetchOk(new URL('/health/ready', publicBaseUrl));
  const version = await (await fetchOk(new URL('/health/version', publicBaseUrl))).json();
  if (version.revision !== expectedRevision) {
    throw new Error(`Public path serves revision ${version.revision ?? 'unknown'}.`);
  }
  await fetchOk(new URL('/api/events?limit=1', publicBaseUrl));
};

const switchTraffic = (port) => {
  run('sudo', [switchHelper, String(port)]);
};

const assertFreshBackup = () => {
  if (!existsSync(backupMarker)) throw new Error(`Backup marker ${backupMarker} is missing.`);
  const ageHours = (Date.now() - statSync(backupMarker).mtimeMs) / 3_600_000;
  if (ageHours > 36) throw new Error(`Last successful backup is ${ageHours.toFixed(1)} hours old.`);
};

const writeDeploymentState = (state) => {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
};

const assertImageRevision = (image, expectedRevision) => {
  const actualRevision = capture('docker', [
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    image,
  ]);
  if (actualRevision !== expectedRevision) {
    throw new Error(`${image} was built from ${actualRevision || 'an unknown revision'}.`);
  }
};

if (process.platform !== 'linux') {
  throw new Error('Blue/green deployment must run on the Linux production host.');
}
if (!existsSync(productionEnvFile)) throw new Error(`${productionEnvFile} does not exist.`);
if (!existsSync(upstreamFile)) throw new Error(`${upstreamFile} does not exist.`);
if (!existsSync(switchHelper)) throw new Error(`${switchHelper} does not exist.`);

const checkedRuntimeImage = requireImmutableImage('--runtime-image', runtimeImage);
const checkedMigrationImage = requireImmutableImage('--migration-image', migrationImage);
const checkedRevision = requireRevision(revision);
const active = readActiveSlot();
const target = inactiveSlot(active);

const bootstrapEnvironment = releaseEnvironment(checkedRuntimeImage, checkedRevision);
const activeInspection = inspectService(bootstrapEnvironment, active.service);
const previousRuntimeImage = activeInspection.Config.Image;
const previousRevision = environmentValue(activeInspection, 'APP_REVISION');
const previousDigest = environmentValue(activeInspection, 'APP_IMAGE_DIGEST');
if (!previousRevision || !previousDigest) {
  throw new Error('Active slot does not expose rollback build metadata.');
}

let trafficChanged = false;
let workersChanged = false;

console.log(`Active slot: ${active.name} (${active.port})`);
console.log(`Candidate slot: ${target.name} (${target.port})`);
console.log(`Runtime image: ${checkedRuntimeImage}`);
console.log(`Migration image: ${checkedMigrationImage}`);

try {
  assertFreshBackup();
  run('docker', ['pull', checkedRuntimeImage]);
  run('docker', ['pull', checkedMigrationImage]);
  assertImageRevision(checkedRuntimeImage, checkedRevision);
  assertImageRevision(checkedMigrationImage, checkedRevision);

  compose(bootstrapEnvironment, [
    '--profile',
    'tools',
    'run',
    '--rm',
    '--no-deps',
    '--no-build',
    'migration',
  ]);

  compose(bootstrapEnvironment, [
    'up',
    '--detach',
    '--force-recreate',
    '--no-deps',
    '--no-build',
    target.service,
  ]);
  await waitForCandidate(target, checkedRevision);

  switchTraffic(target.port);
  trafficChanged = true;
  await verifyPublicPath(checkedRevision);

  workersChanged = true;
  compose(bootstrapEnvironment, [
    'up',
    '--detach',
    '--force-recreate',
    '--no-deps',
    '--no-build',
    'outbox-publisher',
  ]);
  await wait(5_000);
  assertServiceRunning(bootstrapEnvironment, 'outbox-publisher');

  compose(bootstrapEnvironment, [
    'up',
    '--detach',
    '--force-recreate',
    '--no-deps',
    '--no-build',
    'search-consumer',
  ]);
  await wait(5_000);
  assertServiceRunning(bootstrapEnvironment, 'search-consumer');
  await wait(drainSeconds * 1_000);
  compose(bootstrapEnvironment, ['stop', '--timeout', '30', active.service]);

  writeDeploymentState({
    deployedAt: new Date().toISOString(),
    revision: checkedRevision,
    runtimeImage: checkedRuntimeImage,
    migrationImage: checkedMigrationImage,
    slot: target.name,
  });
  console.log(`Deployment complete: ${target.name} serves ${checkedRevision}.`);
} catch (error) {
  console.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);

  if (trafficChanged) {
    try {
      switchTraffic(active.port);
      await verifyPublicPath(previousRevision);
    } catch (rollbackError) {
      console.error(`TRAFFIC ROLLBACK FAILED: ${String(rollbackError)}`);
      console.error(`Keep both slots running and restore ${active.port} manually.`);
      process.exitCode = 1;
      throw rollbackError;
    }
  }

  if (workersChanged && /@sha256:[0-9a-f]{64}$/.test(previousRuntimeImage)) {
    const rollbackEnvironment = {
      ...process.env,
      APP_IMAGE: previousRuntimeImage,
      MIGRATION_IMAGE: checkedMigrationImage,
      APP_REVISION: previousRevision,
      APP_IMAGE_DIGEST: previousDigest,
    };
    try {
      for (const service of ['outbox-publisher', 'search-consumer']) {
        compose(rollbackEnvironment, [
          'up',
          '--detach',
          '--force-recreate',
          '--no-deps',
          '--no-build',
          service,
        ]);
      }
    } catch (workerRollbackError) {
      console.error(`Worker rollback failed: ${String(workerRollbackError)}`);
    }
  }

  try {
    compose(bootstrapEnvironment, ['stop', '--timeout', '30', target.service]);
  } catch (stopError) {
    console.error(`Candidate cleanup failed: ${String(stopError)}`);
  }
  process.exitCode = 1;
}
```

The script expects a host lock outside the Node process. Add this exact
`package.json` entry:

```json
{
  "scripts": {
    "deploy:production": "node scripts/deploy-blue-green.mjs"
  }
}
```

Manual or CI invocation is:

```bash
flock --nonblock /var/lock/gatherly-deploy.lock \
  yarn deploy:production \
  --runtime-image 'ghcr.io/<owner>/gatherly-backend@sha256:<runtime-digest>' \
  --migration-image 'ghcr.io/<owner>/gatherly-backend@sha256:<migration-digest>' \
  --revision '<full-git-sha>'
```

Pre-create `/var/lib/gatherly`, the backup marker, and the lock file location
with ownership limited to the deployment account. Do not make `/var/lib` or
`/var/lock` broadly writable.

### Long-lived connection drain

After Nginx reload, new connections use the new slot while existing Nginx
workers may continue proxying established SSE/WebSocket connections to the old
slot. After a bounded drain delay, SIGTERM the old application. Gatherly must:

- mark readiness false immediately;
- stop accepting new HTTP work;
- emit the existing SSE stream-closed signal;
- close WebSockets with the documented reconnectable shutdown code;
- drain ordinary in-flight requests within the application timeout;
- close Redis, Elasticsearch, Prisma, and `pg` resources;
- flush useful logs and telemetry within the outer Compose grace period.

Clients must reconnect with SSE `Last-Event-ID` or recover chat history from
PostgreSQL. Blue/green does not preserve in-memory connection state.

### Worker rollout

Workers do not need blue/green HTTP routing. Update them one at a time after the
new HTTP slot is serving:

1. Gracefully stop/recreate the outbox publisher with the new digest.
2. Prove its last-success timestamp advances or the outbox is empty.
3. Gracefully stop/recreate the search consumer with the new digest.
4. Prove the consumer joins the same group and lag is stable/decreasing.

The outbox lock strategy and Kafka consumer group tolerate brief overlap, but
routine deployment should not create unbounded duplicate replicas. Envelope
and schema changes must allow old and new workers during the rollout window.

### Verification

Rehearse in staging:

1. Normal blue-to-green and green-to-blue deployments under HTTP load.
2. Candidate never becomes ready.
3. Migration fails.
4. `nginx -t` fails due to a disposable invalid include.
5. Public smoke check fails after cutover.
6. Worker fails after HTTP cutover.
7. A second deployment starts while the first holds the host lock.
8. Active SSE/WebSocket sessions exist during drain.
9. Old container needs longer than the configured drain bound.
10. The previous digest is explicitly redeployed.

Watch for any interval where both loopback slots are unavailable. A normal
deployment must have none.

### Exit evidence

The automated state machine has a recorded result for every failure boundary,
and the previous application digest remains a tested rollback target.

---

## Checkpoint 14: Enforce expand/contract database migrations

### Reason

During blue/green deployment, old code serves while migrations run and may
continue serving established connections after cutover. A migration compatible
only with new code makes application rollback unsafe.

### Implementation

Use separate releases:

```text
1. expand: add nullable column/table/index or compatible new representation
2. deploy dual-compatible code
3. backfill in bounded, observable batches when needed
4. switch reads/writes and prove completion
5. contract in a later release after old code cannot run
```

Rules:

- Never rename or drop a used column in the same release that changes code.
- Avoid long blocking table rewrites on the deployment path.
- Create large indexes with the PostgreSQL strategy appropriate to current
  traffic and transaction constraints, and measure lock behavior in staging.
- Give backfills checkpoints, rate bounds, progress metrics, and restartability.
- CI can validate migrations on a disposable copy; it cannot prove production
  duration from an empty database.
- A failed application deploy does not run automatic reverse migrations.
- Record which oldest application digest remains schema-compatible.

Create `scripts/check-migration-safety.mjs` (**complete CI helper**). It does
not prove a migration is safe; it makes destructive SQL require an explicit
review rather than slipping through unnoticed:

```js
#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const base = process.env['MIGRATION_BASE_SHA'];
if (!base || !/^[0-9a-f]{40}$/.test(base)) {
  throw new Error('MIGRATION_BASE_SHA must be a full Git SHA.');
}

const changed = execFileSync(
  'git',
  ['diff', '--name-only', `${base}...HEAD`, '--', 'prisma/migrations/*/migration.sql'],
  { encoding: 'utf8' },
)
  .split(/\r?\n/u)
  .filter(Boolean);

const riskyPatterns = [
  /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX)\b/iu,
  /\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/iu,
  /\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/iu,
  /\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/iu,
  /\bTRUNCATE\b/iu,
  /\bDELETE\s+FROM\b/iu,
];

let failed = false;
for (const file of changed) {
  const sql = readFileSync(file, 'utf8');
  const matches = riskyPatterns.filter((pattern) => pattern.test(sql));
  if (matches.length === 0) continue;

  failed = true;
  console.error(`${file} contains contract/destructive SQL.`);
}

if (failed) {
  console.error(
    'Split expansion and contract releases, then document and run the contract manually after compatibility is proven.',
  );
  process.exitCode = 1;
} else {
  console.log(`Checked ${changed.length} changed migration file(s); no contract SQL detected.`);
}
```

Add this CI step after checkout with the pull request base SHA:

```yaml
- name: Check changed migrations for contract operations
  if: github.event_name == 'pull_request'
  env:
    MIGRATION_BASE_SHA: ${{ github.event.pull_request.base.sha }}
  run: node scripts/check-migration-safety.mjs
```

Use this **complete compatibility worksheet** as
`docs/migrations/EXPAND_CONTRACT_TEMPLATE.md` for every schema-changing
release:

```markdown
# Expand/contract migration: <name>

## Compatibility matrix

| State                   | Old application reads/writes | New application reads/writes | Safe? |
| ----------------------- | ---------------------------- | ---------------------------- | ----- |
| Before expansion        |                              |                              |       |
| After expansion         |                              |                              |       |
| During backfill         |                              |                              |       |
| After read/write switch |                              |                              |       |
| After later contract    | not running                  |                              |       |

## Expansion release

- Migration files:
- Expected lock level and duration:
- Data/default behavior for old code:
- Staging row count and measured duration:
- Roll-forward recovery:

## Backfill

- Command:
- Batch size and pause:
- Resume cursor/checkpoint:
- Progress metric:
- Completion query:

## Contract release

- Earliest compatible application digest:
- Evidence no old digest can run:
- Backup/restore checkpoint:
- Reviewed destructive statement:
```

### Verification

In staging, keep the old slot handling requests while applying the migration,
start the new slot, cut over, then deliberately roll back traffic. Run old and
new behavioral smoke checks during each overlap.

### Exit evidence

The previous application image remains usable after every release migration,
and destructive contract work is separated by at least one proven release.

---

## Checkpoint 15: Deploy through staging and a protected production environment

### Reason

Publishing an image and deploying it are different authorities. Production
secrets and approval rules should be unavailable until the production job is
allowed to start.

### Implementation

Create `.github/workflows/release.yml` with this dependency graph:

```text
quality
  -> build and push digest once
  -> deploy staging
  -> staging smoke and short observation window
  -> production environment approval
  -> deploy production with the same runtime/migration digest pair
  -> production smoke and deployment record
```

GitHub environments contain target-specific values such as:

```text
DEPLOY_HOST
DEPLOY_PORT
DEPLOY_USER
DEPLOY_APP_DIR
DEPLOY_PUBLIC_URL
```

Environment secrets contain a dedicated SSH private key and independently
verified `known_hosts` content. Do not use `StrictHostKeyChecking=no` and do not
populate `known_hosts` by scanning the host during the same untrusted job that
will connect to it.

The remote command accepts only validated positional values: application
directory, full revision, and immutable runtime/migration image digests. Quote
them safely. The host checkout supplies the reviewed deployment script and
Compose files; the host `.env` and durable volumes remain outside Git.

Use production environment reviewers if deliberate approval is part of the
learning goal. Serialize production deployments and never cancel an active
one because a newer commit reached `main`.

Create `.github/workflows/deploy-environment.yml` (**complete reusable
workflow**):

```yaml
name: Deploy environment

on:
  workflow_call:
    inputs:
      environment:
        required: true
        type: string
      runtime_image:
        required: true
        type: string
      migration_image:
        required: true
        type: string
      revision:
        required: true
        type: string
    secrets:
      DEPLOY_SSH_PRIVATE_KEY:
        required: true
      DEPLOY_SSH_KNOWN_HOSTS:
        required: true

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment:
      name: ${{ inputs.environment }}
      url: ${{ vars.DEPLOY_PUBLIC_URL }}
    concurrency:
      group: deploy-${{ inputs.environment }}
      cancel-in-progress: false
    env:
      DEPLOY_HOST: ${{ vars.DEPLOY_HOST }}
      DEPLOY_PORT: ${{ vars.DEPLOY_PORT || '22' }}
      DEPLOY_USER: ${{ vars.DEPLOY_USER }}
      DEPLOY_APP_DIR: ${{ vars.DEPLOY_APP_DIR }}
      DEPLOY_PUBLIC_URL: ${{ vars.DEPLOY_PUBLIC_URL }}

    steps:
      - name: Validate target configuration
        shell: bash
        env:
          SSH_KEY: ${{ secrets.DEPLOY_SSH_PRIVATE_KEY }}
          KNOWN_HOSTS: ${{ secrets.DEPLOY_SSH_KNOWN_HOSTS }}
        run: |
          set -euo pipefail
          test -n "$DEPLOY_HOST"
          test -n "$DEPLOY_PORT"
          test -n "$DEPLOY_USER"
          test -n "$DEPLOY_APP_DIR"
          test -n "$DEPLOY_PUBLIC_URL"
          test -n "$SSH_KEY"
          test -n "$KNOWN_HOSTS"
          case '${{ inputs.runtime_image }}' in *@sha256:*) ;; *) exit 1 ;; esac
          case '${{ inputs.migration_image }}' in *@sha256:*) ;; *) exit 1 ;; esac

      - name: Configure verified SSH
        shell: bash
        env:
          SSH_KEY: ${{ secrets.DEPLOY_SSH_PRIVATE_KEY }}
          KNOWN_HOSTS: ${{ secrets.DEPLOY_SSH_KNOWN_HOSTS }}
        run: |
          set -euo pipefail
          install -d -m 0700 "$HOME/.ssh"
          printf '%s\n' "$SSH_KEY" > "$HOME/.ssh/deploy"
          printf '%s\n' "$KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"
          chmod 0600 "$HOME/.ssh/deploy" "$HOME/.ssh/known_hosts"

      - name: Deploy reviewed image pair
        shell: bash
        env:
          RUNTIME_IMAGE: ${{ inputs.runtime_image }}
          MIGRATION_IMAGE: ${{ inputs.migration_image }}
          REVISION: ${{ inputs.revision }}
        run: |
          ssh \
            -i "$HOME/.ssh/deploy" \
            -p "$DEPLOY_PORT" \
            "$DEPLOY_USER@$DEPLOY_HOST" \
            "bash -s -- '$DEPLOY_APP_DIR' '$REVISION' '$RUNTIME_IMAGE' '$MIGRATION_IMAGE' '$DEPLOY_PUBLIC_URL'" <<'REMOTE'
          set -euo pipefail

          app_dir="$1"
          revision="$2"
          runtime_image="$3"
          migration_image="$4"
          public_url="$5"

          cd "$app_dir"
          git fetch origin main
          git checkout --detach "$revision"

          DEPLOY_VERIFY_URL="$public_url" \
            flock --nonblock /var/lock/gatherly-deploy.lock \
            yarn deploy:production \
              --runtime-image "$runtime_image" \
              --migration-image "$migration_image" \
              --revision "$revision"
          REMOTE
```

Create `.github/workflows/release.yml` (**complete workflow**):

```yaml
name: Release

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  quality:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: yarn
      - run: yarn install --frozen-lockfile
      - run: yarn prisma:generate
      - run: yarn prisma:validate
      - run: yarn typecheck
      - run: yarn lint
      - run: yarn format:check
      - run: yarn test
      - run: yarn build

  publish:
    needs: quality
    uses: ./.github/workflows/publish-image.yml
    permissions:
      contents: read
      packages: write
    secrets: inherit

  staging:
    needs: publish
    uses: ./.github/workflows/deploy-environment.yml
    with:
      environment: staging
      runtime_image: ${{ needs.publish.outputs.runtime_image }}
      migration_image: ${{ needs.publish.outputs.migration_image }}
      revision: ${{ github.sha }}
    secrets: inherit

  production:
    needs: [publish, staging]
    uses: ./.github/workflows/deploy-environment.yml
    with:
      environment: production
      runtime_image: ${{ needs.publish.outputs.runtime_image }}
      migration_image: ${{ needs.publish.outputs.migration_image }}
      revision: ${{ github.sha }}
    secrets: inherit
```

Pin the `uses:` entries before merging. Configure the `production` GitHub
environment with a required reviewer to create the approval boundary between
staging and production.

### Verification

- A pull request cannot publish or deploy.
- A failed quality job cannot publish.
- A failed staging deployment cannot reach production approval.
- Production job secrets are unavailable to earlier jobs.
- Host-key mismatch fails closed.
- Two production releases serialize.
- A manual workflow dispatch redeploys a selected known digest without a
  rebuild.

### Exit evidence

One reviewed digest progresses through explicit environments, and production
access is limited to the protected deployment job.

---

## Checkpoint 16: Back up PostgreSQL and prove restoration

### Reason

A successful `pg_dump` command is not a backup strategy. For this pet-project
deployment, a useful local recovery backup is recent, complete, encrypted,
retained, monitored, and proven restorable within the stated objectives.

This checkpoint deliberately stores Restic data on the application host. It
protects against mistakes such as a bad migration or accidental database data
loss, but it does **not** protect against complete host loss, failure of the
disk containing both PostgreSQL and the Restic repository, theft, or a
host-wide compromise. That is an accepted learning-deployment limitation, not
a claim of disaster recovery. Moving `RESTIC_REPOSITORY` to SFTP, a NAS, or
object storage later does not require changing the backup script.

### Implementation

For the initial one-host learning deployment:

- create an automated daily logical PostgreSQL backup using a compatible
  PostgreSQL client image/tool;
- use custom format where it improves selective restore and verification;
- encrypt and store the result in `/var/backups/gatherly-restic` on the
  application host;
- retain a documented daily/weekly schedule sized to the data;
- write a manifest containing time, database identity, PostgreSQL/tool version,
  checksum, size, and application revision;
- alert when backup age exceeds the RPO, verification fails, or the local
  backup filesystem approaches its disk limit;
- protect backup credentials separately from application credentials;
- never write backup contents into CI artifacts or repository paths.

Do not treat Redis, Elasticsearch, or Kafka volumes as the primary recovery
source. After PostgreSQL restore:

```text
Redis cache/presence may be cleared
Elasticsearch is rebuilt from PostgreSQL
Kafka delivery state is assessed against retained outbox rows
search reconciliation proves the projection
```

If published outbox history has already been cleaned and Kafka was also lost,
a full search reindex is the repair. Permanent business state still comes from
PostgreSQL.

Install `restic` on the application host and create an encrypted local
repository. The repository must be outside the Git checkout and outside
Docker-managed PostgreSQL volumes. Use these complete host setup commands:

```bash
sudo install -d -o deploy -g deploy -m 0700 /var/backups/gatherly-restic
sudo install -d -o root -g deploy -m 0750 /etc/gatherly

openssl rand -base64 48 | sudo tee /etc/gatherly/restic-password > /dev/null
sudo chown root:deploy /etc/gatherly/restic-password
sudo chmod 0640 /etc/gatherly/restic-password
```

Store this **complete local configuration** as `/etc/gatherly/backup.env`,
owned by `root:deploy` with mode `0640`; never commit it:

```dotenv
RESTIC_REPOSITORY=/var/backups/gatherly-restic
RESTIC_PASSWORD_FILE=/etc/gatherly/restic-password
```

Initialize the repository exactly once:

```bash
sudo chown root:deploy /etc/gatherly/backup.env
sudo chmod 0640 /etc/gatherly/backup.env

sudo -u deploy env \
  RESTIC_REPOSITORY=/var/backups/gatherly-restic \
  RESTIC_PASSWORD_FILE=/etc/gatherly/restic-password \
  restic init
```

Do not run `restic init` again after snapshots exist. Keep a protected copy of
the Restic password outside the repository: without it, the encrypted local
snapshots cannot be restored.

Create `scripts/backup-postgres.sh` (**complete file**):

```bash
#!/usr/bin/env bash
set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly production_env="$repository_root/.env.production"
readonly backup_marker='/var/lib/gatherly/last-backup-success'
readonly temporary_directory="$(mktemp -d /tmp/gatherly-backup.XXXXXX)"
trap 'rm -rf -- "$temporary_directory"' EXIT

if [[ ! -f "$production_env" ]]; then
  echo "Missing $production_env" >&2
  exit 1
fi

set -a
# The production file is host-controlled shell-compatible KEY=value data.
# shellcheck disable=SC1090
source "$production_env"
set +a

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"

readonly recorded_at="$(date --utc +%Y-%m-%dT%H:%M:%SZ)"
readonly dump_file="$temporary_directory/gatherly.dump"
readonly manifest_file="$temporary_directory/manifest.txt"

cd "$repository_root"
docker compose \
  --env-file .env.production \
  -f compose.yaml \
  exec --no-TTY postgres \
  pg_dump \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --format custom \
    --no-owner \
    --no-privileges > "$dump_file"

docker run --rm --interactive \
  postgres:17-bookworm \
  pg_restore --list < "$dump_file" > /dev/null

{
  printf 'recorded_at_utc=%s\n' "$recorded_at"
  printf 'database=%s\n' "$POSTGRES_DB"
  printf 'application_revision=%s\n' "${APP_REVISION:-unknown}"
  printf 'dump_bytes=%s\n' "$(stat --format '%s' "$dump_file")"
  printf 'dump_sha256=%s\n' "$(sha256sum "$dump_file" | cut -d ' ' -f 1)"
} > "$manifest_file"

restic backup "$temporary_directory" \
  --tag gatherly \
  --tag postgresql \
  --host "$(hostname --fqdn)"

restic forget \
  --tag gatherly \
  --keep-daily 7 \
  --keep-weekly 4 \
  --keep-monthly 6 \
  --prune

install -d -o "$(id -u)" -g "$(id -g)" -m 0750 "$(dirname "$backup_marker")"
touch "$backup_marker"
echo "PostgreSQL backup completed at $recorded_at."
```

The `trap` deletes only the explicit `mktemp` directory created by this script.
Do not replace it with a broad path or unresolved environment variable.

Create `deploy/systemd/gatherly-backup.service` (**complete file**):

```ini
[Unit]
Description=Gatherly PostgreSQL backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=deploy
Group=deploy
WorkingDirectory=/srv/gatherly-backend
EnvironmentFile=/etc/gatherly/backup.env
ExecStart=/srv/gatherly-backend/scripts/backup-postgres.sh
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
PrivateTmp=true
NoNewPrivileges=true
```

Create `deploy/systemd/gatherly-backup.timer` (**complete file**):

```ini
[Unit]
Description=Run Gatherly PostgreSQL backup daily

[Timer]
OnCalendar=*-*-* 02:15:00 UTC
Persistent=true
RandomizedDelaySec=15m
Unit=gatherly-backup.service

[Install]
WantedBy=timers.target
```

Create `deploy/compose.restore-drill.yaml` (**complete isolated database**):

```yaml
services:
  restore-postgres:
    image: postgres:17-bookworm
    environment:
      POSTGRES_DB: gatherly_restore
      POSTGRES_USER: gatherly_restore
      POSTGRES_PASSWORD: ${RESTORE_POSTGRES_PASSWORD:?set RESTORE_POSTGRES_PASSWORD}
    ports:
      - '127.0.0.1:${RESTORE_POSTGRES_PORT:-55432}:5432'
    volumes:
      - restore_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U gatherly_restore -d gatherly_restore']
      interval: 2s
      timeout: 2s
      retries: 30
    restart: 'no'

volumes:
  restore_postgres_data:
```

Create `scripts/restore-postgres-drill.sh` (**complete file**):

```bash
#!/usr/bin/env bash
set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly dump_file="${1:-}"
readonly project='gatherly_restore_drill'

if [[ -z "$dump_file" || ! -f "$dump_file" ]]; then
  echo 'Usage: scripts/restore-postgres-drill.sh /absolute/path/to/gatherly.dump' >&2
  exit 2
fi
if [[ -z "${RESTORE_POSTGRES_PASSWORD:-}" ]]; then
  echo 'RESTORE_POSTGRES_PASSWORD is required.' >&2
  exit 2
fi

cleanup() {
  docker compose \
    --project-name "$project" \
    --file "$repository_root/deploy/compose.restore-drill.yaml" \
    down --volumes
}
trap cleanup EXIT

docker compose \
  --project-name "$project" \
  --file "$repository_root/deploy/compose.restore-drill.yaml" \
  up --detach --wait restore-postgres

cat "$dump_file" | docker compose \
  --project-name "$project" \
  --file "$repository_root/deploy/compose.restore-drill.yaml" \
  exec --no-TTY restore-postgres \
  pg_restore \
    --username gatherly_restore \
    --dbname gatherly_restore \
    --no-owner \
    --no-privileges \
    --exit-on-error

docker compose \
  --project-name "$project" \
  --file "$repository_root/deploy/compose.restore-drill.yaml" \
  exec --no-TTY restore-postgres \
  psql \
    --username gatherly_restore \
    --dbname gatherly_restore \
    --set ON_ERROR_STOP=1 \
    --command 'SELECT COUNT(*) AS users FROM users;' \
    --command 'SELECT COUNT(*) AS events FROM events;' \
    --command 'SELECT COUNT(*) AS reservations FROM reservations;'

echo 'Restore drill database checks completed successfully.'
```

The restore script owns and removes only the explicit
`gatherly_restore_drill` Compose project. Inspect that project name before
running the drill on any shared host.

### Restore drill

At least monthly in a disposable isolated environment:

1. Restore the latest encrypted snapshot from the local Restic repository and
   verify its manifest checksum.
2. Restore into a new empty PostgreSQL instance.
3. Run migration status without mutating production.
4. Start the exact compatible application image.
5. Run safe counts and the reservation/waitlist lifecycle smoke test.
6. Rebuild Elasticsearch and run reconciliation.
7. Record actual recovery point and elapsed restore time.
8. Destroy only the explicitly named disposable drill resources.

Never test restoration by overwriting the active production database.

### Verification

On the application host during a controlled maintenance window:

```bash
systemd-analyze verify \
  deploy/systemd/gatherly-backup.service \
  deploy/systemd/gatherly-backup.timer

sudo systemctl start gatherly-backup.service
sudo journalctl --unit gatherly-backup.service --since '10 minutes ago'

set -a
source /etc/gatherly/backup.env
set +a

restic snapshots --tag gatherly --tag postgresql
restic check

restore_directory="$(mktemp -d /tmp/gatherly-restore.XXXXXX)"
restic restore latest \
  --tag gatherly \
  --tag postgresql \
  --target "$restore_directory"

dump_file="$(find "$restore_directory" -type f -name gatherly.dump -print -quit)"
manifest_file="$(find "$restore_directory" -type f -name manifest.txt -print -quit)"
test -n "$dump_file"
test -n "$manifest_file"
expected_checksum="$(sed -n 's/^dump_sha256=//p' "$manifest_file")"
test -n "$expected_checksum"
printf '%s  %s\n' "$expected_checksum" "$dump_file" | sha256sum --check -

export RESTORE_POSTGRES_PASSWORD='<disposable-strong-password>'
scripts/restore-postgres-drill.sh "$dump_file"

findmnt --target /var/backups/gatherly-restic
df --human-readable /var/backups/gatherly-restic
```

After recording the evidence, inspect the resolved value before deleting only
the temporary directory created by `mktemp`:

```bash
restore_directory="$(realpath -- "$restore_directory")"
printf 'restore_directory=%s\n' "$restore_directory"
case "$restore_directory" in
  /tmp/gatherly-restore.*) ;;
  *) echo 'Refusing to remove an unexpected restore path.' >&2; exit 2 ;;
esac
rm -rf -- "$restore_directory"
```

Confirm the success marker changes only after `pg_restore --list` and the local
`restic backup` both succeed. Record the backup timestamp, restored snapshot
ID, elapsed restore time, row-count verification, backup filesystem free space,
and exact disposable Compose project removed by the trap.

### Exit evidence

The most recent drill restored a host-local Restic snapshot into a clean
database within the stated RTO, with measured RPO and application-level
verification. The evidence explicitly records that complete host loss is not
covered.

---

## Checkpoint 17: Harden the host and supply chain

### Reason

A hardened application container still depends on host patching, access,
network exposure, disk, registry, and TLS practices.

### Implementation

Minimum host baseline:

- supported Linux distribution with security updates;
- dedicated deployment account and separate operator access;
- key-only SSH, verified host keys, limited ingress, and login auditing;
- firewall exposing only SSH as required and Nginx 80/443;
- Docker, database, and telemetry ports bound to loopback/private networks;
- Nginx TLS with automatic certificate renewal and expiry monitoring;
- enough reserved disk for images, database growth, logs, traces, and backups;
- Docker log rotation and a deliberate image/BuildKit cache cleanup runbook;
- time synchronization;
- restrictive `.env`, backup, and Nginx include permissions;
- resource and PID bounds that leave deployment overlap headroom;
- no direct editing inside running containers;
- no routine `docker compose down`, volume deletion, or floating image updates.

Supply-chain baseline:

- frozen Yarn lockfile in CI and container builds;
- reviewed/pinned GitHub Action revisions;
- minimal workflow permissions;
- immutable runtime and migration image digest deployment;
- OCI revision/source labels and provenance where practical;
- dependency and base-image update cadence;
- vulnerability findings triaged by reachability and severity rather than an
  automatic destructive production change;
- prior known-good digests retained for rollback.

Create `deploy/host/host-preflight.sh` (**complete read-only check**):

```bash
#!/usr/bin/env bash
set -euo pipefail

readonly required_commands=(docker nginx curl git flock)
readonly required_files=(
  /etc/nginx/gatherly-backend-upstream.inc
  /usr/local/sbin/gatherly-switch-upstream
  /srv/gatherly-backend/.env.production
  /var/lib/gatherly/last-backup-success
)

if [[ "$EUID" -ne 0 ]]; then
  echo 'Run this read-only preflight with sudo so nginx -t can read TLS files.' >&2
  exit 2
fi

failed=0
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" > /dev/null; then
    echo "missing_command=$command_name"
    failed=1
  fi
done

for file_name in "${required_files[@]}"; do
  if [[ ! -f "$file_name" ]]; then
    echo "missing_file=$file_name"
    failed=1
  fi
done

echo "docker_version=$(docker version --format '{{.Server.Version}}')"
echo "compose_version=$(docker compose version --short)"
echo "root_filesystem_free=$(df --output=pcent / | tail -1 | tr -d ' ')"
echo "docker_filesystem_free=$(df --output=pcent /var/lib/docker | tail -1 | tr -d ' ')"
echo "backup_age_seconds=$(( $(date +%s) - $(stat -c %Y /var/lib/gatherly/last-backup-success) ))"

nginx -t
docker info --format 'docker_root={{.DockerRootDir}} logging_driver={{.LoggingDriver}}'
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
ss --tcp --listening --numeric --process

exit "$failed"
```

Create `deploy/host/sshd-gatherly.conf.example` (**complete drop-in**; validate
against a second open SSH session before reload):

```sshconfig
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
AllowUsers deploy operator
```

Create `deploy/host/README.md` with these **complete initial firewall commands**
for Ubuntu/UFW, replacing the SSH source range before execution:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 203.0.113.0/24 to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Do not execute the example documentation range `203.0.113.0/24`. Use the real
operator/CI source strategy and keep a second SSH session open while validating
firewall and SSH changes.

### Verification

From an external host, scan only the intended public name and confirm no
database, cache, broker, search, metrics, trace, Grafana, Uptime Kuma, or Docker
port is reachable. Reboot staging and prove restart policies recover services
in dependency-safe order without running destructive migrations.

### Exit evidence

The documented public attack surface is small, access is attributable, and a
host restart or image update does not depend on manual container mutation.

---

## Checkpoint 18: Run failure, load, and deployment drills

### Reason

Production hardening is the evidence that bounded failures preserve durable
truth and recover predictably. Happy-path smoke checks are insufficient.

### Implementation

Create reproducible staging drills for:

```text
PostgreSQL unavailable and restored
Redis unavailable during cache, rate limit, SSE, and WebSocket use
Kafka unavailable while event changes continue into the outbox
Elasticsearch unavailable while core REST remains healthy
OpenTelemetry Collector / Prometheus / Tempo unavailable
outbox publisher stopped long enough to create measurable age
search consumer stopped long enough to create measurable lag
malformed Kafka record reaches the dead-letter path
search document drift and full reindex repair
disk warning threshold and bounded logs
SIGTERM during an ordinary request, SSE stream, WebSocket, and worker batch
candidate readiness failure
post-cutover public verification failure and automatic traffic rollback
database restore into a clean environment
```

Use a load tool only against staging or an explicitly isolated environment.
Model useful traffic rather than one hot endpoint:

```text
event list/detail reads
authenticated reservation attempts with controlled conflicts
cancellation and waitlist promotion
SSE connection churn and replay
WebSocket connect/send/reconnect with bounded users
search requests while projection work runs
```

Measure latency, error semantics, CPU, memory, event-loop lag, PostgreSQL pool
waiters, reservation conflicts, live connections, outbox age, consumer lag, and
recovery time. Validate invariants in PostgreSQL after the test.

Do not load-test production or use real user tokens/data without explicit new
authorization.

Install k6 on the operator machine, not in the application runtime image.
Create `scripts/phase7-load.js` (**complete staging load script**):

```js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '2m', target: 10 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const baseUrl = __ENV.BASE_URL;
if (!baseUrl || !baseUrl.startsWith('https://')) {
  throw new Error('BASE_URL must be the HTTPS staging API origin.');
}

export default function () {
  const events = http.get(`${baseUrl}/api/events?limit=20`);
  check(events, { 'events returns 200': (response) => response.status === 200 });

  const search = http.get(`${baseUrl}/api/search/events?q=workshop&limit=10`);
  check(search, {
    'search returns success or explicit outage': (response) =>
      response.status === 200 || response.status === 503,
  });

  if (__ENV.EVENT_ID && __ENV.ACCESS_TOKEN) {
    const reservation = http.post(
      `${baseUrl}/api/events/${__ENV.EVENT_ID}/reservations`,
      JSON.stringify({}),
      {
        headers: {
          authorization: `Bearer ${__ENV.ACCESS_TOKEN}`,
          'content-type': 'application/json',
          'idempotency-key': `phase7-load-${__VU}-${__ITER}`,
        },
      },
    );
    check(reservation, {
      'reservation has a modeled outcome': (response) =>
        [200, 201, 409, 422, 429].includes(response.status),
    });
  }

  sleep(1);
}
```

Create `scripts/phase7-failure-drill.ps1` (**complete dependency drill
orchestrator**):

```powershell
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('redis', 'kafka', 'elasticsearch', 'outbox-publisher', 'search-consumer')]
  [string]$Service,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://')]
  [string]$StagingUrl,

  [Parameter(Mandatory = $true)]
  [ValidateSet('I-understand-this-is-staging')]
  [string]$Confirmation,

  [string]$ComposeProject = 'gatherly-staging'
)

$ErrorActionPreference = 'Stop'
$composeArguments = @(
  'compose',
  '--project-name', $ComposeProject,
  '--env-file', '.env.production',
  '--file', 'compose.yaml',
  '--file', 'deploy/compose.production.yaml'
)

function Invoke-Compose {
  param([string[]]$Arguments)
  & docker @composeArguments @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed with exit code $LASTEXITCODE"
  }
}

Write-Output "Stopping $Service in Compose project $ComposeProject"
Invoke-Compose -Arguments @('stop', $Service)

try {
  Start-Sleep -Seconds 15
  $live = Invoke-RestMethod -Uri "$StagingUrl/health/live" -TimeoutSec 5
  $readyStatus = $null
  try {
    Invoke-WebRequest -Uri "$StagingUrl/health/ready" -TimeoutSec 5 | Out-Null
    $readyStatus = 200
  }
  catch {
    $readyStatus = $_.Exception.Response.StatusCode.value__
  }

  Write-Output "liveness=$($live.status) readiness_status=$readyStatus"
  Invoke-Compose -Arguments @('logs', '--tail', '100', $Service)
}
finally {
  Write-Output "Starting $Service"
  Invoke-Compose -Arguments @('start', $Service)
  Start-Sleep -Seconds 15
  Invoke-RestMethod -Uri "$StagingUrl/health/live" -TimeoutSec 5 | Out-Null
}
```

Create `deploy/drills/assert-invariants.sql` (**complete post-drill query**).
Every query must return zero rows:

```sql
-- Duplicate confirmed reservations for one user/event.
SELECT event_id, user_id, COUNT(*)
FROM reservations
WHERE status = 'CONFIRMED'
GROUP BY event_id, user_id
HAVING COUNT(*) > 1;

-- Confirmed attendance above event capacity.
SELECT e.id, e.capacity, COUNT(r.id) AS confirmed
FROM events AS e
JOIN reservations AS r
  ON r.event_id = e.id
 AND r.status = 'CONFIRMED'
GROUP BY e.id, e.capacity
HAVING COUNT(r.id) > e.capacity;

-- User both confirmed and actively waitlisted.
SELECT r.event_id, r.user_id
FROM reservations AS r
JOIN waitlist_entries AS w
  ON w.event_id = r.event_id
 AND w.user_id = r.user_id
WHERE r.status = 'CONFIRMED'
  AND w.status IN ('WAITING', 'PLACE_OFFERED');

-- Duplicate processed Kafka event identity.
SELECT consumer_name, event_id, COUNT(*)
FROM processed_kafka_events
GROUP BY consumer_name, event_id
HAVING COUNT(*) > 1;
```

Run the SQL against staging after each drill and load test, then archive only
the zero-row result summary rather than a dump of private data.

### Verification

Run only against the explicit staging environment:

```powershell
$env:BASE_URL = 'https://staging-api.example.invalid'
k6 run scripts/phase7-load.js

foreach ($service in @(
  'redis',
  'kafka',
  'elasticsearch',
  'outbox-publisher',
  'search-consumer'
)) {
  .\scripts\phase7-failure-drill.ps1 `
    -Service $service `
    -StagingUrl $env:BASE_URL `
    -Confirmation I-understand-this-is-staging `
    -ComposeProject gatherly-staging
}

Get-Content -LiteralPath 'deploy\drills\assert-invariants.sql' -Raw |
  docker compose `
    --project-name gatherly-staging `
    --env-file .env.production `
    -f compose.yaml `
    -f deploy/compose.production.yaml `
    exec -T postgres `
    psql -U gatherly -d gatherly -v ON_ERROR_STOP=1
```

The SQL produces no result rows. Prometheus/Grafana show each degradation and
recovery, alerts fire and resolve as designed, and PostgreSQL business state is
unchanged except for the deliberately generated staging reservations.

### Exit evidence

Each drill states the expected degradation, actual signal, alert, recovery
action, recovery time, and post-recovery invariant check.

---

## Release runbook

### Normal automated release

```text
1. Merge a reviewed pull request after required CI passes.
2. CI builds and publishes immutable runtime and migration image digests from
   the same commit.
3. Deploy that digest to staging.
4. Run migration-overlap, health, representative read, realtime, worker, and
   projection smoke checks.
5. Observe staging for the chosen window.
6. Approve the protected production environment.
7. Production host lock is acquired.
8. Check active slot, free disk, backup freshness, dependency health, and
   migration compatibility.
9. Run forward migrations once.
10. Start the inactive slot and wait for readiness.
11. Run candidate loopback smoke checks.
12. Atomically change the Nginx include, validate, and gracefully reload.
13. Verify public TLS path and expected image revision.
14. Update and verify worker roles.
15. Observe error/latency/backlog signals.
16. Drain and gracefully stop the old HTTP slot.
17. Record result and release the host lock.
```

Never begin with `docker compose down`, stop Nginx, stop PostgreSQL, or stop the
active slot.

### Application rollback

```text
1. Identify the last known-good image digest and its schema compatibility.
2. Acquire the same production deployment lock.
3. Start the digest in the inactive slot.
4. Check readiness and smoke tests.
5. Switch and verify Nginx exactly like a forward deployment.
6. Roll worker roles to a compatible digest if needed.
7. Drain the faulty slot.
8. Record the rollback reason and incident timeline.
```

Do not automatically reverse migrations. If the old image is no longer schema
compatible, ship a forward fix or follow a separately reviewed data recovery
plan.

### Emergency upstream recovery

If Nginx points to an unhealthy slot but the other slot is healthy:

```bash
curl --fail http://127.0.0.1:<healthy-port>/health/ready
printf 'server 127.0.0.1:<healthy-port>;\n' > /tmp/gatherly-upstream.inc
sudo install -m 0644 /tmp/gatherly-upstream.inc \
  /etc/nginx/gatherly-backend-upstream.inc
sudo nginx -t
sudo nginx -s reload
curl --fail https://<api-host>/health/ready
```

Resolve and verify the exact healthy managed port first. Do not stop the other
slot until public verification succeeds.

---

## Incident runbook template

Use one short template for every operational scenario:

```text
title:
user impact:
detection signal and threshold:
first safe checks:
containment:
durable-state risk:
recovery steps:
verification:
rollback/rebuild decision:
escalation/owner:
evidence to retain:
follow-up:
```

During an incident:

1. Establish time, active slot, digest, deployment events, and user impact.
2. Preserve logs and telemetry before cleanup.
3. Prefer reversible traffic or process actions over database changes.
4. Do not clear queues, delete volumes, run reverse migrations, or rebuild
   search until the source of truth and recovery effect are understood.
5. Verify business invariants after service recovery.
6. Write a blameless timeline and turn repeated manual diagnosis into a signal,
   test, or runbook improvement.

---

## Common mistakes

```text
production deploys latest                       -> rollback target is ambiguous
production rebuilds tested commit               -> deployed bytes may differ
docker compose down during release              -> planned total outage
candidate starts before migration completes     -> unpredictable schema errors
destructive migration in same release           -> old slot/rollback breaks
automatic migrate down on candidate failure     -> data loss and active-code breakage
liveness checks every dependency                 -> restart cascade during outage
readiness includes Redis/Kafka/Elasticsearch     -> optional outage removes core API
Nginx file changed without nginx -t              -> avoidable proxy outage
old slot stopped before public verification      -> no immediate traffic rollback
CI concurrency cancels production deploy         -> half-finished state machine
GitHub concurrency without host lock             -> manual and CI deploy can race
both workers recreated without observation       -> hidden async outage
SSE/WebSockets ignored during drain              -> confusing client disconnects
/metrics publicly exposed                        -> topology and behavior leakage
raw URL/user/event ID used as metric label       -> unbounded cardinality
request or message bodies attached to traces     -> private data retention
health logs emitted every few seconds            -> useful logs buried
collector outage fails requests                  -> telemetry becomes a dependency
dashboard without operational question           -> decorative maintenance cost
alert without runbook/owner                      -> noise
local backup mistaken for disaster recovery     -> host loss destroys both copies
backup never restored                            -> recovery is an assumption
Elasticsearch/Kafka volume called the backup     -> rebuildable state mistaken for truth
load test uses production users                  -> unauthorized risk
blue/green called high availability              -> single-host failure still wins
```

---

## Suggested commit sequence

Keep the work reviewable:

```text
1. docs: define Phase 7 reliability and telemetry contracts
2. logging: centralize structured HTTP, audit, redaction, and request context
3. metrics: add bounded HTTP, database, domain, realtime, and worker metrics
4. tracing: initialize OpenTelemetry before ESM application imports
5. observability: add private Prometheus, Grafana, Tempo, Collector, and uptime stack
6. search: add projection metrics and reconciliation role
7. ci: add frozen-lockfile behavioral and image quality gates
8. release: publish attested immutable runtime and migration image digests
9. deploy: add production Compose roles and Nginx templates
10. deploy: add locked blue/green cutover, worker rollout, drain, and rollback
11. operations: add staging/production environment setup and runbooks
12. recovery: automate encrypted local backups and prove clean restoration
13. hardening: add alerts, host checks, and failure/load drill evidence
```

Do not combine observability, CI, Nginx, deployment automation, and backups into
one unreviewable change.

---

## Final examination

Phase 7 is complete when you can answer these without guessing:

1. What user-visible promise does each dashboard and alert protect?
2. Which dependencies determine general readiness, and why?
3. Why must telemetry failure never fail a reservation?
4. Which fields are forbidden from logs, traces, and metric labels?
5. How do request IDs, trace IDs, and application revisions connect evidence?
6. Why are raw paths and resource IDs dangerous Prometheus labels?
7. Which metric detects a stuck outbox sooner than request error rate?
8. How is Elasticsearch drift detected and repaired?
9. What exact runtime digest is active, which migration digest accompanied it,
   and which reviewed commit produced both?
10. Why does production never deploy `latest`?
11. Which CI job has package-write authority and which has production secrets?
12. Why are production Actions serialized without cancellation?
13. Why is a host-local deployment lock still required?
14. What remains serving while the candidate starts and migrations run?
15. Why must migrations be backward compatible with both slots?
16. What happens when candidate readiness fails before cutover?
17. What happens when public verification fails after cutover?
18. Why does traffic rollback not automatically reverse schema?
19. How do SSE and WebSocket clients recover after the old slot is drained?
20. How are singleton workers upgraded and separately verified?
21. What data is lost if Redis, Elasticsearch, or Kafka volumes disappear?
22. What evidence proves the PostgreSQL backup is restorable?
23. What are the current measured RPO and RTO?
24. Which ports are reachable from the Internet?
25. What failure is blue/green on one host unable to survive?

---

## Completion commands and evidence

Repository gate:

```powershell
yarn install --frozen-lockfile
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

Production configuration gate, using disposable non-secret values:

```bash
APP_IMAGE='gatherly-backend:test' \
  docker compose -f compose.yaml -f deploy/compose.production.yaml \
  --profile blue --profile green --profile tools config --quiet
sudo nginx -t
```

Final evidence set:

```text
CI run for the reviewed commit
published immutable runtime/migration image digests and provenance
successful staging deployment and smoke report
successful blue->green and green->blue production-style rehearsals
candidate-failure and post-cutover rollback rehearsal
SSE/WebSocket drain evidence
dashboard screenshots or exported JSON with alert/runbook links
search drift detection and repair evidence
local Restic backup manifest, disk evidence, and clean restore drill duration
external port exposure check
failure/load drill report with post-test invariant checks
```

The final deliverable is an observable and recoverable modular monolith with a
repeatable one-host deployment process. It is not a claim of multi-host high
availability.

## Official references

- [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/)
- [OpenTelemetry JavaScript Node.js setup](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/)
- [Prometheus metric and label practices](https://prometheus.io/docs/practices/naming/)
- [Prometheus alerting practices](https://prometheus.io/docs/practices/alerting/)
- [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/)
- [Grafana Tempo](https://grafana.com/docs/tempo/latest/)
- [GitHub Actions: publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub Actions: environments and deployment concurrency](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
- [GitHub Actions security hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [Docker Compose service reference](https://docs.docker.com/reference/compose-file/services/)
- [Docker Compose profiles](https://docs.docker.com/reference/compose-file/profiles/)
- [Nginx graceful configuration reload](https://nginx.org/en/docs/control.html)
- [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
- [PostgreSQL backup and restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL continuous archiving and point-in-time recovery](https://www.postgresql.org/docs/current/continuous-archiving.html)
- [Restic local repositories](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html#local)
- [Prisma production migrations](https://www.prisma.io/docs/orm/prisma-client/deployment/deploy-database-changes-with-prisma-migrate)
