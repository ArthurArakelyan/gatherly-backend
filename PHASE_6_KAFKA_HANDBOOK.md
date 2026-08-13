# Phase 6 Handbook: Kafka, Transactional Outbox, and Idempotent Consumers

This is the fifth Phase 6 implementation guide. It starts after
`PHASE_6_ELASTICSEARCH_HANDBOOK.md` and adds Kafka for one concrete Gatherly
need: reliably carrying committed event changes to the existing Elasticsearch
event-discovery projection.

The result is still one TypeScript/Node.js modular monolith, one codebase, and
one deployment. The HTTP process and two background worker processes use the
same image and modules. They are process roles, not microservices. PostgreSQL
remains authoritative. Kafka stores a replayable stream of integration events,
and Elasticsearch remains a disposable projection.

This handbook deliberately stops before Kafka Connect, Debezium, Schema
Registry, Avro/Protobuf, Kafka Streams, ksqlDB, cross-service sagas, event
sourcing, multi-region replication, Kubernetes, or production cluster design.
It does not add email or make normal HTTP responses wait for Kafka.

## How to use this handbook

Work through one checkpoint at a time. Each checkpoint contains:

1. **Reason:** the engineering lesson.
2. **Implementation:** exact files and copy-pasteable code.
3. **Verification:** a command, query, or failure experiment.
4. **Expected result:** the completion condition.

Code blocks labelled **complete file** replace the named file. Blocks labelled
**complete migration** or **complete test** contain no `...` placeholder.
Smaller blocks identify exactly where they belong. Preserve the completed
Elasticsearch increment in source control before starting.

The samples target the versions already installed or selected for this
increment:

```text
Node.js: 24.x in Docker
TypeScript: strict + NodeNext
KafkaJS: 2.2.x
@testcontainers/kafka: 12.0.x
local Kafka image: confluentinc/cp-kafka:8.1.4 (Apache Kafka 4.1)
PostgreSQL: 17.x
Elasticsearch: 9.4.x
```

Use Yarn Classic. Do not run `npm install` or create `package-lock.json`.

## Phase outcome

At the end of the implementation checkpoints, Gatherly has:

- a loopback-only, single-node local Kafka broker running in KRaft combined
  mode;
- explicitly created domain-event and dead-letter topics;
- a small versioned JSON event envelope validated with Zod;
- an `outbox_events` table written in the same PostgreSQL transaction as the
  event row;
- a bounded outbox publisher which uses `FOR UPDATE SKIP LOCKED`, Kafka message
  keys, acknowledgements from all in-sync replicas, and an idempotent KafkaJS
  producer;
- at-least-once publication with duplicate delivery treated as normal;
- an idempotent Elasticsearch consumer with a PostgreSQL processed-event
  ledger;
- deterministic poison records moved to a dead-letter topic while transient
  dependency failures are retried;
- independent HTTP, publisher, and consumer lifecycles from one application
  image;
- real PostgreSQL, Kafka, and Elasticsearch integration tests; and
- operational queries and drills for backlog, lag, duplicates, outages, replay,
  retention, and graceful shutdown.

The implemented path is:

```text
POST /api/communities/:communityId/events
  -> authorize against PostgreSQL
  -> BEGIN
       INSERT events
       INSERT outbox_events with event.changed.v1 envelope
     COMMIT
  -> return 201 without contacting Kafka or Elasticsearch

outbox publisher worker
  -> BEGIN
       lock oldest unpublished outbox row
       publish to gatherly.domain-events.v1
       mark outbox row published
     COMMIT
  -> crash after publish but before COMMIT means the same event is published again

search projection consumer group
  -> validate bytes as a supported envelope
  -> if processed-event marker exists, return successfully
  -> reread current eligible event projection from PostgreSQL
  -> index or delete Elasticsearch document using event ID as document ID
  -> insert processed-event marker
  -> return; KafkaJS may now commit the offset
```

There are two important crash windows:

| Window                                                              | Result                               | Required defence                       |
| ------------------------------------------------------------------- | ------------------------------------ | -------------------------------------- |
| PostgreSQL commits, process dies before Kafka publish               | unpublished outbox row remains       | publisher retries later                |
| Kafka accepts record, process dies before `published_at` commits    | record is published again            | idempotent consumer                    |
| Elasticsearch changes, consumer dies before processed marker/offset | record is consumed again             | event ID makes index/delete idempotent |
| processed marker commits, offset commit is lost                     | record is consumed again and skipped | unique processed-event key             |

The design promises **at-least-once delivery and effectively-once projection
state**, not magical end-to-end exactly-once execution. Kafka producer
idempotence removes some broker-retry duplicates during one producer session;
it cannot atomically commit PostgreSQL and Kafka or PostgreSQL and
Elasticsearch.

## Scope and deliberate omissions

Implement now:

- one shared topic, `gatherly.domain-events.v1`;
- one dead-letter topic, `gatherly.domain-events.dlq.v1`;
- the event type `gatherly.event.changed`, schema version `1`;
- the event ID as Kafka key so changes for one event use one partition;
- a minimal payload containing only `eventId`;
- explicit topic creation with automatic creation disabled;
- one publisher worker role and one search-consumer worker role;
- PostgreSQL outbox and processed-event retention procedures;
- local replication factor `1`, with a warning that this is not production
  durability;
- bounded messages, batches, retries, timeouts, and logs.

Do not implement now:

- publishing before the PostgreSQL transaction commits;
- calling Kafka directly from controllers or domain services;
- putting full event/community records in the message;
- treating a Kafka record as current authorization or search truth;
- one topic per event verb or one consumer group per process instance;
- random message keys when per-event ordering matters;
- Kafka transactions as a substitute for the PostgreSQL outbox;
- a broker-backed request/reply API;
- emailing users from a consumer;
- deleting canonical PostgreSQL data after publishing;
- an event-sourced aggregate reconstructed from Kafka;
- a production three-broker topology disguised as local Compose.

The narrow event payload is intentional. The search consumer loads current
canonical state, so several rapid event changes can safely converge on the
latest projection even when a duplicate is delayed.

---

## Checkpoint 1: Record the baseline and the concrete reason for Kafka

### Reason

The Elasticsearch increment currently schedules an in-memory, best-effort
projection after event creation commits. A crash in that gap or an
Elasticsearch outage can leave the index stale until a full maintenance-window
rebuild. That observed delivery gap is the reason to add durable asynchronous
work. “Kafka is on the roadmap” is not enough.

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
KafkaJS version from yarn.lock:
Testcontainers Kafka version from yarn.lock:
current best-effort projection call site:
failure being repaired:
baseline test result:
```

### Expected result

The Elasticsearch increment passes before Kafka code is introduced, and you
can point to the post-commit crash/outage gap Kafka will repair.

---

## Checkpoint 2: Define ownership, delivery, ordering, and compatibility

### Reason

Most Kafka mistakes begin as undefined semantics. Decide what a record means
before configuring a broker.

| Concern                                            | Gatherly decision                             |
| -------------------------------------------------- | --------------------------------------------- |
| durable business truth                             | PostgreSQL                                    |
| event transport and replay window                  | Kafka                                         |
| public discovery projection                        | Elasticsearch                                 |
| publication guarantee                              | at least once                                 |
| consumer effect                                    | idempotent index/delete plus processed ledger |
| ordering requirement                               | only changes for the same event               |
| message key                                        | `eventId`                                     |
| schema compatibility                               | explicit `type` plus integer `version`        |
| unknown event type                                 | ignored by unrelated consumers                |
| known type with unsupported version/malformed body | dead-lettered                                 |
| Kafka outage                                       | HTTP write still commits with outbox backlog  |
| Elasticsearch outage                               | consumer stops advancing; Kafka retains work  |

Kafka orders records within a partition, not across a topic. The event ID key
makes the producer partition all changes for one event consistently. Different
events may be processed concurrently and need no global order.

Consumer group names represent logical subscriptions and must remain stable:

```text
gatherly-search-projection-v1
```

Two instances with that group ID share partitions. Giving every replica a
random group ID would make every replica perform every projection. A future
analytics subscriber needs a different stable group because it represents a
different logical effect.

### Expected result

You can explain why at-least-once is honest, why duplicates are expected, why
the key is the event ID, and why Kafka/Elasticsearch are not authorization
sources.

---

## Checkpoint 3: Add a local KRaft broker and create topics explicitly

### Reason

The local broker teaches listeners, advertised addresses, topics, partitions,
consumer groups, and offsets. KRaft removes the obsolete ZooKeeper dependency.
Combined broker/controller mode and replication factor `1` are acceptable for
one-machine learning only; neither is a production topology.

The broker needs two advertised addresses:

```text
host tools and host workers: localhost:${KAFKA_PORT}
Compose services:            kafka:29092
```

### Implementation

Add to `.env.example`:

```dotenv
# Kafka domain events (local plaintext only)
KAFKA_PORT=9092
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=gatherly
KAFKA_DOMAIN_EVENTS_TOPIC=gatherly.domain-events.v1
KAFKA_DEAD_LETTER_TOPIC=gatherly.domain-events.dlq.v1
KAFKA_SEARCH_GROUP_ID=gatherly-search-projection-v1
KAFKA_REQUEST_TIMEOUT_MS=5000
KAFKA_OUTBOX_POLL_INTERVAL_MS=500
KAFKA_OUTBOX_BATCH_SIZE=25
```

Add these services to `compose.yaml`. YAML merge them under the existing
top-level `services` key:

```yaml
kafka:
  image: confluentinc/cp-kafka:8.1.4
  hostname: kafka
  ports:
    - '127.0.0.1:${KAFKA_PORT:-9092}:9092'
  environment:
    KAFKA_NODE_ID: 1
    KAFKA_PROCESS_ROLES: broker,controller
    KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:29093
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,HOST:PLAINTEXT
    KAFKA_LISTENERS: INTERNAL://0.0.0.0:29092,CONTROLLER://0.0.0.0:29093,HOST://0.0.0.0:9092
    KAFKA_ADVERTISED_LISTENERS: INTERNAL://kafka:29092,HOST://localhost:9092
    KAFKA_INTER_BROKER_LISTENER_NAME: INTERNAL
    KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
    KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false'
    KAFKA_LOG_RETENTION_HOURS: 24
    CLUSTER_ID: MkU3OEVBNTcwNTJENDM2Qk
  volumes:
    - kafka_data:/var/lib/kafka/data
  healthcheck:
    test: ['CMD-SHELL', 'kafka-topics --bootstrap-server 127.0.0.1:29092 --list > /dev/null 2>&1']
    interval: 10s
    timeout: 5s
    retries: 20
    start_period: 30s
  security_opt:
    - no-new-privileges:true
  pids_limit: 512
  mem_limit: 1g

kafka-init:
  image: confluentinc/cp-kafka:8.1.4
  depends_on:
    kafka:
      condition: service_healthy
  command:
    - sh
    - -ec
    - |
      kafka-topics --bootstrap-server kafka:29092 --create --if-not-exists \
        --topic gatherly.domain-events.v1 --partitions 3 --replication-factor 1
      kafka-topics --bootstrap-server kafka:29092 --create --if-not-exists \
        --topic gatherly.domain-events.dlq.v1 --partitions 3 --replication-factor 1
      kafka-topics --bootstrap-server kafka:29092 --describe \
        --topic gatherly.domain-events.v1
      kafka-topics --bootstrap-server kafka:29092 --describe \
        --topic gatherly.domain-events.dlq.v1
  restart: 'no'
```

Add the volume beneath the existing top-level `volumes` key:

```yaml
kafka_data:
```

The fixed cluster ID is acceptable only for this disposable local cluster. The
host listener advertises `localhost`, while containers receive `kafka:29092`.
Using the wrong advertised listener often produces a connection which succeeds
for bootstrap and then fails when metadata sends the client to an unreachable
address.

### Verification

```powershell
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose -f compose.yaml -f compose.dev.yaml up --detach kafka kafka-init
docker compose -f compose.yaml -f compose.dev.yaml ps --all
docker compose -f compose.yaml -f compose.dev.yaml logs kafka-init
docker compose -f compose.yaml -f compose.dev.yaml exec kafka `
  kafka-topics --bootstrap-server kafka:29092 --list
```

Describe the domain topic and verify three partitions and replication factor
one:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec kafka `
  kafka-topics --bootstrap-server kafka:29092 `
  --describe --topic gatherly.domain-events.v1
```

### Expected result

The broker becomes healthy, the init service exits zero, both topics exist,
and automatic topic creation is disabled. You can explain why local
replication factor one does not survive broker/data-volume loss.

---

## Checkpoint 4: Add the outbox and processed-event tables

### Reason

Writing an event row and then publishing to Kafka is a dual write:

```text
INSERT event succeeds -> Kafka send fails = missing event
Kafka send succeeds -> INSERT event rolls back = phantom event
```

Kafka cannot participate in the ordinary PostgreSQL transaction. The
transactional outbox writes business state and publish intent to the same
database transaction. A separate worker relays committed intent later.

The processed-event table is a durable idempotency ledger. Kafka offsets help
the consumer resume, but a crash after applying an external effect and before
the offset commit can redeliver the same record.

### Implementation

Create the next timestamped Prisma migration with this **complete migration**:

```sql
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  event_key text NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  payload jsonb NOT NULL,
  occurred_at timestamptz(6) NOT NULL DEFAULT now(),
  published_at timestamptz(6),
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  last_error text
);

CREATE INDEX outbox_events_unpublished_idx
  ON outbox_events (occurred_at, id)
  WHERE published_at IS NULL;

CREATE INDEX outbox_events_unpublished_key_idx
  ON outbox_events (event_key, occurred_at, id)
  WHERE published_at IS NULL;

CREATE TABLE processed_kafka_events (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  topic text NOT NULL,
  partition integer NOT NULL CHECK (partition >= 0),
  offset_value bigint NOT NULL CHECK (offset_value >= 0),
  processed_at timestamptz(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);

CREATE INDEX processed_kafka_events_processed_at_idx
  ON processed_kafka_events (processed_at);
```

Add these models to `prisma/schema.prisma`:

```prisma
model OutboxEvent {
  id              String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  topic           String
  eventKey        String    @map("event_key")
  eventType       String    @map("event_type")
  eventVersion    Int       @map("event_version")
  payload         Json      @db.JsonB
  occurredAt      DateTime  @default(now()) @map("occurred_at") @db.Timestamptz(6)
  publishedAt     DateTime? @map("published_at") @db.Timestamptz(6)
  publishAttempts Int       @default(0) @map("publish_attempts")
  lastError       String?   @map("last_error")

  @@map("outbox_events")
}

model ProcessedKafkaEvent {
  consumerName String   @map("consumer_name")
  eventId      String   @map("event_id") @db.Uuid
  topic        String
  partition    Int
  offsetValue  BigInt   @map("offset_value")
  processedAt  DateTime @default(now()) @map("processed_at") @db.Timestamptz(6)

  @@id([consumerName, eventId])
  @@index([processedAt], map: "processed_kafka_events_processed_at_idx")
  @@map("processed_kafka_events")
}
```

Do not add normal Prisma `@@index` declarations for unpublished rows. The
hand-written partial indexes are smaller and directly serve the publisher's
oldest-row and same-key-predecessor checks. They cost two index entries only
while a row is unpublished; setting `published_at` removes those entries.

Update `tests/helpers/postgres.ts` so reset order begins with the infrastructure
tables:

```sql
TRUNCATE TABLE
  processed_kafka_events,
  outbox_events,
  realtime_events,
  notifications,
  idempotency_keys,
  waitlist_entries,
  reservations,
  events,
  community_memberships,
  communities,
  users
RESTART IDENTITY CASCADE
```

### Verification

```powershell
yarn db:migrate:dev
yarn prisma:generate
yarn prisma:validate
yarn typecheck
```

Inspect the partial index:

```powershell
docker compose exec postgres psql -U gatherly -d gatherly -c `
  "SELECT indexdef FROM pg_indexes WHERE indexname = 'outbox_events_unpublished_idx';"
```

### Expected result

Prisma understands both tables, PostgreSQL owns their constraints, and the
publisher can find only unpublished rows without scanning retained history.

---

## Checkpoint 5: Define a small, versioned event envelope

### Reason

Kafka values are bytes. TypeScript types disappear at runtime, so every
consumer must validate the decoded value. The envelope separates routing and
compatibility metadata from event-specific data.

Do not publish the whole event row. It couples consumers to one storage shape,
copies fields that may already be stale by consumption time, increases privacy
and retention concerns, and tempts consumers to treat the message as current
authorization truth.

### Implementation

Create `src/shared/events/domain-event.ts` with this **complete file**:

```ts
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

export const DOMAIN_EVENTS_TOPIC = 'gatherly.domain-events.v1';
export const DEAD_LETTER_TOPIC = 'gatherly.domain-events.dlq.v1';
export const EVENT_CHANGED_TYPE = 'gatherly.event.changed';

const eventChangedDataSchema = z.object({ eventId: z.uuid() }).strict();

export const eventChangedEnvelopeSchema = z
  .object({
    id: z.uuid(),
    type: z.literal(EVENT_CHANGED_TYPE),
    version: z.literal(1),
    occurredAt: z.iso.datetime({ offset: true }),
    aggregate: z
      .object({
        type: z.literal('event'),
        id: z.uuid(),
      })
      .strict(),
    data: eventChangedDataSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.aggregate.id !== event.data.eventId) {
      context.addIssue({
        code: 'custom',
        path: ['aggregate', 'id'],
        message: 'aggregate.id must equal data.eventId',
      });
    }
  });

export type EventChangedEnvelope = z.infer<typeof eventChangedEnvelopeSchema>;

export const createEventChangedEnvelope = (
  eventId: string,
  occurredAt = new Date(),
): EventChangedEnvelope =>
  eventChangedEnvelopeSchema.parse({
    id: randomUUID(),
    type: EVENT_CHANGED_TYPE,
    version: 1,
    occurredAt: occurredAt.toISOString(),
    aggregate: { type: 'event', id: eventId },
    data: { eventId },
  });

const baseEnvelopeSchema = z
  .object({
    id: z.uuid(),
    type: z.string().min(1).max(120),
    version: z.number().int().positive(),
  })
  .passthrough();

export type EnvelopeIdentity = z.infer<typeof baseEnvelopeSchema>;

export const parseEnvelopeIdentity = (value: unknown): EnvelopeIdentity =>
  baseEnvelopeSchema.parse(value);
```

The event ID is present as the Kafka key, aggregate ID, and data field on
purpose. The key controls partitioning; the envelope is self-describing when
stored or inspected; the data object belongs to the specific event schema. The
schema asserts they agree.

Create `tests/unit/domain-event.test.ts` with this **complete test**:

```ts
import { describe, expect, it } from 'vitest';

import {
  createEventChangedEnvelope,
  eventChangedEnvelopeSchema,
} from '../../src/shared/events/domain-event.js';

describe('event changed envelope', () => {
  it('creates a versioned envelope with one consistent aggregate ID', () => {
    const eventId = '00000000-0000-4000-8000-000000000001';
    const occurredAt = new Date('2030-08-03T18:00:00.000Z');

    const envelope = createEventChangedEnvelope(eventId, occurredAt);

    expect(envelope.type).toBe('gatherly.event.changed');
    expect(envelope.version).toBe(1);
    expect(envelope.occurredAt).toBe('2030-08-03T18:00:00.000Z');
    expect(envelope.aggregate).toEqual({ type: 'event', id: eventId });
    expect(envelope.data).toEqual({ eventId });
  });

  it('rejects a mismatched aggregate and payload ID', () => {
    expect(() =>
      eventChangedEnvelopeSchema.parse({
        id: '00000000-0000-4000-8000-000000000010',
        type: 'gatherly.event.changed',
        version: 1,
        occurredAt: '2030-08-03T18:00:00.000Z',
        aggregate: {
          type: 'event',
          id: '00000000-0000-4000-8000-000000000001',
        },
        data: { eventId: '00000000-0000-4000-8000-000000000002' },
      }),
    ).toThrow();
  });

  it('rejects a future version until the consumer explicitly supports it', () => {
    const envelope = createEventChangedEnvelope('00000000-0000-4000-8000-000000000001');

    expect(() => eventChangedEnvelopeSchema.parse({ ...envelope, version: 2 })).toThrow();
  });
});
```

### Verification

```powershell
yarn vitest run tests/unit/domain-event.test.ts
yarn typecheck
yarn lint
```

### Expected result

The producer and consumer share one runtime-validated version-1 contract, and
unsupported versions fail explicitly instead of being silently misread.

---

## Checkpoint 6: Write the event and outbox record in one transaction

### Reason

The outbox pattern is not “save an event, then save a queue row.” Both writes
must share one PostgreSQL transaction. If either insert fails, neither may
remain. The HTTP service does not schedule in-memory search work and never
opens a Kafka connection.

### Implementation

Replace `src/modules/events/events.repository.ts` with this **complete file**:

```ts
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

import { AppError } from '../../shared/errors/app-error.js';
import {
  createEventChangedEnvelope,
  DOMAIN_EVENTS_TOPIC,
} from '../../shared/events/domain-event.js';
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
      return await this.prisma.$transaction(async (transaction) => {
        const record = await transaction.event.create({
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

        const envelope = createEventChangedEnvelope(record.id, record.updatedAt);
        await transaction.outboxEvent.create({
          data: {
            id: envelope.id,
            topic: DOMAIN_EVENTS_TOPIC,
            eventKey: record.id,
            eventType: envelope.type,
            eventVersion: envelope.version,
            payload: envelope,
            occurredAt: new Date(envelope.occurredAt),
          },
        });

        return mapEvent(record);
      });
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
      status: filters.status ?? { in: ['PUBLISHED', 'CANCELLED', 'COMPLETED'] },
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

In `src/modules/events/events.service.ts`, remove `EventSearchProjection` from
the imports, remove the third constructor parameter, and remove this line from
`create`:

```ts
this.searchProjection?.schedule(event.id);
```

The constructor becomes:

```ts
public constructor(
  private readonly repository: EventsRepository,
  private readonly cache?: EventCache,
) {}
```

Delete `EventSearchProjection` from `src/modules/events/events.types.ts`. In
`src/server.ts`, remove `eventSearchSource`, `eventSearchIndex`, and
`eventSearchProjector`; pass only the repository and cache to `EventsService`;
remove the projector's `drain()` call; and remove the now-unused
`BestEffortEventSearchProjector`, `EventSearchSourceRepository`, and
`EventSearchIndex` imports. The HTTP process still owns the Elasticsearch
client for search requests, but no longer writes the projection.

Future event update, publish, cancel, and community archive transactions must
write the same `event.changed` intent for each affected event. Do not add an
outbox event from a controller after a repository returns.

### Verification

Create an event through the API, then inspect the paired rows:

```powershell
docker compose exec postgres psql -U gatherly -d gatherly -c `
  "SELECT e.id, e.title, o.id AS outbox_id, o.event_type, o.published_at
   FROM events e
   JOIN outbox_events o ON o.event_key = e.id::text
   ORDER BY e.created_at DESC
   LIMIT 5;"
```

Before the publisher exists, `published_at` remains null. That backlog is
correct and durable.

### Expected result

Every successful event creation has one matching committed outbox row, a
failed transaction leaves neither row, and the HTTP request does not depend on
Kafka or Elasticsearch availability.

---

## Checkpoint 7: Validate worker configuration and own one Kafka client

### Reason

Workers should not import the HTTP server's full environment schema. The
publisher needs PostgreSQL and Kafka; the search consumer additionally needs
Elasticsearch. Requiring JWT, Redis, CORS, or WebSocket values in a worker
creates accidental coupling.

Kafka bootstrap addresses are only the first contact points. The broker then
returns advertised listener addresses, so use `localhost:9092` for host-run
workers and `kafka:29092` for Compose workers.

### Implementation

Create `src/config/kafka-worker-env.ts` with this **complete file**:

```ts
import { z } from 'zod';

import { DEAD_LETTER_TOPIC, DOMAIN_EVENTS_TOPIC } from '../shared/events/domain-event.js';
import { elasticsearchEnvironmentShape } from './elasticsearch-environment.js';

const brokersSchema = z
  .string()
  .transform((value) => value.split(',').map((broker) => broker.trim()))
  .pipe(z.array(z.string().min(1)).min(1));

const databaseShape = {
  DATABASE_URL: z.url(),
  PRISMA_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
};

const kafkaShape = {
  KAFKA_BROKERS: brokersSchema,
  KAFKA_CLIENT_ID: z.string().min(1).max(100).default('gatherly'),
  KAFKA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
};

const outboxPublisherEnvironmentSchema = z.object({
  ...databaseShape,
  ...kafkaShape,
  KAFKA_DOMAIN_EVENTS_TOPIC: z.literal(DOMAIN_EVENTS_TOPIC).default(DOMAIN_EVENTS_TOPIC),
  KAFKA_OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(500),
  KAFKA_OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
});

const searchConsumerEnvironmentSchema = z.object({
  ...databaseShape,
  ...kafkaShape,
  ...elasticsearchEnvironmentShape,
  KAFKA_DOMAIN_EVENTS_TOPIC: z.literal(DOMAIN_EVENTS_TOPIC).default(DOMAIN_EVENTS_TOPIC),
  KAFKA_DEAD_LETTER_TOPIC: z.literal(DEAD_LETTER_TOPIC).default(DEAD_LETTER_TOPIC),
  KAFKA_SEARCH_GROUP_ID: z.string().min(1).max(200).default('gatherly-search-projection-v1'),
});

export type OutboxPublisherEnvironment = z.infer<typeof outboxPublisherEnvironmentSchema>;
export type SearchConsumerEnvironment = z.infer<typeof searchConsumerEnvironmentSchema>;

export const parseOutboxPublisherEnvironment = (
  input: NodeJS.ProcessEnv,
): OutboxPublisherEnvironment => outboxPublisherEnvironmentSchema.parse(input);

export const parseSearchConsumerEnvironment = (
  input: NodeJS.ProcessEnv,
): SearchConsumerEnvironment => searchConsumerEnvironmentSchema.parse(input);
```

Create `src/infrastructure/kafka/client.ts` with this **complete file**:

```ts
import { Kafka, logLevel } from 'kafkajs';

interface KafkaConfiguration {
  KAFKA_BROKERS: string[];
  KAFKA_CLIENT_ID: string;
  KAFKA_REQUEST_TIMEOUT_MS: number;
}

export const createKafkaClient = (
  configuration: KafkaConfiguration,
  role: 'outbox-publisher' | 'search-consumer',
): Kafka =>
  new Kafka({
    clientId: `${configuration.KAFKA_CLIENT_ID}-${role}`,
    brokers: configuration.KAFKA_BROKERS,
    connectionTimeout: configuration.KAFKA_REQUEST_TIMEOUT_MS,
    requestTimeout: configuration.KAFKA_REQUEST_TIMEOUT_MS,
    enforceRequestTimeout: true,
    logLevel: logLevel.WARN,
    retry: {
      initialRetryTime: 300,
      retries: 8,
      factor: 0.2,
      multiplier: 2,
      maxRetryTime: 10_000,
    },
  });
```

Plaintext is local-only. A later deployment should inject TLS/SASL settings and
secrets without logging them. Do not copy a local `ssl: false` assumption into
production configuration.

### Verification

Create `tests/unit/kafka-worker-env.test.ts` with this **complete test**:

```ts
import { describe, expect, it } from 'vitest';

import {
  parseOutboxPublisherEnvironment,
  parseSearchConsumerEnvironment,
} from '../../src/config/kafka-worker-env.js';

const publisherEnvironment = {
  DATABASE_URL: 'postgresql://gatherly:gatherly@localhost:5432/gatherly',
  PRISMA_POOL_MAX: '5',
  KAFKA_BROKERS: 'localhost:9092, localhost:9093',
  KAFKA_CLIENT_ID: 'gatherly-test',
  KAFKA_DOMAIN_EVENTS_TOPIC: 'gatherly.domain-events.v1',
  KAFKA_DEAD_LETTER_TOPIC: 'gatherly.domain-events.dlq.v1',
  KAFKA_REQUEST_TIMEOUT_MS: '5000',
  KAFKA_OUTBOX_POLL_INTERVAL_MS: '500',
  KAFKA_OUTBOX_BATCH_SIZE: '25',
};

describe('Kafka worker environment', () => {
  it('parses and trims a comma-separated broker list', () => {
    const parsed = parseOutboxPublisherEnvironment(publisherEnvironment);

    expect(parsed.KAFKA_BROKERS).toEqual(['localhost:9092', 'localhost:9093']);
    expect(parsed.KAFKA_OUTBOX_BATCH_SIZE).toBe(25);
  });

  it('rejects blank brokers and topic-name drift', () => {
    expect(() =>
      parseOutboxPublisherEnvironment({
        ...publisherEnvironment,
        KAFKA_BROKERS: ' , ',
      }),
    ).toThrow();
    expect(() =>
      parseOutboxPublisherEnvironment({
        ...publisherEnvironment,
        KAFKA_DOMAIN_EVENTS_TOPIC: 'typo.domain-events.v1',
      }),
    ).toThrow();
  });

  it('requires Elasticsearch only for the search consumer role', () => {
    expect(() => parseSearchConsumerEnvironment(publisherEnvironment)).toThrow();

    const parsed = parseSearchConsumerEnvironment({
      ...publisherEnvironment,
      KAFKA_SEARCH_GROUP_ID: 'gatherly-search-projection-v1',
      ELASTICSEARCH_URL: 'http://localhost:9200',
      ELASTICSEARCH_REQUEST_TIMEOUT_MS: '2000',
      ELASTICSEARCH_INDEX_PREFIX: 'gatherly-events',
    });
    expect(parsed.KAFKA_SEARCH_GROUP_ID).toBe('gatherly-search-projection-v1');
  });
});
```

Then run:

```powershell
yarn vitest run tests/unit/kafka-worker-env.test.ts
yarn typecheck
yarn lint
```

### Expected result

Each worker validates only its required configuration, topic names cannot
silently diverge from the producer contract, and client IDs identify the
logical role rather than a user or secret.

---

## Checkpoint 8: Relay committed outbox rows with bounded locking

### Reason

The publisher must never mark a row before Kafka acknowledges it. This
implementation locks one oldest eligible row, sends it, and marks it published
inside a short PostgreSQL transaction. `SKIP LOCKED` prevents two publisher
instances from selecting the same row concurrently. The predecessor check
prevents a later unpublished record for one event from passing an earlier
unpublished record for that same event. Unrelated event keys can still
progress.

The transaction stays open during one bounded broker call. That is a conscious
learning tradeoff: it gives a small, understandable state machine but holds a
database connection and row lock during network I/O. Keep the batch and Kafka
timeout bounded. A later high-throughput design can use claimed rows with
leases, but then it must implement expired-claim recovery and ordering
carefully.

Even here, a broker acknowledgement followed by process/database failure can
roll back `published_at`. The next attempt publishes the same envelope again.
This is why consumer idempotency is mandatory.

### Implementation

Create `src/infrastructure/kafka/outbox.repository.ts` with this **complete
file**:

```ts
import type { ProducerRecord } from 'kafkajs';

import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import {
  DOMAIN_EVENTS_TOPIC,
  eventChangedEnvelopeSchema,
} from '../../shared/events/domain-event.js';

interface LockedOutboxRow {
  id: string;
  topic: string;
  eventKey: string;
  payload: Prisma.JsonValue;
}

export type PublishOutboxRecord = (record: ProducerRecord) => Promise<void>;

const safeError = (error: unknown): string => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  return text.slice(0, 2_000);
};

export class OutboxRepository {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly transactionTimeoutMs: number,
  ) {}

  public async publishNext(publish: PublishOutboxRecord): Promise<boolean> {
    let selectedId: string | undefined;

    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const rows = await transaction.$queryRaw<LockedOutboxRow[]>`
            SELECT
              id::text,
              topic,
              event_key AS "eventKey",
              payload
            FROM outbox_events AS candidate
            WHERE candidate.published_at IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM outbox_events AS predecessor
                WHERE predecessor.event_key = candidate.event_key
                  AND predecessor.published_at IS NULL
                  AND (predecessor.occurred_at, predecessor.id)
                    < (candidate.occurred_at, candidate.id)
              )
            ORDER BY candidate.occurred_at ASC, candidate.id ASC
            FOR UPDATE OF candidate SKIP LOCKED
            LIMIT 1
          `;

          const row = rows[0];
          if (row === undefined) return false;
          selectedId = row.id;

          const envelope = eventChangedEnvelopeSchema.parse(row.payload);
          if (row.topic !== DOMAIN_EVENTS_TOPIC) {
            throw new Error('Outbox row targets an unsupported topic');
          }
          if (row.eventKey !== envelope.aggregate.id) {
            throw new Error('Outbox key does not match its aggregate ID');
          }

          await publish({
            topic: row.topic,
            messages: [
              {
                key: row.eventKey,
                value: JSON.stringify(envelope),
                timestamp: String(new Date(envelope.occurredAt).getTime()),
                headers: {
                  'event-id': envelope.id,
                  'event-type': envelope.type,
                  'event-version': String(envelope.version),
                  'content-type': 'application/json',
                },
              },
            ],
          });

          const update = await transaction.outboxEvent.updateMany({
            where: { id: row.id, publishedAt: null },
            data: {
              publishedAt: new Date(),
              publishAttempts: { increment: 1 },
              lastError: null,
            },
          });
          if (update.count !== 1) throw new Error('Locked outbox row was not updated');
          return true;
        },
        { maxWait: 2_000, timeout: this.transactionTimeoutMs },
      );
    } catch (error) {
      if (selectedId !== undefined) {
        try {
          await this.prisma.outboxEvent.updateMany({
            where: { id: selectedId, publishedAt: null },
            data: {
              publishAttempts: { increment: 1 },
              lastError: safeError(error),
            },
          });
        } catch (recordingError) {
          throw new AggregateError(
            [error, recordingError],
            'Outbox publication and failure recording both failed',
          );
        }
      }
      throw error;
    }
  }
}
```

Create `src/workers/outbox-publisher-runner.ts` with this **complete file**:

```ts
import type { Producer } from 'kafkajs';
import type { Logger } from 'pino';

import type { OutboxRepository } from '../infrastructure/kafka/outbox.repository.js';

interface OutboxPublisherOptions {
  batchSize: number;
  idleDelayMs: number;
  failureDelayMs: number;
  requestTimeoutMs: number;
}

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });

export class OutboxPublisherRunner {
  public constructor(
    private readonly repository: OutboxRepository,
    private readonly producer: Producer,
    private readonly logger: Logger,
    private readonly options: OutboxPublisherOptions,
  ) {}

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let published = 0;

      try {
        for (let index = 0; index < this.options.batchSize; index += 1) {
          if (signal.aborted) break;
          const found = await this.repository.publishNext(async (record) => {
            await this.producer.send({
              ...record,
              acks: -1,
              timeout: this.options.requestTimeoutMs,
            });
          });
          if (!found) break;
          published += 1;
        }
      } catch (error) {
        this.logger.error({ err: error }, 'Outbox publication attempt failed');
        await delay(this.options.failureDelayMs, signal);
        continue;
      }

      if (published > 0) {
        this.logger.debug({ published }, 'Published outbox batch');
      } else {
        await delay(this.options.idleDelayMs, signal);
      }
    }
  }
}
```

The producer used by the entrypoint must be created with:

```ts
const producer = kafka.producer({
  allowAutoTopicCreation: false,
  idempotent: true,
  maxInFlightRequests: 5,
});
```

`acks: -1` means all current in-sync replicas must acknowledge. In the local
single-broker cluster that is still only one replica. KafkaJS producer
idempotence helps prevent duplicates caused by producer retries in one session;
it does not close the outbox crash window.

### Verification

With Kafka stopped, create an event and confirm the HTTP request succeeds while
the outbox row remains unpublished. Start Kafka and the publisher later; the
same row must become published.

Inspect backlog and oldest age:

```sql
SELECT
  count(*) AS unpublished,
  min(occurred_at) AS oldest_unpublished_at,
  now() - min(occurred_at) AS oldest_age,
  max(publish_attempts) AS maximum_attempts
FROM outbox_events
WHERE published_at IS NULL;
```

### Expected result

The publisher sends oldest committed work in bounded batches, does not lose a
row on broker failure, records safe failure text, and leaves duplicate defence
to consumers instead of claiming exactly-once delivery.

---

## Checkpoint 9: Make the search projection explicitly idempotent

### Reason

Kafka may redeliver after a rebalance, process crash, lost offset commit, or
outbox crash window. The search operation must therefore be safe to repeat.

Elasticsearch document writes already have a natural idempotency key: the
PostgreSQL event UUID is the Elasticsearch `_id`. Re-indexing the current
canonical document replaces the same document; deleting a missing document is
treated as success. The consumer also records a processed event ID to avoid
unnecessary repeated reads and writes.

The Elasticsearch write and PostgreSQL marker cannot share one atomic
transaction. The safe order is effect first, marker second:

```text
effect succeeds, marker fails -> repeat idempotent effect
marker succeeds, offset commit fails -> ledger skips duplicate
effect fails -> no marker, Kafka record remains retryable
```

Writing the marker first would lose the projection if Elasticsearch then
failed.

### Implementation

Replace `src/modules/search/event-search-projector.ts` with this **complete
file**:

```ts
import type { EventSearchIndex } from '../../infrastructure/elasticsearch/event-search-index.js';
import type { EventSearchSourceRepository } from './event-search-source.repository.js';

export class EventSearchProjector {
  public constructor(
    private readonly source: EventSearchSourceRepository,
    private readonly index: EventSearchIndex,
  ) {}

  public async sync(eventId: string): Promise<'indexed' | 'deleted'> {
    const document = await this.source.findEligibleById(eventId);
    if (document === null) {
      await this.index.delete(eventId);
      return 'deleted';
    }

    await this.index.index(document);
    return 'indexed';
  }
}
```

Create `src/infrastructure/kafka/processed-events.repository.ts` with this
**complete file**:

```ts
import type { PrismaClient } from '../../generated/prisma/client.js';

export interface KafkaRecordPosition {
  topic: string;
  partition: number;
  offset: string;
}

export class ProcessedEventsRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async hasProcessed(consumerName: string, eventId: string): Promise<boolean> {
    const record = await this.prisma.processedKafkaEvent.findUnique({
      where: {
        consumerName_eventId: { consumerName, eventId },
      },
      select: { eventId: true },
    });
    return record !== null;
  }

  public async markProcessed(
    consumerName: string,
    eventId: string,
    position: KafkaRecordPosition,
  ): Promise<void> {
    await this.prisma.processedKafkaEvent.createMany({
      data: {
        consumerName,
        eventId,
        topic: position.topic,
        partition: position.partition,
        offsetValue: BigInt(position.offset),
      },
      skipDuplicates: true,
    });
  }
}
```

The primary key includes the logical consumer name. Another subscriber may
legitimately process the same domain event for a different effect.

For a future consumer whose effect is entirely in PostgreSQL, use one database
transaction for the effect and marker. This pattern is the complete shape:

```ts
await prisma.$transaction(async (transaction) => {
  const alreadyProcessed = await transaction.processedKafkaEvent.findUnique({
    where: {
      consumerName_eventId: { consumerName, eventId: envelope.id },
    },
    select: { eventId: true },
  });
  if (alreadyProcessed !== null) return;

  await transaction.notification.create({
    data: {
      userId,
      type: 'EXAMPLE_IN_APP_ONLY',
      title: 'Example',
      message: 'Example PostgreSQL consumer effect',
      data: { sourceEventId: envelope.id },
    },
  });

  await transaction.processedKafkaEvent.create({
    data: {
      consumerName,
      eventId: envelope.id,
      topic,
      partition,
      offsetValue: BigInt(offset),
    },
  });
});
```

Do not add that example notification to Gatherly merely to demonstrate Kafka.
The existing search drift is the concrete use for this increment.

### Verification

Call `sync(eventId)` twice for an eligible event and confirm Elasticsearch has
one document with that ID. Make the event ineligible, call it twice again, and
confirm the document is absent without a 404 failure escaping.

### Expected result

Repeated delivery converges to one current search document or no document, and
the processed ledger is an optimization and audit clue rather than the only
thing preventing corruption.

---

## Checkpoint 10: Validate consumed bytes and dead-letter poison records

### Reason

Transient failures and deterministic poison records need different treatment:

- PostgreSQL, Kafka, or Elasticsearch unavailable: throw and retry later;
- malformed JSON, mismatched key, or unsupported version of a known event:
  publish diagnostic context to the dead-letter topic, then let the source
  offset advance;
- valid but unrelated event type on the shared topic: ignore successfully;
- duplicate event ID already processed by this group: skip successfully.

Retrying malformed bytes forever blocks a partition. Swallowing all exceptions
loses transient work. Logging the complete message can leak retained data, so
the normal log contains metadata and reason only; the bounded raw value is
stored in the access-controlled dead-letter topic.

### Implementation

Create `src/modules/search/search-projection-consumer.ts` with this **complete
file**:

```ts
import type { KafkaMessage } from 'kafkajs';
import { ZodError } from 'zod';

import type {
  KafkaRecordPosition,
  ProcessedEventsRepository,
} from '../../infrastructure/kafka/processed-events.repository.js';
import {
  EVENT_CHANGED_TYPE,
  eventChangedEnvelopeSchema,
  parseEnvelopeIdentity,
} from '../../shared/events/domain-event.js';
import type { EventSearchProjector } from './event-search-projector.js';

export class PoisonKafkaRecordError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PoisonKafkaRecordError';
  }
}

interface ConsumedRecord extends KafkaRecordPosition {
  message: KafkaMessage;
}

export type SearchProjectionOutcome = 'indexed' | 'deleted' | 'duplicate' | 'ignored';

const decodeJson = (message: KafkaMessage): unknown => {
  if (message.value === null) throw new PoisonKafkaRecordError('Message value is null');
  if (message.value.byteLength > 65_536) {
    throw new PoisonKafkaRecordError('Message value exceeds 65536 bytes');
  }

  try {
    return JSON.parse(message.value.toString('utf8')) as unknown;
  } catch (error) {
    throw new PoisonKafkaRecordError('Message value is not valid JSON', { cause: error });
  }
};

export class SearchProjectionConsumer {
  public constructor(
    private readonly consumerName: string,
    private readonly processedEvents: ProcessedEventsRepository,
    private readonly projector: EventSearchProjector,
  ) {}

  public async handle(record: ConsumedRecord): Promise<SearchProjectionOutcome> {
    const decoded = decodeJson(record.message);

    let identity: ReturnType<typeof parseEnvelopeIdentity>;
    try {
      identity = parseEnvelopeIdentity(decoded);
    } catch (error) {
      throw new PoisonKafkaRecordError('Message has no valid envelope identity', {
        cause: error,
      });
    }

    if (identity.type !== EVENT_CHANGED_TYPE) return 'ignored';

    let envelope;
    try {
      envelope = eventChangedEnvelopeSchema.parse(decoded);
    } catch (error) {
      const reason =
        error instanceof ZodError
          ? `Event envelope validation failed: ${error.issues[0]?.message ?? 'invalid'}`
          : 'Event envelope validation failed';
      throw new PoisonKafkaRecordError(reason, { cause: error });
    }

    const key = record.message.key?.toString('utf8');
    if (key !== envelope.aggregate.id) {
      throw new PoisonKafkaRecordError('Kafka key does not match the event aggregate ID');
    }

    if (await this.processedEvents.hasProcessed(this.consumerName, envelope.id)) {
      return 'duplicate';
    }

    const outcome = await this.projector.sync(envelope.data.eventId);
    await this.processedEvents.markProcessed(this.consumerName, envelope.id, record);
    return outcome;
  }
}
```

Create `src/infrastructure/kafka/dead-letter.ts` with this **complete file**:

```ts
import { randomUUID } from 'node:crypto';

import type { KafkaMessage, Producer } from 'kafkajs';

interface DeadLetterSource {
  topic: string;
  partition: number;
  message: KafkaMessage;
}

const bounded = (value: string, maximum: number): string => value.slice(0, maximum);

export const publishDeadLetter = async (
  producer: Producer,
  deadLetterTopic: string,
  source: DeadLetterSource,
  reason: string,
  requestTimeoutMs: number,
): Promise<void> => {
  const record = {
    id: randomUUID(),
    failedAt: new Date().toISOString(),
    reason: bounded(reason, 1_000),
    source: {
      topic: source.topic,
      partition: source.partition,
      offset: source.message.offset,
      keyBase64: source.message.key?.toString('base64') ?? null,
      valueBase64: source.message.value?.subarray(0, 65_536).toString('base64') ?? null,
      valueTruncated: (source.message.value?.byteLength ?? 0) > 65_536,
    },
  };

  await producer.send({
    topic: deadLetterTopic,
    acks: -1,
    timeout: requestTimeoutMs,
    messages: [
      {
        key: source.message.key,
        value: JSON.stringify(record),
        headers: {
          'dead-letter-id': record.id,
          'source-topic': source.topic,
          'source-partition': String(source.partition),
          'source-offset': source.message.offset,
          'content-type': 'application/json',
        },
      },
    ],
  });
};
```

If dead-letter publication fails, let that error escape. The source handler
must not return successfully and advance its offset until the poison record is
preserved. A crash after dead-letter publication but before source offset
commit may duplicate the dead-letter record; that is preferable to losing the
failure evidence.

### Verification

Unit-test these cases with fake repositories/projector:

```text
valid event -> projector then marker
same event ID already marked -> no projector call
unknown type -> ignored
invalid JSON -> PoisonKafkaRecordError
known type, version 2 -> PoisonKafkaRecordError
Kafka key mismatch -> PoisonKafkaRecordError
Elasticsearch failure -> error escapes and marker is absent
```

### Expected result

Only deterministic input problems advance through the dead-letter path;
dependency failures remain retryable, and ordinary logs do not include the
full Kafka value.

---

## Checkpoint 11: Add publisher and consumer worker entrypoints

### Reason

Workers need explicit ownership and bounded shutdown. They use the same built
artifact as the HTTP process, but each starts only the clients its role needs.
The HTTP server remains available when Kafka is down because it only commits
outbox intent to PostgreSQL.

### Implementation

Create `src/workers/outbox-publisher.ts` with this **complete file**:

```ts
import 'dotenv/config';

import pino from 'pino';

import { parseOutboxPublisherEnvironment } from '../config/kafka-worker-env.js';
import { createKafkaClient } from '../infrastructure/kafka/client.js';
import { OutboxRepository } from '../infrastructure/kafka/outbox.repository.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { OutboxPublisherRunner } from './outbox-publisher-runner.js';

const logger = pino();
const environment = parseOutboxPublisherEnvironment(process.env);
const prisma = createPrismaClient(environment);
const kafka = createKafkaClient(environment, 'outbox-publisher');
const producer = kafka.producer({
  allowAutoTopicCreation: false,
  idempotent: true,
  maxInFlightRequests: 5,
});
const abortController = new AbortController();

let stopping = false;
const requestShutdown = (signal: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Outbox publisher shutdown requested');
  abortController.abort();
};

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

try {
  await producer.connect();
  const repository = new OutboxRepository(prisma, environment.KAFKA_REQUEST_TIMEOUT_MS + 2_000);
  const runner = new OutboxPublisherRunner(repository, producer, logger, {
    batchSize: environment.KAFKA_OUTBOX_BATCH_SIZE,
    idleDelayMs: environment.KAFKA_OUTBOX_POLL_INTERVAL_MS,
    failureDelayMs: 1_000,
    requestTimeoutMs: environment.KAFKA_REQUEST_TIMEOUT_MS,
  });

  logger.info('Outbox publisher started');
  await runner.run(abortController.signal);
} catch (error) {
  logger.error({ err: error }, 'Outbox publisher stopped unexpectedly');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([producer.disconnect(), prisma.$disconnect()]);
  logger.info('Outbox publisher stopped');
}
```

Create `src/workers/search-projection-consumer.ts` with this **complete file**:

```ts
import 'dotenv/config';

import pino from 'pino';

import { parseSearchConsumerEnvironment } from '../config/kafka-worker-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { EventSearchIndex } from '../infrastructure/elasticsearch/event-search-index.js';
import { createKafkaClient } from '../infrastructure/kafka/client.js';
import { publishDeadLetter } from '../infrastructure/kafka/dead-letter.js';
import { ProcessedEventsRepository } from '../infrastructure/kafka/processed-events.repository.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { EventSearchProjector } from '../modules/search/event-search-projector.js';
import { EventSearchSourceRepository } from '../modules/search/event-search-source.repository.js';
import {
  PoisonKafkaRecordError,
  SearchProjectionConsumer,
} from '../modules/search/search-projection-consumer.js';

const logger = pino();
const environment = parseSearchConsumerEnvironment(process.env);
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

let stopping = false;
const requestShutdown = (signal: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Search projection consumer shutdown requested');
  void consumer.stop().catch((error: unknown) => {
    logger.error({ err: error }, 'Could not stop Kafka consumer cleanly');
    process.exitCode = 1;
  });
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
        logger.debug({ topic, partition, offset: message.offset, outcome }, 'Domain event handled');
      } catch (error) {
        if (!(error instanceof PoisonKafkaRecordError)) throw error;

        await publishDeadLetter(
          deadLetterProducer,
          environment.KAFKA_DEAD_LETTER_TOPIC,
          { topic, partition, message },
          error.message,
          environment.KAFKA_REQUEST_TIMEOUT_MS,
        );
        logger.warn(
          { topic, partition, offset: message.offset, reason: error.message },
          'Domain event moved to dead-letter topic',
        );
      }
    },
  });
} catch (error) {
  logger.error({ err: error }, 'Search projection consumer stopped unexpectedly');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([
    consumer.disconnect(),
    deadLetterProducer.disconnect(),
    prisma.$disconnect(),
    closeElasticsearchClient(elasticsearch),
  ]);
  logger.info('Search projection consumer stopped');
}
```

`eachMessage` is deliberate here. The projection is short, independently
idempotent work, and KafkaJS handles heartbeat/offset resolution around each
message. If later processing approaches the session timeout, measure it before
switching to `eachBatch`; batch processing requires explicit heartbeat,
staleness, resolution, and shutdown logic.

Add these scripts to `package.json`:

```json
"kafka:outbox": "tsx src/workers/outbox-publisher.ts",
"kafka:outbox:prod": "node dist/workers/outbox-publisher.js",
"kafka:search-consumer": "tsx src/workers/search-projection-consumer.ts",
"kafka:search-consumer:prod": "node dist/workers/search-projection-consumer.js"
```

### Verification

Run each host worker in a separate terminal after Kafka and Elasticsearch are
available:

```powershell
yarn kafka:outbox
yarn kafka:search-consumer
```

Stop each with Ctrl+C. Neither should accept new work indefinitely after the
signal, and each should disconnect its owned clients.

### Expected result

Publisher and consumer have isolated dependencies, stable identities, bounded
shutdown, non-zero exit on unexpected fatal failure, and no effect on HTTP
availability.

---

## Checkpoint 12: Run the workers from the same application image

### Reason

Separate process roles prevent a busy or crashing consumer from sharing the
HTTP event loop and make restart/lag behavior visible. They do not create
microservices: all roles are compiled from the same repository, migrated
together, and deployed as one Gatherly release.

Kafka and Elasticsearch are not included in HTTP readiness. PostgreSQL is
required to serve authoritative requests; asynchronous projection health is
observed through worker state, outbox age, consumer lag, and search-specific
signals.

### Implementation

Under `app.environment` in `compose.yaml`, remove no existing values. The HTTP
process does not need Kafka values. Add these two services:

```yaml
outbox-publisher:
  build:
    context: .
    dockerfile: Dockerfile
    target: runtime
  command: node dist/workers/outbox-publisher.js
  environment:
    DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
    PRISMA_POOL_MAX: ${PRISMA_POOL_MAX:-5}
    KAFKA_BROKERS: kafka:29092
    KAFKA_CLIENT_ID: ${KAFKA_CLIENT_ID:-gatherly}
    KAFKA_DOMAIN_EVENTS_TOPIC: ${KAFKA_DOMAIN_EVENTS_TOPIC:-gatherly.domain-events.v1}
    KAFKA_REQUEST_TIMEOUT_MS: ${KAFKA_REQUEST_TIMEOUT_MS:-5000}
    KAFKA_OUTBOX_POLL_INTERVAL_MS: ${KAFKA_OUTBOX_POLL_INTERVAL_MS:-500}
    KAFKA_OUTBOX_BATCH_SIZE: ${KAFKA_OUTBOX_BATCH_SIZE:-25}
  depends_on:
    migration:
      condition: service_completed_successfully
    kafka-init:
      condition: service_completed_successfully
  restart: unless-stopped
  init: true
  stop_grace_period: 15s
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL
  read_only: true
  tmpfs:
    - /tmp:size=32m,mode=1777
  pids_limit: 100
  mem_limit: 384m

search-consumer:
  build:
    context: .
    dockerfile: Dockerfile
    target: runtime
  command: node dist/workers/search-projection-consumer.js
  environment:
    DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
    PRISMA_POOL_MAX: ${PRISMA_POOL_MAX:-5}
    KAFKA_BROKERS: kafka:29092
    KAFKA_CLIENT_ID: ${KAFKA_CLIENT_ID:-gatherly}
    KAFKA_DOMAIN_EVENTS_TOPIC: ${KAFKA_DOMAIN_EVENTS_TOPIC:-gatherly.domain-events.v1}
    KAFKA_DEAD_LETTER_TOPIC: ${KAFKA_DEAD_LETTER_TOPIC:-gatherly.domain-events.dlq.v1}
    KAFKA_SEARCH_GROUP_ID: ${KAFKA_SEARCH_GROUP_ID:-gatherly-search-projection-v1}
    KAFKA_REQUEST_TIMEOUT_MS: ${KAFKA_REQUEST_TIMEOUT_MS:-5000}
    ELASTICSEARCH_URL: http://elasticsearch:9200
    ELASTICSEARCH_REQUEST_TIMEOUT_MS: ${ELASTICSEARCH_REQUEST_TIMEOUT_MS:-2000}
    ELASTICSEARCH_INDEX_PREFIX: ${ELASTICSEARCH_INDEX_PREFIX:-gatherly-events}
  depends_on:
    migration:
      condition: service_completed_successfully
    kafka-init:
      condition: service_completed_successfully
    elasticsearch:
      condition: service_healthy
  restart: unless-stopped
  init: true
  stop_grace_period: 15s
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL
  read_only: true
  tmpfs:
    - /tmp:size=32m,mode=1777
  pids_limit: 100
  mem_limit: 384m
```

Compose `depends_on` controls initial ordering only. It does not guarantee that
Kafka or Elasticsearch remains available. KafkaJS retries transient broker
operations; an unrecoverable worker exit is restarted locally by Compose. A
future production orchestrator should apply equivalent restart, readiness, and
rollout policies.

For development source watching, it is acceptable to run the two workers on
the host with their Yarn commands while Compose runs dependencies. Do not add
three competing `tsx watch` processes to one container.

### Verification

```powershell
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose -f compose.yaml -f compose.dev.yaml up --detach --build
docker compose -f compose.yaml -f compose.dev.yaml ps --all
docker compose -f compose.yaml -f compose.dev.yaml logs --follow `
  outbox-publisher search-consumer
```

Create an event, then verify all four durable observations:

```sql
-- 1. canonical event exists
SELECT id, title FROM events ORDER BY created_at DESC LIMIT 1;

-- 2. outbox record was acknowledged and marked
SELECT id, event_key, published_at, publish_attempts, last_error
FROM outbox_events ORDER BY occurred_at DESC LIMIT 1;

-- 3. consumer recorded the envelope ID
SELECT consumer_name, event_id, topic, partition, offset_value, processed_at
FROM processed_kafka_events ORDER BY processed_at DESC LIMIT 1;
```

Then query Elasticsearch by the event ID or call the search endpoint after the
index aliases have been initialized.

### Expected result

One API image supplies three explicit process roles; event creation returns
without waiting for the workers, and asynchronous state converges shortly
afterward.

---

## Checkpoint 13: Prove rollback and the duplicate crash window

### Reason

Mocks cannot prove that PostgreSQL rolled back a domain row, and an ordinary
happy-path broker test cannot prove duplicate tolerance. Use real disposable
PostgreSQL and Kafka containers and inject failures at the exact transaction
boundaries.

The first test makes the outbox insert fail and proves event creation rolls
back. The second lets Kafka accept a message, then makes the `published_at`
update fail. PostgreSQL rolls back the marker, so the next publisher attempt
sends the same event ID again.

### Implementation

Create `tests/helpers/kafka.ts` with this **complete file**:

```ts
import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';
import { Kafka, logLevel, type Admin } from 'kafkajs';

import { DEAD_LETTER_TOPIC, DOMAIN_EVENTS_TOPIC } from '../../src/shared/events/domain-event.js';

export interface KafkaHarness {
  brokers: string[];
  kafka: Kafka;
  stop: () => Promise<void>;
}

export const startKafkaHarness = async (): Promise<KafkaHarness> => {
  const container: StartedKafkaContainer = await new KafkaContainer('confluentinc/cp-kafka:8.1.4')
    .withKraft()
    .start();
  const brokers = [`${container.getHost()}:${String(container.getMappedPort(9093))}`];
  const kafka = new Kafka({
    clientId: 'gatherly-integration-test',
    brokers,
    logLevel: logLevel.NOTHING,
  });
  const admin: Admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      { topic: DOMAIN_EVENTS_TOPIC, numPartitions: 3, replicationFactor: 1 },
      { topic: DEAD_LETTER_TOPIC, numPartitions: 3, replicationFactor: 1 },
    ],
  });
  await admin.disconnect();

  return {
    brokers,
    kafka,
    stop: () => container.stop().then(() => undefined),
  };
};
```

Create `tests/integration/kafka-outbox.integration.test.ts` with this
**complete test**:

```ts
import { randomUUID } from 'node:crypto';

import type { Consumer, Producer } from 'kafkajs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EventsRepository } from '../../src/modules/events/events.repository.js';
import { OutboxRepository } from '../../src/infrastructure/kafka/outbox.repository.js';
import {
  createEventChangedEnvelope,
  DOMAIN_EVENTS_TOPIC,
} from '../../src/shared/events/domain-event.js';
import { aliceId, createCommunityFixture } from '../fixtures/database.js';
import { startKafkaHarness, type KafkaHarness } from '../helpers/kafka.js';
import { startPostgresHarness, type PostgresHarness } from '../helpers/postgres.js';

describe.sequential('Kafka transactional outbox', () => {
  let postgres: PostgresHarness;
  let kafka: KafkaHarness;
  let producer: Producer;
  let consumer: Consumer;

  beforeAll(async () => {
    [postgres, kafka] = await Promise.all([startPostgresHarness(), startKafkaHarness()]);
    producer = kafka.kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,
      maxInFlightRequests: 5,
    });
    consumer = kafka.kafka.consumer({ groupId: `outbox-test-${randomUUID()}` });
    await Promise.all([producer.connect(), consumer.connect()]);
    await consumer.subscribe({ topic: DOMAIN_EVENTS_TOPIC, fromBeginning: true });
  }, 180_000);

  beforeEach(async () => {
    await postgres.reset();
    await postgres.seed();
  });

  afterAll(async () => {
    await Promise.allSettled([producer.disconnect(), consumer.disconnect()]);
    await Promise.all([postgres.stop(), kafka.stop()]);
  });

  it('rolls back the event when its outbox insert fails', async () => {
    const communityId = await createCommunityFixture(postgres.pool);
    await postgres.pool.query(`
      CREATE FUNCTION kafka_test_fail_outbox_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'injected outbox failure';
      END;
      $$;

      CREATE TRIGGER kafka_test_fail_outbox_insert_trigger
      BEFORE INSERT ON outbox_events
      FOR EACH ROW
      EXECUTE FUNCTION kafka_test_fail_outbox_insert();
    `);

    try {
      const repository = new EventsRepository(postgres.prisma);
      await expect(
        repository.create(communityId, aliceId, {
          title: 'Must roll back',
          slug: 'must-roll-back',
          description: '',
          format: 'IN_PERSON',
          visibility: 'PUBLIC',
          startsAt: new Date('2030-08-03T18:00:00.000Z'),
          endsAt: new Date('2030-08-03T20:00:00.000Z'),
          timezone: 'Europe/Moscow',
          capacity: 10,
        }),
      ).rejects.toThrow('injected outbox failure');

      const state = await postgres.pool.query<{ events: number; outbox: number }>(`
        SELECT
          (SELECT count(*)::integer FROM events WHERE slug = 'must-roll-back') AS events,
          (SELECT count(*)::integer FROM outbox_events) AS outbox
      `);
      expect(state.rows[0]).toEqual({ events: 0, outbox: 0 });
    } finally {
      await postgres.pool.query(`
        DROP TRIGGER IF EXISTS kafka_test_fail_outbox_insert_trigger ON outbox_events;
        DROP FUNCTION IF EXISTS kafka_test_fail_outbox_insert();
      `);
    }
  });

  it('publishes the same envelope again after send succeeds but marking fails', async () => {
    const eventId = randomUUID();
    const envelope = createEventChangedEnvelope(eventId);
    await postgres.prisma.outboxEvent.create({
      data: {
        id: envelope.id,
        topic: DOMAIN_EVENTS_TOPIC,
        eventKey: eventId,
        eventType: envelope.type,
        eventVersion: envelope.version,
        payload: envelope,
        occurredAt: new Date(envelope.occurredAt),
      },
    });

    const receivedIds: string[] = [];
    let resolveTwo!: () => void;
    const receivedTwo = new Promise<void>((resolve) => {
      resolveTwo = resolve;
    });
    const runPromise = consumer.run({
      eachMessage: ({ message }) => {
        const parsed = JSON.parse(message.value?.toString('utf8') ?? 'null') as {
          id?: string;
        };
        if (parsed.id === envelope.id) receivedIds.push(parsed.id);
        if (receivedIds.length === 2) resolveTwo();
        return Promise.resolve();
      },
    });

    await postgres.pool.query(`
      CREATE FUNCTION kafka_test_fail_publish_mark()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.published_at IS NOT NULL THEN
          RAISE EXCEPTION 'injected publish marker failure';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER kafka_test_fail_publish_mark_trigger
      BEFORE UPDATE ON outbox_events
      FOR EACH ROW
      EXECUTE FUNCTION kafka_test_fail_publish_mark();
    `);

    const repository = new OutboxRepository(postgres.prisma, 7_000);
    const publish = async (record: Parameters<Producer['send']>[0]): Promise<void> => {
      await producer.send({ ...record, acks: -1, timeout: 5_000 });
    };

    await expect(repository.publishNext(publish)).rejects.toThrow(
      'injected publish marker failure',
    );
    const afterFailure = await postgres.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: envelope.id },
    });
    expect(afterFailure.publishedAt).toBeNull();

    await postgres.pool.query(`
      DROP TRIGGER kafka_test_fail_publish_mark_trigger ON outbox_events;
      DROP FUNCTION kafka_test_fail_publish_mark();
    `);

    await expect(repository.publishNext(publish)).resolves.toBe(true);
    await expect(receivedTwo).resolves.toBeUndefined();
    expect(receivedIds).toEqual([envelope.id, envelope.id]);

    const published = await postgres.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: envelope.id },
    });
    expect(published.publishedAt).not.toBeNull();
    expect(published.publishAttempts).toBe(2);

    await consumer.stop();
    await runPromise;
  }, 30_000);
});
```

The trigger is installed after the outbox row exists. It fires after the
broker acknowledgement, exactly where an optimistic “we send only once” claim
breaks. Cleanup is explicit because truncation does not remove triggers or
functions.

### Verification

```powershell
yarn vitest run tests/integration/kafka-outbox.integration.test.ts
```

### Expected result

The first test leaves no partial event. The second observes the same envelope
ID twice and one eventually published outbox row. Duplicate delivery is now
evidence, not theory.

---

## Checkpoint 14: Prove consumer idempotency with PostgreSQL and Elasticsearch

### Reason

The broker test proves duplication can happen. This test proves the real
consumer converges safely: the same envelope is indexed once logically, the
ledger has one row, and a later change can delete the document.

### Implementation

Create `tests/integration/kafka-search-consumer.integration.test.ts` with this
**complete test**:

```ts
import { randomUUID } from 'node:crypto';

import type { KafkaMessage } from 'kafkajs';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EventSearchIndex } from '../../src/infrastructure/elasticsearch/event-search-index.js';
import { ProcessedEventsRepository } from '../../src/infrastructure/kafka/processed-events.repository.js';
import { EventSearchProjector } from '../../src/modules/search/event-search-projector.js';
import { EventSearchSourceRepository } from '../../src/modules/search/event-search-source.repository.js';
import { SearchProjectionConsumer } from '../../src/modules/search/search-projection-consumer.js';
import { createEventChangedEnvelope } from '../../src/shared/events/domain-event.js';
import { createCommunityFixture, createEventFixture } from '../fixtures/database.js';
import { startElasticsearchHarness, type ElasticsearchHarness } from '../helpers/elasticsearch.js';
import { startPostgresHarness, type PostgresHarness } from '../helpers/postgres.js';

const kafkaMessage = (key: string, value: unknown, offset: string): KafkaMessage => ({
  key: Buffer.from(key),
  value: Buffer.from(JSON.stringify(value)),
  timestamp: String(Date.now()),
  attributes: 0,
  offset,
  headers: {},
});

describe.sequential('Kafka search projection consumer', () => {
  let postgres: PostgresHarness;
  let elasticsearch: ElasticsearchHarness;

  beforeAll(async () => {
    [postgres, elasticsearch] = await Promise.all([
      startPostgresHarness(),
      startElasticsearchHarness(),
    ]);
  }, 180_000);

  beforeEach(async () => {
    await postgres.reset();
    await postgres.seed();
    await elasticsearch.reset();
  });

  afterAll(async () => {
    await Promise.all([postgres.stop(), elasticsearch.stop()]);
  });

  it('skips a duplicate and applies a later ineligibility change', async () => {
    const communityId = await createCommunityFixture(postgres.pool);
    const eventId = await createEventFixture(postgres.pool, communityId);
    const source = new EventSearchSourceRepository(postgres.prisma);
    const index = new EventSearchIndex(
      elasticsearch.client,
      elasticsearch.indexPrefix,
      pino({ enabled: false }),
    );
    await index.rebuild(source);

    const consumerName = `search-test-${randomUUID()}`;
    const handler = new SearchProjectionConsumer(
      consumerName,
      new ProcessedEventsRepository(postgres.prisma),
      new EventSearchProjector(source, index),
    );
    const created = createEventChangedEnvelope(eventId);
    const firstRecord = {
      topic: 'gatherly.domain-events.v1',
      partition: 0,
      offset: '0',
      message: kafkaMessage(eventId, created, '0'),
    };

    await expect(handler.handle(firstRecord)).resolves.toBe('indexed');
    await expect(handler.handle(firstRecord)).resolves.toBe('duplicate');
    await elasticsearch.client.indices.refresh({ index: 'gatherly-events-read' });

    const afterDuplicate = await elasticsearch.client.count({
      index: 'gatherly-events-read',
      query: { ids: { values: [eventId] } },
    });
    expect(afterDuplicate.count).toBe(1);
    expect(
      await postgres.prisma.processedKafkaEvent.count({
        where: { consumerName, eventId: created.id },
      }),
    ).toBe(1);

    await postgres.prisma.event.update({
      where: { id: eventId },
      data: { status: 'CANCELLED', visibility: 'COMMUNITY_ONLY' },
    });
    const hidden = createEventChangedEnvelope(eventId);
    await expect(
      handler.handle({
        topic: 'gatherly.domain-events.v1',
        partition: 0,
        offset: '1',
        message: kafkaMessage(eventId, hidden, '1'),
      }),
    ).resolves.toBe('deleted');
    await elasticsearch.client.indices.refresh({ index: 'gatherly-events-read' });

    const afterDelete = await elasticsearch.client.count({
      index: 'gatherly-events-read',
      query: { ids: { values: [eventId] } },
    });
    expect(afterDelete.count).toBe(0);
  });
});
```

### Verification

```powershell
yarn vitest run tests/integration/kafka-search-consumer.integration.test.ts
```

### Expected result

The duplicate produces no second logical document or marker, while a distinct
later envelope for the same event applies current PostgreSQL eligibility and
removes the projection.

---

## Checkpoint 15: Manually inspect records, offsets, and lag

### Reason

Kafka should not remain an invisible library abstraction. Inspect topic
metadata, actual records, keys, headers, consumer group offsets, and lag.

### Manual exercise

Start the stack and create an event. Inspect domain events from the beginning:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec kafka `
  kafka-console-consumer --bootstrap-server kafka:29092 `
  --topic gatherly.domain-events.v1 --from-beginning `
  --property print.key=true `
  --property print.headers=true `
  --property print.partition=true `
  --property print.offset=true `
  --max-messages 10
```

Inspect the stable consumer group:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec kafka `
  kafka-consumer-groups --bootstrap-server kafka:29092 `
  --describe --group gatherly-search-projection-v1
```

The important columns are:

```text
CURRENT-OFFSET  last committed next-read position
LOG-END-OFFSET  current end of the partition
LAG             records not yet committed by this group
CONSUMER-ID     active member currently owning the partition
```

Stop `search-consumer`, create several events, and observe lag rise. Restart
the consumer and observe lag return to zero while the search documents appear.

Produce one malformed known event deliberately:

```powershell
'00000000-0000-4000-8000-000000000001|{"id":"00000000-0000-4000-8000-000000000099","type":"gatherly.event.changed","version":2}' | `
  docker compose -f compose.yaml -f compose.dev.yaml exec -T kafka `
  kafka-console-producer --bootstrap-server kafka:29092 `
  --topic gatherly.domain-events.v1 `
  --property parse.key=true `
  --property key.separator='|'
```

For `parse.key=true`, the actual input must be one line shaped as
`<event-uuid>|<json>`. Inspect the dead-letter topic afterward. Do not use a
real private payload in this exercise.

### Expected result

You can identify the key, envelope ID/type/version, partition and offset; lag
rises while the consumer is stopped and drains after restart; the poison record
appears in the dead-letter topic without blocking later records.

---

## Operational runbook

### Observe the outbox

The most useful first query is backlog count plus age, not table size alone:

```sql
SELECT
  count(*) AS unpublished,
  min(occurred_at) AS oldest_unpublished_at,
  coalesce(extract(epoch FROM now() - min(occurred_at)), 0) AS oldest_age_seconds,
  max(publish_attempts) AS maximum_attempts
FROM outbox_events
WHERE published_at IS NULL;
```

Inspect repeatedly failing rows without printing whole payloads:

```sql
SELECT
  id,
  event_key,
  event_type,
  event_version,
  occurred_at,
  publish_attempts,
  last_error
FROM outbox_events
WHERE published_at IS NULL
ORDER BY publish_attempts DESC, occurred_at ASC
LIMIT 50;
```

Alert later on both backlog count and oldest age. A count of one may still mean
one event has been stuck for hours; a large count may be harmless during a
short measured burst.

### Observe consumer lag

```powershell
docker compose exec kafka kafka-consumer-groups `
  --bootstrap-server kafka:29092 `
  --describe --group gatherly-search-projection-v1
```

Lag is work retained by Kafka but not yet committed by this group. It is not
the same as outbox backlog:

```text
unpublished outbox high, Kafka lag low -> publisher/broker path is unhealthy
unpublished outbox low, Kafka lag high -> consumer/Elasticsearch path is unhealthy
both low, search drift detected       -> schema/logic bug or lost historical delivery
```

### Inspect dead letters

```powershell
docker compose exec kafka kafka-console-consumer `
  --bootstrap-server kafka:29092 `
  --topic gatherly.domain-events.dlq.v1 `
  --from-beginning `
  --property print.key=true `
  --property print.partition=true `
  --property print.offset=true `
  --max-messages 20
```

For each record:

1. identify the producing code/version and exact validation reason;
2. decide whether the source was malformed, unsupported, or malicious;
3. fix the producer or add an explicitly compatible consumer version;
4. test the repaired bytes in an isolated environment;
5. replay deliberately with the original event ID/key or repair from
   PostgreSQL;
6. record the replayed dead-letter offset so it is not handled twice.

Do not build an automatic “DLQ back to source topic” loop. An unrepaired poison
record would cycle forever, and a repaired record may no longer represent
current business state. For search, rereading PostgreSQL or running the full
reindex is usually safer.

### Retain and clean published outbox history

Keep unpublished rows indefinitely until they are repaired. Delete only old
published rows, in bounded batches:

```sql
WITH expired AS (
  SELECT id
  FROM outbox_events
  WHERE published_at < now() - interval '7 days'
  ORDER BY published_at ASC
  LIMIT 1000
)
DELETE FROM outbox_events AS outbox
USING expired
WHERE outbox.id = expired.id;
```

Run repeatedly from a deliberate maintenance worker/job until zero rows are
deleted. Seven days is a local starting policy, not a universal production
value. It must exceed the time operators need to investigate publication and
broker-loss incidents. Measure table growth and autovacuum behavior before
changing it.

Processed markers must live at least as long as Kafka can redeliver the source
records plus the maximum operational replay window. Bounded cleanup has the
same shape:

```sql
WITH expired AS (
  SELECT consumer_name, event_id
  FROM processed_kafka_events
  WHERE processed_at < now() - interval '7 days'
  ORDER BY processed_at ASC
  LIMIT 1000
)
DELETE FROM processed_kafka_events AS processed
USING expired
WHERE processed.consumer_name = expired.consumer_name
  AND processed.event_id = expired.event_id;
```

Deleting a processed marker makes an old replay execute the effect again. That
is safe only because this projection operation is itself idempotent.

### Rebuild search after Kafka or Elasticsearch data loss

The complete Elasticsearch reindex remains the authoritative repair. Kafka
retention is finite, and published outbox rows may already have been cleaned.
Neither is a forever source of business truth.

Use this sequence:

```powershell
# Stop authoritative writers for the existing maintenance-window rebuild.
docker compose -f compose.yaml -f compose.dev.yaml stop app

# Let already committed outbox work publish, then inspect until backlog is zero.
docker compose -f compose.yaml -f compose.dev.yaml start kafka outbox-publisher
docker compose exec postgres psql -U gatherly -d gatherly -c `
  "SELECT count(*) FROM outbox_events WHERE published_at IS NULL;"

# Stop the projection consumer while aliases are rebuilt.
docker compose -f compose.yaml -f compose.dev.yaml stop search-consumer
yarn search:reindex

# Resume consumer and HTTP traffic.
docker compose -f compose.yaml -f compose.dev.yaml start search-consumer app
```

The consumer rereads current PostgreSQL state, so a retained event delivered
again after the rebuild is harmless. Do not reset consumer offsets merely
because an application version was deployed.

### Change an event schema safely

Never silently change the meaning of version `1`.

- Add optional fields only when old consumers can safely ignore them and new
  consumers supply a default when absent.
- For a breaking shape or meaning, define version `2` and make consumers accept
  both during the transition.
- Deploy readers before writers.
- Observe unknown-version/dead-letter counts.
- Remove version-1 support only after topic retention, outbox backlog, and the
  operational replay window guarantee no version-1 record can return.

Schema Registry and Avro/Protobuf may become valuable when many teams and event
types exist. They are not required to learn explicit compatibility with this
single-producer, single-consumer JSON slice.

---

## Failure drills

### Kafka is unavailable during an HTTP event creation

Expected behavior:

```text
event transaction commits
outbox row remains unpublished
HTTP returns the authoritative event
search may be stale
HTTP liveness/readiness remain based on HTTP/PostgreSQL
```

Stop Kafka, create an event, inspect the outbox, restart Kafka, and confirm the
publisher drains the row. No controller or service should contain broker retry
logic.

### PostgreSQL is unavailable

The HTTP write fails safely because neither event nor outbox can commit. The
publisher cannot claim rows. The search consumer must not mark an event as
processed; it should retry after PostgreSQL returns. Kafka never becomes a
fallback database.

### Elasticsearch is unavailable

The consumer handler throws before the processed marker. Its partition stops
advancing/retries, lag increases, and PostgreSQL-backed APIs continue. When
Elasticsearch returns, the same record is handled and then marked.

### Publisher dies after Kafka acknowledgement

The injected-trigger integration test proves this window. `published_at`
remains null, the same envelope ID is sent again, and the consumer skips or
reapplies it safely.

### Consumer dies after Elasticsearch but before the marker

On restart Kafka redelivers. The same event ID overwrites the same document or
repeats an already-successful delete, then the marker is inserted. Document
count does not grow.

### Consumer dies after the marker but before offset commit

Kafka redelivers. `hasProcessed` returns true, the external effect is skipped,
the handler returns, and KafkaJS commits the offset.

### One record is malformed

The record is sent to the dead-letter topic. If that send succeeds, the source
handler returns and later records continue. If dead-letter publication fails,
the source handler throws so failure evidence is not lost.

### A stored outbox payload is invalid

This indicates an application bug or unauthorized database mutation, not a
normal untrusted Kafka input. The publisher records the validation error and
leaves the row unpublished. Because the oldest failing row is selected again,
it deliberately demands operator attention rather than silently discarding
committed publish intent. Inspect metadata without logging the whole payload,
fix the producer/schema bug, and repair or replace the row in an audited
transaction. Never delete it merely to make the backlog counter green.

### One event receives rapid changes

Every outbox record uses the event ID key. The publisher's predecessor query
keeps same-key outbox rows in occurrence order; Kafka keeps one key in one
partition; the consumer processes a partition in order. Because each record
rereads current state, delayed duplicates still converge on the current
PostgreSQL projection.

### A second publisher replica starts

`FOR UPDATE SKIP LOCKED` distributes eligible rows, while the predecessor
condition prevents two unpublished rows for the same key from being published
out of order. Measure database lock duration and throughput before scaling;
more publisher instances are not automatically faster.

### A second search consumer starts

With the same stable group ID, Kafka rebalances three partitions between the
members. Each partition belongs to one group member at a time. With a different
group ID, the second consumer receives the full retained stream as an
independent logical subscriber.

### The Kafka data volume is lost

Unconsumed Kafka records and group offsets are lost. PostgreSQL business rows
remain. Published outbox rows may no longer be enough for replay after cleanup,
so repair the search projection with the full PostgreSQL reindex. This proves
Kafka is not permanent business truth.

### Shutdown arrives during publication

The publisher finishes its current bounded `publishNext` transaction, then
exits its loop and disconnects. If it is killed earlier, either the transaction
committed or the outbox row remains retryable. The consumer stops fetching,
finishes KafkaJS's in-flight handler, disconnects, and resumes from committed
offsets later.

---

## Common mistakes

```text
database commit then direct producer.send        -> dual-write loss window
producer.send then database commit                -> phantom-message window
Kafka producer idempotence                        != PostgreSQL/Kafka atomicity
Kafka exactly-once features                       != external side-effect atomicity
offset committed before effect                    -> lost effect on crash
effect performed before duplicate check           -> repeated non-idempotent effect
processed marker written before effect            -> lost effect on failure
random group ID per replica                       -> every replica repeats every effect
random/no key                                     -> no per-event ordering guarantee
one global partition                              -> unnecessary throughput bottleneck
auto-created topics                               -> accidental names/default policies
full database row in message                      -> coupling, staleness, privacy cost
message payload used for authorization            -> stale permission decision
retry every malformed record forever              -> poisoned partition
swallow every consumer error                      -> lost transient work
log whole message bodies                          -> retained private data in logs
delete unpublished outbox rows                    -> permanent delivery loss
Kafka/Elasticsearch in general HTTP readiness     -> projection outage takes API down
new random group for routine deployment           -> unintended full replay
Kafka log as event-sourced Gatherly state          -> architecture changed without need
```

---

## Suggested commit sequence

Keep checkpoints reviewable:

```text
1. docs: define Kafka ownership and delivery contract
2. infra: add local KRaft broker and explicit topics
3. db: add transactional outbox and processed-event ledger
4. events: write event changed intent atomically
5. kafka: add validated client configuration and outbox relay
6. search: replace best-effort scheduling with idempotent consumer
7. workers: add publisher and search-consumer process roles
8. tests: prove rollback, duplicate publication, and idempotent projection
9. docs: add Kafka operations, failure drills, and README commands
```

Do not combine the migration, broker configuration, producer, consumer, and
all tests into one unreviewable commit.

---

## Final examination

The Kafka increment is complete when the implementation and evidence let you
answer all of these without guessing:

1. What exact failure in the best-effort search projector justified Kafka?
2. Why does writing an outbox row after the event transaction still have a
   dual-write bug?
3. Which PostgreSQL transaction contains the event and outbox inserts?
4. Why can the publisher send one envelope more than once?
5. What does KafkaJS producer idempotence protect, and what does it not protect?
6. Why are acknowledgements from all in-sync replicas still weak in the local
   replication-factor-one broker?
7. Why is `eventId` the message key?
8. Where does Kafka preserve order, and where does it not?
9. How does the outbox query prevent same-event reordering across publishers?
10. Why is the event payload only an ID?
11. Why does the consumer reread PostgreSQL?
12. Why is an Elasticsearch hit never authorization proof?
13. What happens if Elasticsearch succeeds and the processed marker fails?
14. What happens if the marker succeeds and the Kafka offset commit fails?
15. Why must a PostgreSQL-only consumer put its effect and marker in one
    transaction?
16. Which errors go to the dead-letter topic, and which remain retryable?
17. Why does dead-letter publication failure prevent source offset progress?
18. What is the difference between outbox backlog and consumer lag?
19. Why are Kafka and Elasticsearch excluded from general HTTP readiness?
20. How is search repaired after the Kafka volume is lost?
21. When is it safe to delete published outbox rows and processed markers?
22. How do readers and writers roll out a breaking envelope version?
23. Why are the HTTP, publisher, and consumer roles still one modular monolith?
24. Which metrics and alerts should the later observability phase add?

Metrics to carry into the next increment include:

```text
outbox publish attempts/successes/failures
unpublished outbox count and oldest age
publish latency from occurred_at to published_at
consumer handled/duplicate/ignored/dead-letter/failure counts
consumer processing latency
consumer group lag by topic and partition
last successful publish and consume timestamps
Elasticsearch projection success/failure and reconciliation drift
worker restarts and graceful-shutdown duration
```

---

## Completion commands

```powershell
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

Run the focused infrastructure evidence as well:

```powershell
yarn vitest run tests/integration/kafka-outbox.integration.test.ts
yarn vitest run tests/integration/kafka-search-consumer.integration.test.ts
docker compose -f compose.yaml -f compose.dev.yaml up --detach --build
docker compose -f compose.yaml -f compose.dev.yaml ps --all
docker compose exec kafka kafka-consumer-groups `
  --bootstrap-server kafka:29092 `
  --describe --group gatherly-search-projection-v1
```

The deliverable is a durable asynchronous projection path with measured
at-least-once behavior. It is not microservices, event sourcing, or permission
to move Gatherly's authoritative state out of PostgreSQL.

## Official references

- [Apache Kafka introduction and concepts](https://kafka.apache.org/intro)
- [Apache Kafka design: delivery semantics, replication, and ordering](https://kafka.apache.org/documentation/#design)
- [Apache Kafka consumer groups](https://kafka.apache.org/documentation/#intro_consumers)
- [Apache Kafka operations](https://kafka.apache.org/documentation/#operations)
- [Apache Kafka Docker quickstart](https://kafka.apache.org/quickstart)
- [KafkaJS producing messages](https://kafka.js.org/docs/producing)
- [KafkaJS consuming messages and offset behavior](https://kafka.js.org/docs/consuming)
- [KafkaJS retries](https://kafka.js.org/docs/retry-detailed)
- [KafkaJS instrumentation events](https://kafka.js.org/docs/instrumentation-events)
- [Testcontainers for Node.js Kafka module](https://node.testcontainers.org/modules/kafka/)
- [Confluent Docker image configuration reference](https://docs.confluent.io/platform/current/installation/docker/config-reference.html)
- [PostgreSQL `SELECT` locking and `SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [PostgreSQL partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html)
- [Prisma interactive transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions)
