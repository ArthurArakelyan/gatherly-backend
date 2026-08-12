# Phase 6 Handbook: Elasticsearch Event Discovery

This is the fourth Phase 6 implementation guide. It starts from the repository
after `PHASE_6_WEBSOCKETS_HANDBOOK.md` and adds Elasticsearch for one concrete
Gatherly use: public event discovery with typo-tolerant text search,
search-as-you-type suggestions, exact filters, facets, and stable cursor
pagination.

The result remains one TypeScript/Node.js modular monolith and one deployment.
PostgreSQL owns every user, community, event, membership, reservation, and
visibility decision. Elasticsearch contains only a denormalized, rebuildable
projection of public published events. Losing the entire search cluster makes
discovery temporarily unavailable; it does not lose or change business data.

This handbook deliberately stops before community/member search, private
content, chat search, recommendations, vector search, semantic search, Kafka,
Logstash, Beats, OpenTelemetry, Kibana dashboards, multi-node cluster design,
or production deployment.

## How to use this handbook

Work through one checkpoint at a time. Each checkpoint has:

1. **Reason:** the engineering lesson.
2. **Implementation:** exact files and copy-pasteable code.
3. **Verification:** a command or manual observation.
4. **Expected result:** the completion condition.

Code blocks labelled **complete file** replace the named file. Smaller blocks
state exactly where they belong. A complete-file block contains no `...`
placeholder. Preserve the completed WebSocket increment in source control
before starting.

The code targets the versions already locked by this repository:

```text
Elasticsearch server: 9.4.3
@elastic/elasticsearch: 9.4.x
@testcontainers/elasticsearch: 12.0.x
Node.js: 24.x in Docker
TypeScript: strict + NodeNext
```

Use Yarn Classic. Do not run `npm install`, create `package-lock.json`, or copy
browser code which connects directly to Elasticsearch.

## Phase outcome

At the end of the implementation checkpoints, Gatherly has:

- a local single-node Elasticsearch service with bounded heap;
- a strict, explicit mapping for versioned event-discovery indices;
- separate stable read and write aliases;
- a complete reindex command which reads canonical PostgreSQL rows in batches,
  bulk-indexes a new physical index, verifies its count, and atomically swaps
  aliases;
- `GET /api/search/events` for text search, exact filters, facets, and
  `search_after` pagination held stable by a point in time;
- `GET /api/search/events/suggestions` for prefix suggestions;
- runtime validation of every document read back from Elasticsearch;
- best-effort post-commit projection of newly created events;
- explicit stale-search and outage semantics;
- real Elasticsearch Testcontainer coverage; and
- a documented maintenance-window reindex and rollback procedure.

The architecture is:

```text
event creation
  -> authorization and INSERT in PostgreSQL
  -> COMMIT
  -> return authoritative event
  -> best-effort projection task
       -> reload canonical event + community from PostgreSQL
       -> index/delete through gatherly-events-write alias

public discovery request
  -> validate query
  -> SearchService
  -> Elasticsearch read alias
       -> full-text relevance
       -> exact filters
       -> facets
       -> PIT + search_after
  -> validate _source
  -> safe API DTO

full rebuild, with application writes stopped
  -> create gatherly-events-v<timestamp>
  -> stream eligible PostgreSQL rows in bounded batches
  -> bulk index using PostgreSQL UUID as Elasticsearch _id
  -> refresh and compare PostgreSQL/Elasticsearch counts
  -> atomically move read and write aliases
  -> retain the old physical index for deliberate rollback
```

Three rules are fundamental:

1. An Elasticsearch hit is a discovery result, not authorization proof. A
   later event-detail or reservation request rechecks PostgreSQL.
2. PostgreSQL commit success never depends on Elasticsearch success.
3. The complete index can be deleted and reconstructed from PostgreSQL.

## Scope and deliberate omissions

Implement now:

- public `PUBLISHED` events whose community is `ACTIVE`;
- title, description, and community-name relevance;
- typo tolerance for ordinary search;
- title prefix suggestions using `search_as_you_type`;
- exact community, format, city, country, and start-time filters;
- format/city/country facets;
- bounded result sizes and opaque cursors;
- one shard and no replica for the local single-node learning environment;
- best-effort incremental create projection plus a complete repair command.

Do not implement now:

- private, unlisted, invite-only, draft, cancelled, or archived content;
- membership-aware filtering inside Elasticsearch;
- copying reservation counts, capacity availability, or waitlist state into the
  search index;
- event geo-distance search before canonical event-location coordinates exist
  in PostgreSQL;
- indexing chat messages or private user data;
- client-to-Elasticsearch network access;
- dynamic mappings, scripts supplied by callers, query-string syntax, or raw
  Query DSL from the HTTP request;
- a Kafka indexing consumer before the Kafka/outbox increment;
- a multi-node production topology or Kubernetes.

The current schema has community city/country but no canonical event latitude
and longitude. Adding fake coordinates merely to demonstrate `geo_point` would
teach the wrong ownership model. Add geo search later, after PostgreSQL owns a
validated event location.

---

## Checkpoint 1: Record the boundary and prove a search need

### Reason

Elasticsearch is not a default replacement for `WHERE`, `ORDER BY`, or a
PostgreSQL index. Gatherly already lists public events efficiently by status,
community, and start time. Add a second datastore only for requirements which
the measured PostgreSQL query does not satisfy cleanly: typo tolerance,
search-as-you-type, relevance across several fields, and facets.

Before changing code, write down the product experiments:

```text
query: "potery"
expected: an event titled "Beginner pottery"

prefix: "woodw"
expected: suggestions for "Woodworking basics"

query: "beginner workshop"
filters: format=IN_PERSON, city=Moscow, startsAfter=<now>
expected: relevant upcoming events plus filter counts
```

Seed enough varied events to make these observations meaningful. Compare the
existing PostgreSQL list route and, as a learning experiment, a parameterized
PostgreSQL `to_tsvector`/`websearch_to_tsquery` query. Record what PostgreSQL
does well and which desired behavior still justifies Elasticsearch. Do not
pretend that a tiny development dataset proves a performance problem.

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
PostgreSQL version:
@elastic/elasticsearch version from yarn.lock:
desired queries:
PostgreSQL experiment:
why Elasticsearch is justified:
baseline failures:
```

### Expected result

The WebSocket increment passes its quality gate and the Elasticsearch lesson
has a written product reason beyond "the roadmap mentions it."

---

## Checkpoint 2: Define ownership and consistency before code

### Reason

Search is a denormalized read model. Its useful shape duplicates event and
community fields, so it can drift. Define the drift contract before writing an
indexer.

| Search field       | Canonical PostgreSQL owner       | Indexed? | Reason                         |
| ------------------ | -------------------------------- | -------- | ------------------------------ |
| event ID           | `events.id`                      | yes      | stable result identity         |
| title/description  | `events`                         | yes      | relevance and display          |
| format/times       | `events`                         | yes      | filters, sorting, display      |
| community identity | `communities`                    | yes      | filter and display             |
| community location | `communities.city/country`       | yes      | coarse discovery facets        |
| visibility/status  | `events` + `communities`         | policy   | controls projection membership |
| remaining capacity | reservations + event transaction | no       | volatile authoritative state   |
| membership access  | `community_memberships`          | no       | authorization must be current  |
| chat content       | `chat_messages`                  | no       | private and outside this slice |

Projection eligibility is exactly:

```text
event.visibility = PUBLIC
AND event.status = PUBLISHED
AND community.status = ACTIVE
```

The index does not store the three policy fields and then ask every query to
filter them correctly. Ineligible rows are absent. If a later event/community
mutation makes a row ineligible, the projection operation deletes its
document.

The current application only creates events; it does not yet expose event
update, publish, cancel, or community archive endpoints. The projector added
here handles create and already supports deletion when a future mutation calls
`schedule(eventId)`. Every future mutation which affects an indexed field or
eligibility must schedule the affected event IDs after PostgreSQL commits.

Incremental projection is deliberately best effort in this increment. A
process crash can leave search stale. The full reindex command is the repair
mechanism. The later Kafka increment may replace this with a PostgreSQL
transactional outbox and idempotent consumer, but Kafka is not pulled forward
here.

### Expected result

You can answer which system owns every returned value, what stale search means,
and how the index is repaired without claiming Elasticsearch is authoritative.

---

## Checkpoint 3: Add Elasticsearch to the local Compose stack

### Reason

Run the same major/minor server as the official JavaScript client. The local
service is single-node, bound to loopback, and security-disabled only for this
isolated learning Compose stack. It is not a deployment template.

One shard is enough for the current dataset. Zero replicas keeps a one-node
cluster green. A 512 MiB fixed JVM heap is intentionally modest and the
container memory limit leaves headroom outside the heap.

Unlike Redis, Elasticsearch gets a named volume so ordinary restarts do not
force an expensive rebuild. That volume is still disposable: deleting it and
running the reindex command must restore all search documents.

### Implementation

Add this service after `redis` in `compose.yaml`:

```yaml
elasticsearch:
  image: docker.elastic.co/elasticsearch/elasticsearch:9.4.3
  environment:
    discovery.type: single-node
    xpack.security.enabled: 'false'
    xpack.security.enrollment.enabled: 'false'
    ES_JAVA_OPTS: -Xms512m -Xmx512m
  ports:
    - '127.0.0.1:${ELASTICSEARCH_PORT:-9200}:9200'
  volumes:
    - elasticsearch_data:/usr/share/elasticsearch/data
  healthcheck:
    test:
      [
        'CMD-SHELL',
        'curl --fail --silent http://127.0.0.1:9200/_cluster/health?wait_for_status=yellow&timeout=1s > /dev/null',
      ]
    interval: 10s
    timeout: 3s
    retries: 20
    start_period: 30s
  security_opt:
    - no-new-privileges:true
  pids_limit: 512
  mem_limit: 1g
```

Add the service URL to `app.environment`:

```yaml
ELASTICSEARCH_URL: http://elasticsearch:9200
ELASTICSEARCH_REQUEST_TIMEOUT_MS: ${ELASTICSEARCH_REQUEST_TIMEOUT_MS:-2000}
ELASTICSEARCH_INDEX_PREFIX: ${ELASTICSEARCH_INDEX_PREFIX:-gatherly-events}
```

Add the volume beside `postgres_data`:

```yaml
volumes:
  postgres_data:
  elasticsearch_data:
```

Add host-development values to `.env.example`:

```dotenv
# Elasticsearch event discovery
ELASTICSEARCH_PORT=9200
ELASTICSEARCH_URL=http://127.0.0.1:9200
ELASTICSEARCH_REQUEST_TIMEOUT_MS=2000
ELASTICSEARCH_INDEX_PREFIX=gatherly-events
# Leave empty only for the loopback-only local Compose service above.
ELASTICSEARCH_API_KEY=
```

Do not add Elasticsearch to the migration service. Do not make application
startup or `/health/ready` wait for Elasticsearch. PostgreSQL-backed APIs must
remain usable during a search outage.

### Verification

```powershell
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose -f compose.yaml -f compose.dev.yaml up --detach elasticsearch
docker compose -f compose.yaml -f compose.dev.yaml ps elasticsearch
Invoke-RestMethod -Uri http://127.0.0.1:9200
Invoke-RestMethod -Uri http://127.0.0.1:9200/_cluster/health
```

Inspect memory and the volume:

```powershell
docker stats --no-stream
docker volume ls
```

If the container exits with a `vm.max_map_count` bootstrap error, inspect its
logs before changing the host:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml logs elasticsearch
wsl -d docker-desktop -u root sysctl vm.max_map_count
```

Current Elastic guidance recommends at least `1048576`. On a Docker Desktop
WSL 2 backend, an administrator can set it inside `docker-desktop`:

```powershell
wsl -d docker-desktop -u root sysctl -w vm.max_map_count=1048576
```

This is a host setting, not a repository command; apply it only when the
bootstrap log proves it is needed. Depending on Windows/WSL version, making it
persistent requires the documented WSL configuration rather than rerunning the
command after every Docker restart.

### Expected result

The node reports Elasticsearch `9.4.3`, cluster status is green, the port is
bound only to `127.0.0.1`, and `elasticsearch_data` is visibly a rebuildable
local search volume.

---

## Checkpoint 4: Validate configuration and own one client lifecycle

### Reason

The official client manages connection pooling and retries. Create one client
in the composition root, not one per request. Keep retries and timeouts bounded
so an optional discovery dependency cannot stall HTTP requests indefinitely.

The API key is optional for the loopback-only Compose service. A real
deployment must use HTTPS and a narrowly privileged credential; do not reuse an
Elasticsearch superuser credential in the application.

### Implementation

The dependencies are already present in `package.json` and `yarn.lock`. Verify
these entries rather than installing a second copy:

```json
"dependencies": {
  "@elastic/elasticsearch": "^9.4.3"
},
"devDependencies": {
  "@testcontainers/elasticsearch": "^12.0.4"
}
```

Create `src/config/elasticsearch-environment.ts` so the HTTP application and
one-off reindex worker share exactly the same Elasticsearch validation:

```ts
import { z } from 'zod';

export const elasticsearchEnvironmentShape = {
  ELASTICSEARCH_URL: z
    .url()
    .refine(
      (value) => ['http:', 'https:'].includes(new URL(value).protocol),
      'ELASTICSEARCH_URL must use http:// or https://',
    ),
  ELASTICSEARCH_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  ELASTICSEARCH_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(2_000),
  ELASTICSEARCH_INDEX_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .default('gatherly-events'),
};
```

Import `elasticsearchEnvironmentShape` in `src/config/env.ts` and spread it
inside `environmentSchema`:

```ts
...elasticsearchEnvironmentShape,
```

Create `src/infrastructure/elasticsearch/client.ts` with this **complete file**:

```ts
import { Client } from '@elastic/elasticsearch';
import type { Logger } from 'pino';

interface ElasticsearchConfiguration {
  ELASTICSEARCH_URL: string;
  ELASTICSEARCH_API_KEY: string | undefined;
  ELASTICSEARCH_REQUEST_TIMEOUT_MS: number;
}

export const createElasticsearchClient = (
  configuration: ElasticsearchConfiguration,
  logger: Logger,
): Client => {
  const client = new Client({
    node: configuration.ELASTICSEARCH_URL,
    requestTimeout: configuration.ELASTICSEARCH_REQUEST_TIMEOUT_MS,
    maxRetries: 2,
    ...(configuration.ELASTICSEARCH_API_KEY === undefined
      ? {}
      : { auth: { apiKey: configuration.ELASTICSEARCH_API_KEY } }),
  });

  client.diagnostic.on('request', (_error, event) => {
    if (event === null) return;
    logger.debug(
      { method: event.meta.request.params.method, path: event.meta.request.params.path },
      'Elasticsearch request',
    );
  });

  client.diagnostic.on('response', (error, event) => {
    if (error === null || event === null) return;
    logger.warn(
      {
        err: error,
        method: event.meta.request.params.method,
        path: event.meta.request.params.path,
      },
      'Elasticsearch request failed',
    );
  });

  return client;
};

export const closeElasticsearchClient = async (client: Client): Promise<void> => {
  await client.close();
};
```

Do not log request bodies. Search terms can reveal interests or sensitive
queries even when the indexed documents are public. The diagnostic log above
records only method/path and should remain debug-level.

### Verification

```powershell
yarn typecheck
yarn lint
```

### Expected result

Configuration rejects malformed URLs and index prefixes, one client can be
created without opening a request-time client, and shutdown has an explicit
close operation.

---

## Checkpoint 5: Define the projection document and strict index mapping

### Reason

An Elasticsearch mapping is a schema and query design, not a dump of a Prisma
record. Index only fields required by discovery. Use `dynamic: strict` so a
typo or accidental private field fails indexing instead of silently changing
the mapping.

`title` uses `search_as_you_type`, which creates shingle and prefix subfields
suited to `bool_prefix` suggestions. Exact filters use `keyword`; dates use
`date`. The PostgreSQL UUID is copied into both Elasticsearch `_id` and a
keyword `id` field because `_id` is not the right general-purpose sort field.

### Implementation

Create `src/modules/search/search.types.ts` with this **complete file**:

```ts
export type SearchableEventFormat = 'IN_PERSON' | 'ONLINE' | 'HYBRID';

export interface EventSearchDocument {
  id: string;
  communityId: string;
  communityName: string;
  communitySlug: string;
  communityCity: string | null;
  communityCountry: string | null;
  title: string;
  description: string;
  format: SearchableEventFormat;
  startsAt: string;
  endsAt: string;
  timezone: string;
  updatedAt: string;
}

export interface EventSearchQuery {
  q: string | null;
  communityId: string | null;
  format: SearchableEventFormat | null;
  city: string | null;
  country: string | null;
  startsAfter: Date | null;
  startsBefore: Date | null;
  after: string | null;
  limit: number;
}

export interface EventSearchHit {
  event: EventSearchDocument;
  score: number | null;
}

export interface SearchFacetBucket {
  value: string;
  count: number;
}

export interface EventSearchFacets {
  formats: SearchFacetBucket[];
  cities: SearchFacetBucket[];
  countries: SearchFacetBucket[];
}

export interface EventSearchPage {
  items: EventSearchHit[];
  total: number;
  nextCursor: string | null;
  facets: EventSearchFacets;
}

export interface EventSuggestion {
  id: string;
  title: string;
  communityName: string;
  startsAt: string;
}
```

Create `src/modules/search/event-search-document.schema.ts` with this
**complete file**:

```ts
import { z } from 'zod';

export const eventSearchDocumentSchema = z
  .object({
    id: z.uuid(),
    communityId: z.uuid(),
    communityName: z.string().min(1).max(200),
    communitySlug: z.string().min(1).max(200),
    communityCity: z.string().min(1).max(200).nullable(),
    communityCountry: z.string().min(1).max(200).nullable(),
    title: z.string().min(1).max(150),
    description: z.string().max(10_000),
    format: z.enum(['IN_PERSON', 'ONLINE', 'HYBRID']),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    timezone: z.string().min(1).max(100),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
```

Create `src/infrastructure/elasticsearch/event-index-definition.ts` with this
**complete file**:

```ts
export const EVENT_SEARCH_READ_ALIAS = 'gatherly-events-read';
export const EVENT_SEARCH_WRITE_ALIAS = 'gatherly-events-write';

export const createEventIndexName = (prefix: string, now = new Date()): string =>
  `${prefix}-v${now.toISOString().replace(/[^0-9]/g, '')}`;

export const eventIndexDefinition = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    refresh_interval: '1s',
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      id: { type: 'keyword' },
      communityId: { type: 'keyword' },
      communityName: { type: 'text' },
      communitySlug: { type: 'keyword' },
      communityCity: { type: 'keyword' },
      communityCountry: { type: 'keyword' },
      title: { type: 'search_as_you_type', max_shingle_size: 3 },
      description: { type: 'text' },
      format: { type: 'keyword' },
      startsAt: { type: 'date' },
      endsAt: { type: 'date' },
      timezone: { type: 'keyword' },
      updatedAt: { type: 'date' },
    },
  },
} as const;
```

The aliases are application-level stable names. The physical index name
changes when mapping or analysis changes. Do not put a version number in the
HTTP endpoint or make callers aware of physical index names.

### Verification

```powershell
yarn typecheck
yarn lint
```

Manually explain why each property is `keyword`, `text`,
`search_as_you_type`, or `date`, and why capacity is absent.

### Expected result

The document contains only public discovery data, unknown fields are rejected,
and index evolution can happen behind aliases.

---

## Checkpoint 6: Read canonical projection rows from PostgreSQL

### Reason

Both incremental indexing and full rebuild must use one canonical projection
function. Do not build one document from an HTTP request and another from a
reindex script. Reload after commit so Elasticsearch receives database-owned
values and community eligibility.

The full rebuild streams bounded Prisma pages. It never loads the entire table
into memory.

### Implementation

Create `src/modules/search/event-search-source.repository.ts` with this
**complete file**:

```ts
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

import type { EventSearchDocument, SearchableEventFormat } from './search.types.js';

const projectionSelection = {
  id: true,
  title: true,
  description: true,
  format: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  updatedAt: true,
  community: {
    select: {
      id: true,
      name: true,
      slug: true,
      city: true,
      country: true,
    },
  },
} satisfies Prisma.EventSelect;

type ProjectionRecord = Prisma.EventGetPayload<{ select: typeof projectionSelection }>;

const eligibleWhere = {
  visibility: 'PUBLIC',
  status: 'PUBLISHED',
  community: { status: 'ACTIVE' },
} satisfies Prisma.EventWhereInput;

const mapProjection = (record: ProjectionRecord): EventSearchDocument => ({
  id: record.id,
  communityId: record.community.id,
  communityName: record.community.name,
  communitySlug: record.community.slug,
  communityCity: record.community.city,
  communityCountry: record.community.country,
  title: record.title,
  description: record.description,
  format: record.format as SearchableEventFormat,
  startsAt: record.startsAt.toISOString(),
  endsAt: record.endsAt.toISOString(),
  timezone: record.timezone,
  updatedAt: record.updatedAt.toISOString(),
});

export class EventSearchSourceRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findEligibleById(eventId: string): Promise<EventSearchDocument | null> {
    const record = await this.prisma.event.findFirst({
      where: { id: eventId, ...eligibleWhere },
      select: projectionSelection,
    });
    return record === null ? null : mapProjection(record);
  }

  public countEligible(): Promise<number> {
    return this.prisma.event.count({ where: eligibleWhere });
  }

  public async *iterateEligible(batchSize = 500): AsyncGenerator<EventSearchDocument> {
    let cursor: string | undefined;

    while (true) {
      const records = await this.prisma.event.findMany({
        where: eligibleWhere,
        select: projectionSelection,
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });

      if (records.length === 0) return;
      for (const record of records) yield mapProjection(record);

      cursor = records.at(-1)?.id;
      if (records.length < batchSize) return;
    }
  }
}
```

`format` is currently stored as a Prisma `String`, so the cast reflects the
existing schema. Boundary validation still happens when reading search
documents. A later Prisma enum migration can remove the cast.

### Verification

```powershell
yarn typecheck
yarn lint
```

Inspect the generated SQL in development if useful. Confirm one batch selects
only explicit fields and that the cursor advances by unique `events.id`.

### Expected result

One repository produces identical document shapes for single-event sync and
bounded full rebuild, and ineligible events return `null`.

---

## Checkpoint 7: Build versioned indices and an atomic reindex command

### Reason

Mappings cannot always be changed in place. A rebuild should create a new
physical index, populate and verify it without affecting current reads, then
atomically switch aliases. If population fails, the old aliases remain
untouched.

The first implementation uses a maintenance window: stop application writers
before the command. Without that boundary, an event committed while the new
index is being populated can land only in the old write alias and disappear
from search after the swap. A future durable outbox consumer can support online
catch-up; do not claim zero-downtime reindex before that exists.

The old physical index is retained for rollback. Deletion is a separate,
deliberate operation after inspection.

### Implementation

Create `src/infrastructure/elasticsearch/event-search-index.ts` with this
**complete file**:

```ts
import { errors, type Client, type estypes } from '@elastic/elasticsearch';
import type { Logger } from 'pino';

import type { EventSearchSourceRepository } from '../../modules/search/event-search-source.repository.js';
import type { EventSearchDocument } from '../../modules/search/search.types.js';
import {
  createEventIndexName,
  EVENT_SEARCH_READ_ALIAS,
  EVENT_SEARCH_WRITE_ALIAS,
  eventIndexDefinition,
} from './event-index-definition.js';

interface ReindexResult {
  index: string;
  previousIndices: string[];
  indexedDocuments: number;
}

const aliasIndices = async (client: Client, alias: string): Promise<string[]> => {
  try {
    const response = await client.indices.getAlias({ name: alias });
    return Object.keys(response);
  } catch (error) {
    if (error instanceof errors.ResponseError && error.statusCode === 404) return [];
    throw error;
  }
};

export class EventSearchIndex {
  public constructor(
    private readonly client: Client,
    private readonly indexPrefix: string,
    private readonly logger: Logger,
  ) {}

  public async index(document: EventSearchDocument): Promise<void> {
    await this.client.index({
      index: EVENT_SEARCH_WRITE_ALIAS,
      id: document.id,
      document,
    });
  }

  public async delete(eventId: string): Promise<void> {
    try {
      await this.client.delete({ index: EVENT_SEARCH_WRITE_ALIAS, id: eventId });
    } catch (error) {
      if (error instanceof errors.ResponseError && error.statusCode === 404) return;
      throw error;
    }
  }

  public async rebuild(source: EventSearchSourceRepository): Promise<ReindexResult> {
    const index = createEventIndexName(this.indexPrefix);
    const expectedCount = await source.countEligible();

    await this.client.indices.create({
      index,
      settings: eventIndexDefinition.settings,
      mappings: eventIndexDefinition.mappings,
    });

    this.logger.info({ index, expectedCount }, 'Created Elasticsearch rebuild target');

    const dropped: string[] = [];
    const result = await this.client.helpers.bulk<EventSearchDocument>({
      datasource: source.iterateEligible(),
      concurrency: 2,
      flushBytes: 1_000_000,
      retries: 3,
      onDocument: (document) => ({ index: { _index: index, _id: document.id } }),
      onDrop: ({ document, error }) => {
        dropped.push(document.id);
        this.logger.error({ eventId: document.id, error }, 'Dropped search projection');
      },
    });

    if (result.failed > 0 || dropped.length > 0) {
      throw new Error(`Search rebuild dropped ${String(result.failed)} documents`);
    }

    await this.client.indices.refresh({ index });
    const actualCount = (await this.client.count({ index })).count;

    if (actualCount !== expectedCount) {
      throw new Error(
        `Search rebuild count mismatch: PostgreSQL=${String(expectedCount)}, Elasticsearch=${String(actualCount)}`,
      );
    }

    const [oldReadIndices, oldWriteIndices] = await Promise.all([
      aliasIndices(this.client, EVENT_SEARCH_READ_ALIAS),
      aliasIndices(this.client, EVENT_SEARCH_WRITE_ALIAS),
    ]);
    const previousIndices = [...new Set([...oldReadIndices, ...oldWriteIndices])];

    const actions: estypes.IndicesUpdateAliasesAction[] = [
      ...oldReadIndices.map((oldIndex) => ({
        remove: { index: oldIndex, alias: EVENT_SEARCH_READ_ALIAS },
      })),
      ...oldWriteIndices.map((oldIndex) => ({
        remove: { index: oldIndex, alias: EVENT_SEARCH_WRITE_ALIAS },
      })),
      { add: { index, alias: EVENT_SEARCH_READ_ALIAS } },
      { add: { index, alias: EVENT_SEARCH_WRITE_ALIAS, is_write_index: true } },
    ];

    await this.client.indices.updateAliases({ actions });

    this.logger.info(
      { index, previousIndices, indexedDocuments: actualCount },
      'Elasticsearch aliases moved to rebuilt event index',
    );

    return { index, previousIndices, indexedDocuments: actualCount };
  }
}
```

Add these scripts to the `scripts` object in `package.json`:

```json
"search:reindex": "tsx src/workers/search-reindex.ts",
"search:reindex:prod": "node dist/workers/search-reindex.js"
```

The reindex worker needs only Prisma and Elasticsearch. It must not import the
full HTTP-server environment schema, which also requires raw `pg`, JWT, Redis,
SSE, and WebSocket settings. Create `src/config/search-reindex-env.ts` with
this **complete file**:

```ts
import { z } from 'zod';

import { elasticsearchEnvironmentShape } from './elasticsearch-environment.js';

const searchReindexEnvironmentSchema = z.object({
  DATABASE_URL: z.url(),
  PRISMA_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  ...elasticsearchEnvironmentShape,
});

export type SearchReindexEnvironment = z.infer<typeof searchReindexEnvironmentSchema>;

export const parseSearchReindexEnvironment = (input: NodeJS.ProcessEnv): SearchReindexEnvironment =>
  searchReindexEnvironmentSchema.parse(input);
```

Create `src/workers/search-reindex.ts` with this **complete file**:

```ts
import 'dotenv/config';

import pino from 'pino';

import { parseSearchReindexEnvironment } from '../config/search-reindex-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { EventSearchIndex } from '../infrastructure/elasticsearch/event-search-index.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { EventSearchSourceRepository } from '../modules/search/event-search-source.repository.js';

const logger = pino();
const searchReindexEnvironment = parseSearchReindexEnvironment(process.env);
const prisma = createPrismaClient(searchReindexEnvironment);
const elasticsearch = createElasticsearchClient(searchReindexEnvironment, logger);

try {
  const source = new EventSearchSourceRepository(prisma);
  const index = new EventSearchIndex(
    elasticsearch,
    searchReindexEnvironment.ELASTICSEARCH_INDEX_PREFIX,
    logger,
  );
  const result = await index.rebuild(source);
  logger.info(result, 'Event search reindex completed');
} catch (error) {
  logger.error({ err: error }, 'Event search reindex failed');
  process.exitCode = 1;
} finally {
  await Promise.all([prisma.$disconnect(), closeElasticsearchClient(elasticsearch)]);
}
```

Because this parser is worker-specific, host-side `yarn search:reindex` needs
`DATABASE_URL`, `PRISMA_POOL_MAX`, and the Elasticsearch variables from
`.env`; it does not need `PGHOST`, `PGDATABASE`, `PGUSER`, or `PGPASSWORD`.

### Verification

Stop application writers, leave PostgreSQL and Elasticsearch running, then
run the development command:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml stop app
yarn search:reindex
Invoke-RestMethod -Uri http://127.0.0.1:9200/_cat/indices?format=json
Invoke-RestMethod -Uri http://127.0.0.1:9200/_cat/aliases?format=json
docker compose -f compose.yaml -f compose.dev.yaml start app
```

For the compiled image:

```powershell
docker compose stop app
docker compose run --rm app yarn search:reindex:prod
docker compose start app
```

Run the command twice with writes still stopped. Confirm a second physical
index is created, both aliases move together, and the first physical index is
retained.

### Expected result

The alias swap happens only after a successful bulk load and exact count
comparison. Failure before the swap leaves current search untouched, and a
second run proves rebuild is repeatable rather than a one-time bootstrap.

---

## Checkpoint 8: Define validated search inputs and an opaque cursor

### Reason

Never expose raw Query DSL. It would allow callers to choose expensive query
shapes, fields, scripts, and result sizes. The HTTP boundary accepts a small
product vocabulary and the repository constructs a fixed query.

Deep `from`/`size` pagination makes every shard retain skipped hits and becomes
increasingly expensive. Use `search_after` instead. A point in time (PIT)
freezes the index view across pages so refreshes do not cause duplicates or
gaps. The cursor carries the PIT ID, last sort values, and a fingerprint of the
original filters. It is opaque to callers and expires with the PIT.

This cursor is not an authorization credential. It does not need a signature,
but it is strictly decoded and cannot be reused with different filters.

### Implementation

Create `src/modules/search/search.schemas.ts` with this **complete file**:

```ts
import { z } from 'zod';

const optionalInstantSchema = z.iso
  .datetime({ offset: true })
  .optional()
  .transform((value) => (value === undefined ? null : new Date(value)));

const optionalText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .optional()
    .transform((value) => value ?? null);

export const searchEventsRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({}),
  query: z
    .object({
      q: optionalText(100),
      communityId: z
        .uuid()
        .optional()
        .transform((value) => value ?? null),
      format: z
        .enum(['IN_PERSON', 'ONLINE', 'HYBRID'])
        .optional()
        .transform((value) => value ?? null),
      city: optionalText(100),
      country: optionalText(100),
      startsAfter: optionalInstantSchema,
      startsBefore: optionalInstantSchema,
      after: z
        .string()
        .min(1)
        .max(8_192)
        .optional()
        .transform((value) => value ?? null),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    .strict()
    .refine(
      (query) =>
        query.startsAfter === null ||
        query.startsBefore === null ||
        query.startsAfter < query.startsBefore,
      { path: ['startsBefore'], message: 'startsBefore must be after startsAfter' },
    ),
});

export const suggestEventsRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({}),
  query: z
    .object({
      q: z.string().trim().min(2).max(80),
      limit: z.coerce.number().int().min(1).max(10).default(8),
    })
    .strict(),
});

export type SearchEventsRequest = z.infer<typeof searchEventsRequestSchema>;
export type SuggestEventsRequest = z.infer<typeof suggestEventsRequestSchema>;
```

Create `src/modules/search/search.cursor.ts` with this **complete file**:

```ts
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { AppError } from '../../shared/errors/app-error.js';
import type { EventSearchQuery } from './search.types.js';

const sortValueSchema = z.union([z.string(), z.number().finite()]);

const searchCursorSchema = z
  .object({
    v: z.literal(1),
    pitId: z.string().min(1).max(4_096),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sort: z.array(sortValueSchema).min(2).max(4),
  })
  .strict();

export type SearchCursor = z.infer<typeof searchCursorSchema>;

export const fingerprintSearchQuery = (query: EventSearchQuery): string => {
  const canonical = JSON.stringify({
    q: query.q,
    communityId: query.communityId,
    format: query.format,
    city: query.city,
    country: query.country,
    startsAfter: query.startsAfter?.toISOString() ?? null,
    startsBefore: query.startsBefore?.toISOString() ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
};

export const encodeSearchCursor = (cursor: SearchCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export const decodeSearchCursor = (value: string): SearchCursor => {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return searchCursorSchema.parse(decoded);
  } catch {
    throw new AppError(400, 'INVALID_SEARCH_CURSOR', 'The search cursor is invalid');
  }
};
```

The query fingerprint intentionally excludes `limit`: a caller may request a
different bounded page size while continuing the same result set. It includes
every value which changes membership, score, or ordering.

### Verification

```powershell
yarn typecheck
yarn lint
```

Try malformed base64, valid JSON with extra fields, excessive cursor length,
equal time bounds, and a one-character suggestion. Each must fail at the HTTP
boundary before Elasticsearch is called.

### Expected result

Callers can express only the documented discovery operations, result size is
bounded, and a cursor is structurally valid and bound to one query.

---

## Checkpoint 9: Implement text search, filters, facets, PIT, and suggestions

### Reason

Use scoring queries for relevance and filter context for exact constraints.
Filters do not affect scores and are cache-friendly inside Elasticsearch.
Boost title above community name and description. `fuzziness: AUTO` tolerates
ordinary misspellings while `prefix_length: 1` prevents the broadest edits at
the first character.

Suggestions are a different query shape. `multi_match` with `bool_prefix`
targets the `search_as_you_type` root, shingle, and prefix fields. Do not use a
fuzzy full-text search as autocomplete on every keystroke.

Result documents are validated with Zod. A malformed projection is an index
repair problem, not data to pass through to the public API.

### Implementation

Create `src/modules/search/search.repository.ts` with this **complete file**:

```ts
import { errors, type Client, type estypes } from '@elastic/elasticsearch';
import type { Logger } from 'pino';

import { EVENT_SEARCH_READ_ALIAS } from '../../infrastructure/elasticsearch/event-index-definition.js';
import { AppError } from '../../shared/errors/app-error.js';
import { eventSearchDocumentSchema } from './event-search-document.schema.js';
import { decodeSearchCursor, encodeSearchCursor, fingerprintSearchQuery } from './search.cursor.js';
import type {
  EventSearchDocument,
  EventSearchFacets,
  EventSearchPage,
  EventSearchQuery,
  EventSuggestion,
  SearchFacetBucket,
} from './search.types.js';

interface TermsAggregation {
  buckets?: Array<{ key: string | number; doc_count: number }>;
}

const toFacetBuckets = (value: unknown): SearchFacetBucket[] => {
  const aggregate = value as TermsAggregation | undefined;
  return (aggregate?.buckets ?? []).map((bucket) => ({
    value: String(bucket.key),
    count: bucket.doc_count,
  }));
};

const totalHits = (value: number | estypes.SearchTotalHits | undefined): number => {
  if (value === undefined) return 0;
  return typeof value === 'number' ? value : value.value;
};

const mapSearchFailure = (error: unknown, usedCursor: boolean): never => {
  if (usedCursor && error instanceof errors.ResponseError && error.statusCode === 404) {
    throw new AppError(
      400,
      'SEARCH_CURSOR_EXPIRED',
      'The search cursor expired; start the search again',
    );
  }

  if (
    error instanceof errors.ConnectionError ||
    error instanceof errors.TimeoutError ||
    error instanceof errors.ResponseError
  ) {
    throw new AppError(503, 'SEARCH_UNAVAILABLE', 'Event discovery is temporarily unavailable');
  }

  throw error;
};

export class SearchRepository {
  public constructor(
    private readonly client: Client,
    private readonly logger: Logger,
  ) {}

  public async searchEvents(query: EventSearchQuery): Promise<EventSearchPage> {
    const fingerprint = fingerprintSearchQuery(query);
    const cursor = query.after === null ? null : decodeSearchCursor(query.after);

    if (cursor !== null && cursor.fingerprint !== fingerprint) {
      throw new AppError(
        400,
        'SEARCH_CURSOR_MISMATCH',
        'The search cursor belongs to different filters',
      );
    }

    let pitId = cursor?.pitId;
    let openedPit = false;

    try {
      if (pitId === undefined) {
        pitId = (
          await this.client.openPointInTime({
            index: EVENT_SEARCH_READ_ALIAS,
            keep_alive: '1m',
          })
        ).id;
        openedPit = true;
      }

      const filters: estypes.QueryDslQueryContainer[] = [];
      if (query.communityId !== null) {
        filters.push({ term: { communityId: query.communityId } });
      }
      if (query.format !== null) filters.push({ term: { format: query.format } });
      if (query.city !== null) filters.push({ term: { communityCity: query.city } });
      if (query.country !== null) {
        filters.push({ term: { communityCountry: query.country } });
      }
      if (query.startsAfter !== null || query.startsBefore !== null) {
        filters.push({
          range: {
            startsAt: {
              ...(query.startsAfter === null ? {} : { gte: query.startsAfter.toISOString() }),
              ...(query.startsBefore === null ? {} : { lt: query.startsBefore.toISOString() }),
            },
          },
        });
      }

      const relevanceQuery: estypes.QueryDslQueryContainer =
        query.q === null
          ? { match_all: {} }
          : {
              multi_match: {
                query: query.q,
                fields: ['title^4', 'communityName^2', 'description'],
                type: 'best_fields',
                fuzziness: 'AUTO',
                prefix_length: 1,
              },
            };

      const sort: estypes.Sort =
        query.q === null
          ? [{ startsAt: 'asc' }, { id: 'asc' }]
          : [{ _score: { order: 'desc' } }, { startsAt: 'asc' }, { id: 'asc' }];

      const response = await this.client.search<EventSearchDocument>({
        size: query.limit + 1,
        track_total_hits: true,
        pit: { id: pitId, keep_alive: '1m' },
        query: { bool: { must: [relevanceQuery], filter: filters } },
        sort,
        ...(cursor === null ? {} : { search_after: cursor.sort }),
        aggs: {
          formats: { terms: { field: 'format', size: 10 } },
          cities: { terms: { field: 'communityCity', size: 25 } },
          countries: { terms: { field: 'communityCountry', size: 25 } },
        },
      });

      const parsedHits = response.hits.hits.map((hit) => {
        const parsed = eventSearchDocumentSchema.safeParse(hit._source);
        if (!parsed.success) {
          this.logger.error(
            { documentId: hit._id, issues: parsed.error.issues },
            'Elasticsearch returned an invalid event projection',
          );
          throw new AppError(
            503,
            'SEARCH_INDEX_INVALID',
            'Event discovery is temporarily unavailable',
          );
        }
        if (hit.sort === undefined) {
          throw new AppError(
            503,
            'SEARCH_INDEX_INVALID',
            'Event discovery is temporarily unavailable',
          );
        }
        return { event: parsed.data, score: hit._score ?? null, sort: hit.sort };
      });

      const hasNext = parsedHits.length > query.limit;
      const pageHits = parsedHits.slice(0, query.limit);
      const latestPitId = response.pit_id ?? pitId;
      const lastHit = pageHits.at(-1);

      let nextCursor: string | null = null;
      if (hasNext && lastHit !== undefined) {
        const parsedSort = lastHit.sort.map((value) => {
          if (typeof value === 'string' || typeof value === 'number') return value;
          throw new AppError(
            503,
            'SEARCH_INDEX_INVALID',
            'Event discovery is temporarily unavailable',
          );
        });
        nextCursor = encodeSearchCursor({
          v: 1,
          pitId: latestPitId,
          fingerprint,
          sort: parsedSort,
        });
      } else {
        await this.closePointInTime(latestPitId);
      }

      const facets: EventSearchFacets = {
        formats: toFacetBuckets(response.aggregations?.['formats']),
        cities: toFacetBuckets(response.aggregations?.['cities']),
        countries: toFacetBuckets(response.aggregations?.['countries']),
      };

      return {
        items: pageHits.map(({ event, score }) => ({ event, score })),
        total: totalHits(response.hits.total),
        nextCursor,
        facets,
      };
    } catch (error) {
      if (pitId !== undefined && openedPit) await this.closePointInTime(pitId);
      return mapSearchFailure(error, cursor !== null);
    }
  }

  public async suggestEvents(query: string, limit: number): Promise<EventSuggestion[]> {
    try {
      const response = await this.client.search<EventSearchDocument>({
        index: EVENT_SEARCH_READ_ALIAS,
        size: limit,
        _source: ['id', 'title', 'communityName', 'startsAt'],
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query,
                  type: 'bool_prefix',
                  fields: ['title', 'title._2gram', 'title._3gram'],
                },
              },
            ],
            filter: [{ range: { startsAt: { gte: 'now' } } }],
          },
        },
        sort: [{ _score: { order: 'desc' } }, { startsAt: 'asc' }, { id: 'asc' }],
      });

      return response.hits.hits.map((hit) => {
        const parsed = eventSearchDocumentSchema
          .pick({ id: true, title: true, communityName: true, startsAt: true })
          .safeParse(hit._source);
        if (!parsed.success) {
          this.logger.error(
            { documentId: hit._id, issues: parsed.error.issues },
            'Elasticsearch returned an invalid event suggestion',
          );
          throw new AppError(
            503,
            'SEARCH_INDEX_INVALID',
            'Event discovery is temporarily unavailable',
          );
        }
        return parsed.data;
      });
    } catch (error) {
      return mapSearchFailure(error, false);
    }
  }

  private async closePointInTime(id: string): Promise<void> {
    try {
      await this.client.closePointInTime({ id });
    } catch (error) {
      this.logger.debug({ err: error }, 'Could not close Elasticsearch point in time');
    }
  }
}
```

Why request `limit + 1`? It proves another result exists without reporting a
cursor which leads immediately to an empty page. The cursor uses the last
returned hit, not the extra look-ahead hit.

Why no silent PostgreSQL fallback? A SQL fallback would have different typo,
relevance, facet, and cursor semantics. Returning a safe `503` is honest and
leaves ordinary event list/detail endpoints available.

The facets in this first slice are counts after all active filters. A later UI
may require self-excluding facets (for example, format counts ignoring the
currently selected format). Implement that explicitly with filter/global
aggregations only when the product needs it.

### Verification

```powershell
yarn typecheck
yarn lint
```

Use Elasticsearch's profile API only during a deliberate measurement session;
do not expose it through the application endpoint. Inspect one search request
and identify which clauses score and which only filter.

### Expected result

Search uses a fixed query shape, validates every returned document, produces
stable bounded pages, closes completed PITs, and exposes no raw Elasticsearch
request surface.

---

## Checkpoint 10: Expose the search module through thin HTTP layers

### Reason

Preserve Gatherly's normal dependency direction:

```text
route -> controller -> service -> repository -> Elasticsearch
```

The controller translates dates and response shape. It does not build Query
DSL. The service is intentionally small now, but it is the future home for
product-level search policy which should not leak into the transport.

### Implementation

Create `src/modules/search/search.service.ts` with this **complete file**:

```ts
import type { SearchRepository } from './search.repository.js';
import type { EventSearchPage, EventSearchQuery, EventSuggestion } from './search.types.js';

export class SearchService {
  public constructor(private readonly repository: SearchRepository) {}

  public searchEvents(query: EventSearchQuery): Promise<EventSearchPage> {
    return this.repository.searchEvents(query);
  }

  public suggestEvents(query: string, limit: number): Promise<EventSuggestion[]> {
    return this.repository.suggestEvents(query, limit);
  }
}
```

Create `src/modules/search/search.controller.ts` with this **complete file**:

```ts
import type { RequestHandler } from 'express';

import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { SearchEventsRequest, SuggestEventsRequest } from './search.schemas.js';
import type { SearchService } from './search.service.js';

export class SearchController {
  public constructor(private readonly service: SearchService) {}

  public readonly searchEvents: RequestHandler = async (_request, response) => {
    const { query } = getValidated<SearchEventsRequest>(response);
    const page = await this.service.searchEvents(query);
    response.json({
      data: page.items,
      pagination: { total: page.total, nextCursor: page.nextCursor },
      facets: page.facets,
    });
  };

  public readonly suggestEvents: RequestHandler = async (_request, response) => {
    const { query } = getValidated<SuggestEventsRequest>(response);
    response.json({ data: await this.service.suggestEvents(query.q, query.limit) });
  };
}
```

Create `src/modules/search/search.routes.ts` with this **complete file**:

```ts
import { Router } from 'express';

import { validate } from '../../shared/validation/validate.middleware.js';
import type { SearchController } from './search.controller.js';
import { searchEventsRequestSchema, suggestEventsRequestSchema } from './search.schemas.js';

export const createSearchRouter = (controller: SearchController): Router => {
  const router = Router();
  router.get('/search/events', validate(searchEventsRequestSchema), controller.searchEvents);
  router.get(
    '/search/events/suggestions',
    validate(suggestEventsRequestSchema),
    controller.suggestEvents,
  );
  return router;
};
```

In `src/app.ts`, add `searchRouter?: Router` to `AppDependencies`, then mount it
before the not-found handler when supplied:

```ts
if (dependencies.searchRouter !== undefined) {
  app.use('/api', dependencies.searchRouter);
}
```

The routes are public because their projection contains only public published
events. Do not later reuse this endpoint for private/community-only content by
adding a loose membership filter.

### Verification

```powershell
yarn typecheck
yarn lint
```

After composition-root wiring in Checkpoint 12, exercise:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/search/events?q=potery&limit=10'
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/search/events/suggestions?q=woodw'
```

### Expected result

HTTP concerns remain thin, search policy remains in the search module, and no
Elasticsearch client escapes into controllers or routes.

---

## Checkpoint 11: Project committed event creates without coupling truth to search

### Reason

After PostgreSQL commits an event, schedule a projection refresh which reloads
the canonical row. Do not send the request body directly to Elasticsearch.
The refresh may discover that the row is ineligible and delete its old search
document.

The task is tracked so graceful shutdown can wait for work already accepted by
this process. Failures are logged and swallowed: an Elasticsearch outage must
not turn a committed event into an HTTP error. This still is not durable job
delivery. A crash between commit and scheduling can cause drift, repaired by a
full reindex.

### Implementation

Add this module-owned port to `src/modules/events/events.types.ts`:

```ts
export interface EventSearchProjection {
  schedule(eventId: string): void;
}
```

Create `src/modules/search/event-search-projector.ts` with this **complete
file**:

```ts
import type { Logger } from 'pino';

import type { EventSearchIndex } from '../../infrastructure/elasticsearch/event-search-index.js';
import type { EventSearchProjection } from '../events/events.types.js';
import type { EventSearchSourceRepository } from './event-search-source.repository.js';

export class BestEffortEventSearchProjector implements EventSearchProjection {
  private readonly pending = new Set<Promise<void>>();

  public constructor(
    private readonly source: EventSearchSourceRepository,
    private readonly index: EventSearchIndex,
    private readonly logger: Logger,
  ) {}

  public schedule(eventId: string): void {
    const task = this.sync(eventId).catch((error: unknown) => {
      this.logger.warn(
        { err: error, eventId },
        'Event committed but its search projection could not be refreshed',
      );
    });

    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  public async drain(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async sync(eventId: string): Promise<void> {
    const document = await this.source.findEligibleById(eventId);
    if (document === null) {
      await this.index.delete(eventId);
      return;
    }
    await this.index.index(document);
  }
}
```

Change the `EventsService` constructor in
`src/modules/events/events.service.ts`:

```ts
public constructor(
  private readonly repository: EventsRepository,
  private readonly cache?: EventCache,
  private readonly searchProjection?: EventSearchProjection,
) {}
```

Add `EventSearchProjection` to the existing type import from
`events.types.ts`, then replace the final line of `create`:

```ts
const event = await this.repository.create(communityId, userId, input);
this.searchProjection?.schedule(event.id);
return event;
```

The schedule call belongs after the awaited create. When future event update,
publish, cancel, archive, or community-status operations are implemented, call
the same port after their transactions commit. A community name/location or
status change must schedule every affected event ID; do not update
denormalized documents from client input.

### Verification

With Elasticsearch running and aliases initialized, create an event through
the authenticated API, wait for the next refresh interval, and inspect by ID:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:9200/gatherly-events-read/_search `
  -Method Post `
  -ContentType application/json `
  -Body '{"query":{"term":{"title":"this-does-not-use-analysis"}}}'
```

Prefer verifying through Gatherly's search endpoint. The direct request above
is only an inspection exercise and intentionally demonstrates that a `term`
query is wrong for analyzed title text.

Stop Elasticsearch, create another event, and confirm the event API still
returns `201` and PostgreSQL contains the row. Search will be stale until the
cluster returns and a reindex repairs it.

### Expected result

Committed writes never roll back because search failed, the process tracks
accepted in-memory projection work for shutdown, and the stale-data limitation
is explicit rather than hidden.

---

## Checkpoint 12: Wire search in the composition root and graceful shutdown

### Reason

The composition root owns infrastructure construction and lifecycle. Search
stays optional for process health: the client is created lazily, ordinary
PostgreSQL endpoints start when Elasticsearch is absent, and only search
requests return `503`.

Drain accepted projection tasks before closing Elasticsearch or Prisma. Do not
close the client from a route, repository, or projector.

### Implementation

Add these imports to `src/server.ts`:

```ts
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from './infrastructure/elasticsearch/client.js';
import { EventSearchIndex } from './infrastructure/elasticsearch/event-search-index.js';
import { BestEffortEventSearchProjector } from './modules/search/event-search-projector.js';
import { EventSearchSourceRepository } from './modules/search/event-search-source.repository.js';
import { SearchController } from './modules/search/search.controller.js';
import { SearchRepository } from './modules/search/search.repository.js';
import { createSearchRouter } from './modules/search/search.routes.js';
import { SearchService } from './modules/search/search.service.js';
```

After creating `prisma`, create the shared client and search objects:

```ts
const elasticsearch = createElasticsearchClient(environment, logger);
const eventSearchSource = new EventSearchSourceRepository(prisma);
const eventSearchIndex = new EventSearchIndex(
  elasticsearch,
  environment.ELASTICSEARCH_INDEX_PREFIX,
  logger,
);
const eventSearchProjector = new BestEffortEventSearchProjector(
  eventSearchSource,
  eventSearchIndex,
  logger,
);
const searchService = new SearchService(new SearchRepository(elasticsearch, logger));
const searchRouter = createSearchRouter(new SearchController(searchService));
```

Pass the projector when constructing `EventsService`:

```ts
const eventsService = new EventsService(eventsRepository, eventCache, eventSearchProjector);
```

Pass `searchRouter` to `createApp`:

```ts
searchRouter,
```

Change `closeDependencies` so projection work drains before shared clients
close:

```ts
closeDependencies: async () => {
  await eventSearchProjector.drain();
  await Promise.all([
    chatBus.close(),
    realtimeBus.close(),
    closeRedisClient(redis),
    closeElasticsearchClient(elasticsearch),
    prisma.$disconnect(),
    pool.end(),
  ]);
},
```

Do not add Elasticsearch to `checkReadiness`. A healthy Gatherly process with
healthy PostgreSQL remains ready even if discovery is degraded. Later
observability should expose a separate search dependency signal and indexing
failure count without changing that ownership decision.

Existing tests need no search fake because `searchRouter` is optional in
`AppDependencies`. To compose real API search tests, update
`tests/helpers/test-app.ts` by adding the optional dependency and imports for
`SearchController`, `createSearchRouter`, and `SearchService`:

```ts
searchService?: SearchService;
```

Create the router only when supplied:

```ts
const searchRouter =
  dependencies.searchService === undefined
    ? undefined
    : createSearchRouter(new SearchController(dependencies.searchService));
```

Spread it into the final `createApp` call in the same style as realtime/chat:

```ts
...(searchRouter === undefined ? {} : { searchRouter }),
```

Production `server.ts` always passes the real router. Tests outside the search
module remain independent of Elasticsearch.

### Verification

```powershell
yarn prisma:generate
yarn typecheck
yarn lint
yarn build
```

Start the app with Elasticsearch stopped. Verify:

```text
GET /health/live        -> 200
GET /health/ready       -> 200 when PostgreSQL is healthy
GET /api/events         -> 200
GET /api/search/events  -> 503 SEARCH_UNAVAILABLE
```

Start Elasticsearch and run `yarn search:reindex`; search begins working
without moving any PostgreSQL truth.

### Expected result

One Elasticsearch client is shared, search failure is isolated to search,
existing test composition does not require Elasticsearch, and shutdown drains
projection work before closing dependencies.

---

## Checkpoint 13: Document and manually inspect the HTTP contract

### Reason

Search behavior is an API contract: analyzed text, exact filter casing, facet
semantics, default ordering, cursor lifetime, staleness, and outage responses
must not be left to guesswork.

### Implementation

Create `docs/openapi/search/paths.yaml` with this **complete file**:

```yaml
events:
  get:
    tags: [Search]
    summary: Search public published events
    description: |
      Searches a rebuildable Elasticsearch projection. PostgreSQL remains the
      source of truth. Exact filters are case-sensitive. Cursors expire after
      approximately one minute and are valid only with the original filters.
    parameters:
      - { name: q, in: query, schema: { type: string, minLength: 1, maxLength: 100 } }
      - { name: communityId, in: query, schema: { type: string, format: uuid } }
      - { name: format, in: query, schema: { type: string, enum: [IN_PERSON, ONLINE, HYBRID] } }
      - { name: city, in: query, schema: { type: string, maxLength: 100 } }
      - { name: country, in: query, schema: { type: string, maxLength: 100 } }
      - { name: startsAfter, in: query, schema: { type: string, format: date-time } }
      - { name: startsBefore, in: query, schema: { type: string, format: date-time } }
      - { name: after, in: query, schema: { type: string, maxLength: 8192 } }
      - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
    responses:
      '200':
        description: Search results, facets, and an optional next cursor.
        content:
          application/json:
            schema:
              type: object
              required: [data, pagination, facets]
              properties:
                data:
                  type: array
                  items:
                    type: object
                    required: [event, score]
                    properties:
                      event: { $ref: '../../openapi.yaml#/components/schemas/SearchEvent' }
                      score: { type: number, nullable: true }
                pagination:
                  type: object
                  required: [total, nextCursor]
                  properties:
                    total: { type: integer, minimum: 0 }
                    nextCursor: { type: string, nullable: true }
                facets:
                  $ref: '../../openapi.yaml#/components/schemas/SearchFacets'
      '400': { $ref: '../../openapi.yaml#/components/responses/Error' }
      '503': { $ref: '../../openapi.yaml#/components/responses/Error' }

suggestions:
  get:
    tags: [Search]
    summary: Suggest upcoming public event titles
    parameters:
      - {
          name: q,
          in: query,
          required: true,
          schema: { type: string, minLength: 2, maxLength: 80 },
        }
      - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 10, default: 8 } }
    responses:
      '200':
        description: Ranked title-prefix suggestions.
        content:
          application/json:
            schema:
              type: object
              required: [data]
              properties:
                data:
                  type: array
                  items:
                    type: object
                    required: [id, title, communityName, startsAt]
                    properties:
                      id: { type: string, format: uuid }
                      title: { type: string }
                      communityName: { type: string }
                      startsAt: { type: string, format: date-time }
      '400': { $ref: '../../openapi.yaml#/components/responses/Error' }
      '503': { $ref: '../../openapi.yaml#/components/responses/Error' }
```

Add the tag and path references to `docs/openapi.yaml`:

```yaml
- name: Search
  description: Public event discovery backed by a rebuildable Elasticsearch projection.
```

```yaml
/api/search/events:
  $ref: './openapi/search/paths.yaml#/events'
/api/search/events/suggestions:
  $ref: './openapi/search/paths.yaml#/suggestions'
```

Add these schemas under `components.schemas`:

```yaml
SearchEvent:
  type: object
  additionalProperties: false
  required:
    - id
    - communityId
    - communityName
    - communitySlug
    - communityCity
    - communityCountry
    - title
    - description
    - format
    - startsAt
    - endsAt
    - timezone
    - updatedAt
  properties:
    id: { type: string, format: uuid }
    communityId: { type: string, format: uuid }
    communityName: { type: string }
    communitySlug: { type: string }
    communityCity: { type: string, nullable: true }
    communityCountry: { type: string, nullable: true }
    title: { type: string }
    description: { type: string }
    format: { type: string, enum: [IN_PERSON, ONLINE, HYBRID] }
    startsAt: { type: string, format: date-time }
    endsAt: { type: string, format: date-time }
    timezone: { type: string }
    updatedAt: { type: string, format: date-time }
SearchFacetBucket:
  type: object
  additionalProperties: false
  required: [value, count]
  properties:
    value: { type: string }
    count: { type: integer, minimum: 0 }
SearchFacets:
  type: object
  additionalProperties: false
  required: [formats, cities, countries]
  properties:
    formats:
      type: array
      items: { $ref: '#/components/schemas/SearchFacetBucket' }
    cities:
      type: array
      items: { $ref: '#/components/schemas/SearchFacetBucket' }
    countries:
      type: array
      items: { $ref: '#/components/schemas/SearchFacetBucket' }
```

Update the top-level OpenAPI description to say it covers the Elasticsearch
event-discovery increment and that search is rebuildable/non-authoritative.

Add a README paragraph after the WebSocket handbook paragraph:

```markdown
Next use the build-it-yourself Elasticsearch event-discovery guide in
[`PHASE_6_ELASTICSEARCH_HANDBOOK.md`](./PHASE_6_ELASTICSEARCH_HANDBOOK.md). It
adds a strict rebuildable public-event projection, versioned indices and atomic
aliases, typo-tolerant search, autocomplete, filters, facets, PIT cursor
pagination, best-effort post-commit indexing, a full maintenance-window
reindex command, and explicit search-outage behavior. PostgreSQL remains the
source of truth, and Kafka stays deferred to its own later increment.
```

### Manual protocol exercise

Create at least these canonical rows:

```text
Beginner pottery workshop | IN_PERSON | Moscow | Russia
Advanced pottery glazing  | IN_PERSON | Moscow | Russia
Woodworking basics        | IN_PERSON | Kazan  | Russia
Remote TypeScript meetup  | ONLINE    | null   | null
```

Then inspect:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/search/events?q=potery'
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/search/events?q=workshop&format=IN_PERSON&city=Moscow&limit=1'
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/search/events/suggestions?q=woodw'
```

Follow `pagination.nextCursor` with exactly the same filters. Then change
`city` while reusing it and expect `400 SEARCH_CURSOR_MISMATCH`. Wait beyond
the PIT lifetime and expect `400 SEARCH_CURSOR_EXPIRED`.

Inspect direct Elasticsearch state only as an operator:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:9200/_cat/aliases?format=json
Invoke-RestMethod -Uri http://127.0.0.1:9200/gatherly-events-read/_mapping
Invoke-RestMethod -Uri http://127.0.0.1:9200/gatherly-events-read/_count
```

### Expected result

The public contract explains relevance, exact filters, facet behavior,
cursor lifetime, staleness, and `503` degradation, and manual results match the
documented product examples.

---

## Checkpoint 14: Prove behavior with real Elasticsearch

### Why the integration test is separate

The learner should first inspect mappings, analysis, aliases, queries, and PIT
behavior manually. Mocks cannot prove analysis, refresh visibility, alias
atomicity, bulk behavior, or a real point in time. At this checkpoint, hand the
automated behavioral suite to AI, following the SSE and WebSocket handbooks.

All production files above are complete. The test step must not redesign the
index as authoritative, add Kafka, weaken document validation, silently fall
back to SQL, or make Elasticsearch a readiness dependency merely to simplify
assertions.

### Instructions for the AI coding agent

Give the AI this task:

> Read `AGENTS.md`, `README.md`,
> `PHASE_6_POSTGRES_PERFORMANCE_REDIS_HANDBOOK.md`,
> `PHASE_6_SSE_HANDBOOK.md`, `PHASE_6_WEBSOCKETS_HANDBOOK.md`, and
> `PHASE_6_ELASTICSEARCH_HANDBOOK.md`. Inspect the implemented source,
> Compose files, OpenAPI, migrations, and test helpers. Implement the smallest
> behavioral test suite which proves the Elasticsearch event-discovery
> contract below. Use a real Elasticsearch 9.4.3 Testcontainer for mapping,
> analysis, aliases, bulk, PIT, and outage claims, plus the existing real
> PostgreSQL Testcontainer for projection truth. Do not add features, Kafka,
> private search, or a semantically different PostgreSQL fallback. Use Yarn
> Classic, preserve unrelated changes, run the proportional gate, and report
> exact commands and results.

Create `tests/helpers/elasticsearch.ts` around the official module. The core
construction should be:

```ts
import { Client } from '@elastic/elasticsearch';
import {
  ElasticsearchContainer,
  type StartedElasticsearchContainer,
} from '@testcontainers/elasticsearch';

const container: StartedElasticsearchContainer = await new ElasticsearchContainer(
  'docker.elastic.co/elasticsearch/elasticsearch:9.4.3',
)
  .withPassword('test-only-elasticsearch-password')
  .start();

const client = new Client({
  node: container.getHttpUrl(),
  auth: {
    username: container.getUsername(),
    password: container.getPassword(),
  },
});
```

The helper must expose reset/stop operations, delete only indices created by
the test prefix, close the client before the container, and never use a wildcard
against a non-test cluster.

### Required behavioral coverage

The AI must cover all of these behaviors:

1. The physical index has one shard, zero replicas, strict mapping, expected
   field types, and no capacity/membership/private-chat fields.
2. An unknown field is rejected rather than dynamically mapped.
3. Source projection includes only public published events in active
   communities and maps nullable location and UTC instants correctly.
4. Source iteration handles more than one batch without duplicates, gaps, or
   loading every row at once.
5. Initial reindex creates both aliases, uses PostgreSQL IDs as `_id`, and
   indexes the exact eligible count.
6. A second successful reindex atomically moves both aliases together and
   retains the old physical index for rollback.
7. A dropped bulk document or count mismatch leaves aliases on the old index.
8. Repeating index for one event overwrites the same `_id`; making it
   ineligible deletes it. It never creates duplicates.
9. Typo search such as `potery` finds `pottery`; title ranks above a description
   only match when other facts are equal.
10. Community, format, exact city/country, and time filters combine correctly.
11. Facet counts match the already-filtered result set and null city/country
    values do not invent buckets.
12. Empty `q` orders by `startsAt,id`; text search orders by
    `_score,startsAt,id`.
13. PIT plus `search_after` returns every result exactly once across equal
    scores/times while a refresh adds another document outside the PIT.
14. The final page closes its PIT. Abandoned cursors expire. A malformed,
    oversized, cross-filter, or expired cursor returns the documented safe
    `400` code.
15. Suggestions require two characters, use title prefix fields, return only
    upcoming events, and respect the maximum limit.
16. A malformed `_source` never leaks through the API and returns safe
    `SEARCH_INDEX_INVALID`.
17. With Elasticsearch unavailable, search returns `503 SEARCH_UNAVAILABLE`,
    liveness/readiness and PostgreSQL event endpoints remain healthy, and no
    credential/query body is logged.
18. Event creation returns `201` and commits when projection indexing fails.
    After recovery, a full rebuild makes it discoverable.
19. Graceful shutdown waits for accepted projection tasks and closes the
    Elasticsearch client exactly once after the drain.
20. Existing reservation concurrency, Redis outage, SSE, WebSocket, auth, and
    PostgreSQL tests still pass.

### Suggested test placement

```text
tests/unit/search.schemas.test.ts
  query bounds, strict fields, time range, suggestion minimum

tests/unit/search.cursor.test.ts
  encode/decode, strict payload, fingerprint stability and mismatch

tests/integration/search-source-postgres.integration.test.ts
  eligibility, canonical mapping, bounded batch iteration

tests/integration/elasticsearch-index.integration.test.ts
  mapping, strict rejection, bulk rebuild, aliases, failure before swap

tests/integration/search-api.integration.test.ts
  real text analysis, filters, facets, PIT pages, suggestions, invalid source

tests/integration/search-degradation.integration.test.ts
  unavailable search, successful PostgreSQL writes, repair by rebuild

tests/integration/graceful-shutdown.test.ts
  projector drain and client close ordering
```

Use deterministic fixture terms rather than asserting unstable absolute BM25
scores. Assert ordering relationships and membership. Avoid arbitrary sleeps:
use `refresh: 'wait_for'`, an explicit refresh, or poll a bounded observable
condition.

### AI acceptance gate

```powershell
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn vitest run tests/unit/search.schemas.test.ts
yarn vitest run tests/unit/search.cursor.test.ts
yarn vitest run tests/integration/search-source-postgres.integration.test.ts
yarn vitest run tests/integration/elasticsearch-index.integration.test.ts
yarn vitest run tests/integration/search-api.integration.test.ts
yarn vitest run tests/integration/search-degradation.integration.test.ts
yarn vitest run tests/integration/graceful-shutdown.test.ts
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

If actual filenames differ, report the real commands. State which tests use
pure functions, real PostgreSQL, real Elasticsearch, or process lifecycle and
why.

### Expected result

The suite proves actual Elasticsearch analysis, projection eligibility,
rebuild safety, stable pagination, API validation, degradation, and lifecycle
without moving canonical decisions out of PostgreSQL.

---

## Reindex, rollback, and cleanup runbook

### Normal maintenance-window rebuild

1. Record current aliases and index counts.
2. Stop application writers.
3. Run the reindex command.
4. Inspect count, sample documents, mapping, and aliases.
5. Start the application.
6. Exercise search and one ordinary PostgreSQL write.
7. Retain the old index until the observation period ends.

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:9200/_cat/aliases?format=json
Invoke-RestMethod -Uri http://127.0.0.1:9200/_cat/indices/gatherly-events-v*?format=json
docker compose -f compose.yaml -f compose.dev.yaml stop app
yarn search:reindex
docker compose -f compose.yaml -f compose.dev.yaml start app
```

Do not run the current rebuild while event/community writers are active. The
bulk snapshot and post-commit direct writer do not yet have a durable catch-up
protocol.

### Rollback

If the new mapping/query behavior is wrong but the previous physical index is
still compatible with application reads, atomically move both aliases back.
Replace the two explicit names below after inspecting `_cat/aliases`:

```powershell
$body = @{
  actions = @(
    @{ remove = @{ index = 'gatherly-events-vNEW'; alias = 'gatherly-events-read' } }
    @{ remove = @{ index = 'gatherly-events-vNEW'; alias = 'gatherly-events-write' } }
    @{ add = @{ index = 'gatherly-events-vOLD'; alias = 'gatherly-events-read' } }
    @{ add = @{ index = 'gatherly-events-vOLD'; alias = 'gatherly-events-write'; is_write_index = $true } }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri http://127.0.0.1:9200/_aliases `
  -Method Post `
  -ContentType application/json `
  -Body $body
```

Rollback restores the previous search view, not PostgreSQL state. If
application code expects fields absent from the old mapping, roll back code and
aliases as one compatible release decision.

### Old-index cleanup

Never delete with `gatherly-events-v*` or `_all`. After the observation period:

1. inspect exact aliases;
2. confirm the candidate has no read/write alias;
3. record its exact physical name and document count;
4. delete that one explicit name;
5. remember that index deletion is not recoverable except by rebuilding.

Example only after substituting the inspected exact name:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:9200/gatherly-events-v20260812000000000 `
  -Method Delete
```

## Failure drills

### Elasticsearch absent at process startup

Expected:

- the process starts;
- PostgreSQL readiness remains healthy;
- auth, communities, events, reservations, SSE, and chat continue according to
  their own dependencies;
- search/suggestions return safe `503`;
- event commits succeed and projection failures are logged without bodies.

### Elasticsearch stops after a successful search

Expected:

- open or next-page requests fail within the bounded timeout;
- ordinary APIs remain healthy;
- abandoned PIT resources disappear when the cluster recovers/restarts;
- no application retry loop grows without bound.

### The search volume is lost

Expected:

- PostgreSQL data is unchanged;
- aliases are absent and search returns `503`;
- with application writes stopped, `yarn search:reindex` recreates the complete
  projection;
- result count and sample queries return to the recorded baseline.

### A projection fails after commit

Expected:

- HTTP create returns the committed event;
- the event may be temporarily absent from discovery;
- a later complete rebuild repairs it;
- no compensating PostgreSQL delete occurs.

### A rebuild fails midway

Expected:

- the target physical index may remain for inspection;
- read/write aliases still point at the old index;
- the command exits non-zero;
- rerunning creates a fresh version and does not append blindly to the failed
  target.

### A malformed document reaches the index

Expected:

- strict mapping rejects an unknown field on write;
- runtime `_source` validation rejects a wrong known-field shape on read;
- the public endpoint returns safe `503`, not unvalidated JSON;
- reindexing from PostgreSQL repairs the projection.

### A PIT cursor expires

Expected:

- the endpoint returns `400 SEARCH_CURSOR_EXPIRED`;
- the caller restarts from page one;
- the server does not silently continue against a different index snapshot.

### A community becomes archived

The current API has no archive mutation. When it is introduced, its
PostgreSQL transaction remains authoritative and all affected event IDs must
be scheduled after commit. Until that hook exists or if it fails, search may be
stale; detail/reservation authorization still uses PostgreSQL. A reindex removes
all archived-community documents.

### Disk watermark or rejected writes

Expected:

- committed PostgreSQL writes still succeed;
- projection/reindex logs identify failure without logging document bodies;
- search may serve the old projection;
- operators fix capacity, then rebuild or replay deliberately;
- application code does not disable Elasticsearch safety limits.

## Common mistakes

- Treating a search hit as current authorization or availability proof.
- Indexing private, community-only, draft, invitation, membership, or chat data
  in a public projection.
- Copying Prisma records wholesale into `_source`.
- Enabling dynamic mappings and discovering accidental fields later.
- Using `text` fields for exact filters or `keyword` fields for analyzed text.
- Running `term` against analyzed `title` and concluding search is broken.
- Accepting raw Query DSL, sort fields, scripts, or result sizes from callers.
- Using `from`/`size` for arbitrarily deep pages.
- Using `search_after` without a deterministic tie-breaker.
- Reusing a cursor with changed filters or ignoring PIT expiry.
- Leaving every abandoned PIT open for a long retention period.
- Calling `refresh` after every incremental document and destroying throughput.
- Using random Elasticsearch `_id` values and creating duplicates on retry.
- Returning event create failure after PostgreSQL committed but indexing failed.
- Broadcasting/indexing request bodies instead of reloading PostgreSQL truth.
- Claiming a best-effort direct write is durable asynchronous delivery.
- Running the maintenance-window rebuild concurrently with writers.
- Moving read and write aliases in separate requests.
- Deleting the old index before verifying and observing the new one.
- Using wildcard deletion commands in a shared cluster.
- Adding a PostgreSQL fallback with different search semantics but the same
  cursor/response claims.
- Making Elasticsearch part of readiness when only discovery depends on it.
- Exposing port 9200 publicly or connecting to Elasticsearch from a browser.
- Using the local security-disabled Compose service as a production design.
- Logging query bodies, API keys, private text, or full indexed documents.
- Adding Kibana, Logstash, Kafka, vectors, recommendations, or geo search before
  a concrete current requirement.

## Suggested commit sequence

1. `docs: add phase 6 elasticsearch handbook`
2. `infra: add local elasticsearch service and client lifecycle`
3. `feat: add strict public event search projection`
4. `feat: add verified versioned event reindex and aliases`
5. `feat: add event search suggestions filters facets and cursors`
6. `feat: refresh event search projection after commit`
7. `docs: document search contract and recovery runbook`
8. `test: prove elasticsearch projection rebuild and degradation` (AI checkpoint)

Do not combine Kafka, an online outbox consumer, semantic search, private
search, or unrelated event-domain mutations with these commits.

## Final examination

The Elasticsearch increment is complete when you can answer these without
guessing:

1. Which exact product requirements justify Elasticsearch over the measured
   PostgreSQL query?
2. Which fields are canonical in PostgreSQL and why are capacity/membership
   absent from the index?
3. Which rows are eligible for the public projection?
4. Why is `dynamic: strict` useful?
5. Why is title `search_as_you_type`, while format is `keyword`?
6. Why is the PostgreSQL UUID both Elasticsearch `_id` and a keyword field?
7. Which clauses affect score and which run in filter context?
8. What do field boosts and `fuzziness: AUTO` change?
9. Why is autocomplete a separate `bool_prefix` query?
10. Why does pagination use PIT plus `search_after` instead of deep
    `from`/`size`?
11. What prevents equal-score/equal-time hits from duplicating across pages?
12. What is inside the opaque cursor and why is it query-bound?
13. When is a PIT closed, and what happens if the caller abandons it?
14. Why are all `_source` documents validated on read?
15. Why does a committed event survive projection failure?
16. What drift can best-effort post-commit projection still create?
17. Why must the current full rebuild run with application writers stopped?
18. What would a later transactional outbox improve?
19. What is verified before aliases move?
20. Why must both aliases move in one atomic API call?
21. How do you roll back, and why is that separate from PostgreSQL rollback?
22. What happens if the whole Elasticsearch volume is deleted?
23. Why is search excluded from readiness?
24. Which behaviors require a real Elasticsearch Testcontainer?
25. Why is this still one modular monolith rather than a search microservice?

## Completion commands

After the AI testing checkpoint is complete, run:

```powershell
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose -f compose.yaml -f compose.dev.yaml up --detach postgres elasticsearch
docker compose -f compose.yaml -f compose.dev.yaml stop app
yarn search:reindex
docker compose -f compose.yaml -f compose.dev.yaml start app
```

Attach to the learning record:

```text
PostgreSQL comparison and product justification
physical index mapping
before/after aliases
PostgreSQL eligible count
Elasticsearch document count
sample typo and suggestion results
failure-before-alias-swap evidence
search-outage behavior
volume-loss and rebuild result
```

The deliverable is one bounded event-discovery projection. PostgreSQL remains
the durable source of truth, Redis remains disposable coordination/cache,
SSE/WebSockets remain transports, Elasticsearch remains rebuildable, and Kafka
remains a later lesson.

## Official references

- Elastic, [JavaScript client installation and compatibility](https://www.elastic.co/docs/reference/elasticsearch/clients/javascript/installation)
- Elastic, [Docker host requirements and `vm.max_map_count`](https://www.elastic.co/docs/deploy-manage/deploy/self-managed/install-elasticsearch-docker-prod)
- Elastic, [JavaScript client helpers and bulk helper](https://www.elastic.co/docs/reference/elasticsearch/clients/javascript/client-helpers)
- Elastic, [Aliases and atomic alias actions](https://www.elastic.co/guide/en/elasticsearch/reference/current/aliases.html)
- Elastic, [Dynamic mapping and `strict`](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/dynamic)
- Elastic, [`search_as_you_type` field](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/search-as-you-type)
- Elastic, [Query DSL full-text queries and filters](https://www.elastic.co/guide/en/elasticsearch/reference/current/full-text-filter-tutorial.html)
- Elastic, [Pagination, `search_after`, and point in time](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results)
- Elastic, [Bulk API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-bulk)
- Elastic, [`geo_point` mapping for the later location milestone](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/geo-point)
- Testcontainers for Node.js, [Elasticsearch module](https://node.testcontainers.org/modules/elasticsearch/)
