# Phase 8 Handbook: Scheduled Search Reconciliation with node-cron

This handbook implements the first, deliberately small Phase 8 increment:
schedule the existing search-projection reconciliation use case with
`node-cron`.

It does **not** implement BullMQ. The later BullMQ increment has a different
lesson and a different use case: operator-triggered full Elasticsearch reindex
jobs with retries and progress. Keeping those increments separate makes the
boundary visible:

```text
node-cron   decides when to invoke repeatable maintenance
BullMQ      distributes retryable operator jobs
Kafka       carries durable domain events from the PostgreSQL outbox
PostgreSQL  owns Gatherly's durable business truth
```

The samples target `node-cron` 4.6.x, Node.js 22.14 or newer, strict
TypeScript, ES modules, and the repository state after Phase 7. Check the
official [node-cron API reference](https://www.nodecron.com/api-reference.html),
[task lifecycle](https://www.nodecron.com/task-lifecycle.html), and
[scheduling options](https://www.nodecron.com/scheduling-options.html) before
implementing if a newer major version is available.

## How to use this handbook

Work one checkpoint at a time. At each checkpoint:

1. Read the reason and predict the failure mode the checkpoint prevents.
2. Type the sample rather than pasting it without inspection.
3. Run the focused verification before continuing.
4. Commit one coherent change when the exit evidence is true.

The code blocks marked **complete file** are intended to compile as written
against the current repository. Blocks marked **edit** show only the exact
additions or replacements for an existing larger file.

Do not add a second scheduled job while learning this increment. One job is
enough to learn expression validation, time zones, process roles, overlap,
distributed locking, observability, and graceful shutdown.

## Phase outcome

At the end of this handbook, the runtime topology is:

```text
                                  same immutable application image
                                                |
                 +------------------------------+------------------+
                 |                              |                  |
             HTTP API                   Kafka workers      search-scheduler
                                                                    |
                                         node-cron tick in Etc/UTC  |
                                                                    v
                                                    SearchReconciliationJob
                                                                    |
                                             pg_try_advisory_lock   |
                                                                    v
                                             SearchReconciler (read-only)
                                                /               \
                                     PostgreSQL source       Elasticsearch
```

The scheduler is a dedicated long-running process. It is not initialized from
`src/server.ts`, so scaling the HTTP API does not multiply schedules. An
accidental second scheduler, a manual reconciliation, or a delayed earlier run
cannot overlap the protected work because all paths use the same PostgreSQL
advisory-lock name.

### Success criteria

- `SEARCH_RECONCILIATION_CRON` is validated at startup.
- The expression is always evaluated in `Etc/UTC`.
- The process starts exactly one scheduled task.
- The scheduled callback invokes the same job used by the manual command.
- `noOverlap` skips a second tick inside one scheduler process.
- PostgreSQL advisory locking skips an overlapping run across processes.
- A locked skip is logged and counted as an expected outcome, not an error.
- Every run has a timeout and observes shutdown cancellation between bounded
  database and Elasticsearch requests.
- Shutdown stops new ticks, gives an active run a bounded grace period, then
  requests cancellation and closes dependencies.
- Logs record start, completion, duration, trigger, safe counts, and failures.
- Metrics expose run outcomes, duration, last completion, and drift counts.
- A unit test covers the cron callback independently from search logic.
- A real-PostgreSQL integration test proves that two process-like runners
  cannot both enter the protected operation.
- PostgreSQL truth is unchanged by clean, failed, repeated, or missed runs.

### Deliberate non-goals

Do not add any of these in this increment:

- BullMQ, Redis queues, job dashboards, retry backoff, or reindex progress;
- reminders, delayed notifications, event-status mutation, cleanup jobs, or
  waitlist promotion schedules;
- scheduling inside the HTTP server or every HTTP replica;
- a database table containing future cron fires;
- catch-up replay for every missed tick;
- `node-cron` distributed coordination or a Redis lock;
- repair writes inside reconciliation;
- full reindex on a timer;
- readiness failure when Elasticsearch or this optional scheduler is down.

`node-cron` is best-effort and keeps no durable schedule history. A stopped
process misses ticks. That is acceptable here because reconciliation is
repeatable, read-only, and safe to invoke later manually. It would not be
acceptable for permanent business work whose loss corrupts Gatherly.

## Reliability contract

Write these statements in your own words before coding:

| Question                                 | Gatherly answer                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| What owns durable event truth?           | PostgreSQL                                                                 |
| What does Elasticsearch own?             | A rebuildable discovery projection                                         |
| What does the scheduled job do?          | Compare eligible PostgreSQL events with indexed documents and report drift |
| Does it repair drift?                    | No; ordinary outbox/Kafka delivery or an explicit full reindex repairs it  |
| What happens when one tick is missed?    | A later tick or manual run performs the same comparison                    |
| What happens when two ticks race?        | One PostgreSQL session lock wins; the other records `skipped_locked`       |
| What happens when Elasticsearch is down? | The run fails; PostgreSQL-backed APIs and truth remain intact              |
| Does search affect general readiness?    | No                                                                         |

The lock is session-scoped. The same PostgreSQL connection must acquire the
lock, remain checked out for the entire operation, unlock in `finally`, and
only then return to its pool.

## Checkpoint 1: Record the baseline

### Reason

Phase 7 already contains the search comparison, advisory-lock helper, metrics,
structured logger, and one-shot worker. Replacing them with a second parallel
implementation would hide the reuse lesson and create divergent behavior.

### Inventory

Read these files before editing:

```text
src/modules/search/search-reconciler.ts
src/modules/search/event-search-source.repository.ts
src/infrastructure/postgres/advisory-lock.ts
src/infrastructure/observability/metrics.ts
src/infrastructure/observability/internal-metrics-server.ts
src/workers/search-reconcile.ts
src/config/search-reindex-env.ts
tests/unit/search-reconciler.test.ts
tests/unit/advisory-lock.test.ts
deploy/runbooks/search-drift.md
```

Run the baseline gates:

```bash
yarn typecheck
yarn lint
yarn test:unit
yarn build
```

Also run the manual comparison once with PostgreSQL and Elasticsearch
available:

```bash
yarn search:reconcile
```

Exit code `0` means no drift, `2` means the comparison completed and found
drift, and `1` means the operation failed. Preserve that useful distinction
when the one-shot worker is refactored.

### Exit evidence

- The baseline gates pass before the scheduler dependency is added.
- You can explain why `SearchReconciler` reads but does not repair.
- You can identify the exact advisory-lock name used by the manual worker.

## Checkpoint 2: Install node-cron with Yarn Classic

### Reason

Phase 8 is the first phase that needs this package. Install it now, with Yarn
Classic, and commit the authoritative `yarn.lock` change. `node-cron` ships its
own TypeScript declarations; do not install `@types/node-cron`.

### Implementation

```bash
yarn add node-cron@^4.6.0
```

Confirm the installed major and engine compatibility:

```bash
yarn why node-cron
node --version
```

`node-cron` accepts five fields with seconds defaulted to zero, or six fields
with an explicit leading seconds field. Gatherly's normal example uses five
fields:

```text
*/15 * * * *
```

That means every fifteen minutes at second zero. A six-field expression such
as `*/10 * * * * *` is useful only for a short local exercise; never leave it
as the deployed setting.

### Verification

```bash
yarn typecheck
yarn build
```

### Exit evidence

- `package.json` and `yarn.lock` contain `node-cron` 4.x.
- No npm or pnpm lockfile was created.
- No separate type package was added.

## Checkpoint 3: Validate scheduler configuration at startup

### Reason

An invalid expression must stop the process immediately instead of leaving a
healthy-looking container that never runs maintenance. The schedule is
configuration, but UTC is an architectural decision and remains explicit in
the scheduler code.

Add this block to `.env.example`:

```dotenv
# Phase 8 search reconciliation scheduler
# Quote cron expressions because deployed environment files are shell-compatible.
SEARCH_RECONCILIATION_CRON='*/15 * * * *'
SEARCH_RECONCILIATION_TIMEOUT_MS=120000
SCHEDULER_SHUTDOWN_TIMEOUT_MS=30000
SCHEDULER_METRICS_PORT=9466
```

Create `src/config/search-scheduler-env.ts` (**complete file**):

```ts
import { validate as validateCronExpression } from 'node-cron';
import { z } from 'zod';

import {
  parseSearchReindexEnvironment,
  type SearchReindexEnvironment,
} from './search-reindex-env.js';

const schedulerEnvironmentSchema = z.object({
  SEARCH_RECONCILIATION_CRON: z
    .string()
    .trim()
    .min(1)
    .default('*/15 * * * *')
    .refine(validateCronExpression, 'SEARCH_RECONCILIATION_CRON must be a valid cron expression'),
  SEARCH_RECONCILIATION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(30 * 60_000)
    .default(120_000),
  SCHEDULER_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(5 * 60_000)
    .default(30_000),
  SCHEDULER_METRICS_PORT: z.coerce.number().int().min(1_024).max(65_535).default(9_466),
});

type SchedulerEnvironment = z.infer<typeof schedulerEnvironmentSchema>;

export type SearchSchedulerEnvironment = SearchReindexEnvironment & SchedulerEnvironment;

export const parseSearchSchedulerEnvironment = (
  input: NodeJS.ProcessEnv,
): SearchSchedulerEnvironment => ({
  ...parseSearchReindexEnvironment(input),
  ...schedulerEnvironmentSchema.parse(input),
});
```

Create `tests/unit/search-scheduler-env.test.ts` (**complete file**):

```ts
import { describe, expect, it } from 'vitest';

import { parseSearchSchedulerEnvironment } from '../../src/config/search-scheduler-env.js';

const requiredEnvironment = {
  DATABASE_URL: 'postgresql://gatherly:password@127.0.0.1:5432/gatherly',
  ELASTICSEARCH_URL: 'http://127.0.0.1:9200',
};

describe('search scheduler environment', () => {
  it('supplies bounded defaults', () => {
    expect(parseSearchSchedulerEnvironment(requiredEnvironment)).toMatchObject({
      SEARCH_RECONCILIATION_CRON: '*/15 * * * *',
      SEARCH_RECONCILIATION_TIMEOUT_MS: 120_000,
      SCHEDULER_SHUTDOWN_TIMEOUT_MS: 30_000,
      SCHEDULER_METRICS_PORT: 9_466,
    });
  });

  it('accepts a six-field local exercise schedule', () => {
    expect(
      parseSearchSchedulerEnvironment({
        ...requiredEnvironment,
        SEARCH_RECONCILIATION_CRON: '*/10 * * * * *',
      }).SEARCH_RECONCILIATION_CRON,
    ).toBe('*/10 * * * * *');
  });

  it('rejects an invalid expression and unsafe timing bounds', () => {
    expect(() =>
      parseSearchSchedulerEnvironment({
        ...requiredEnvironment,
        SEARCH_RECONCILIATION_CRON: 'every lunchtime',
      }),
    ).toThrow('SEARCH_RECONCILIATION_CRON must be a valid cron expression');

    expect(() =>
      parseSearchSchedulerEnvironment({
        ...requiredEnvironment,
        SEARCH_RECONCILIATION_TIMEOUT_MS: '0',
      }),
    ).toThrow();
  });
});
```

### Verification

```bash
yarn test:unit -- tests/unit/search-scheduler-env.test.ts
yarn typecheck
```

Also prove startup validation manually after the scheduler entry point exists:

```powershell
$env:SEARCH_RECONCILIATION_CRON = 'invalid'
yarn search:scheduler
Remove-Item Env:SEARCH_RECONCILIATION_CRON
```

The process must exit before opening long-lived database, Elasticsearch, or
metrics resources.

### Exit evidence

- Invalid syntax fails startup with a Zod error.
- Timeouts and ports have explicit lower and upper bounds.
- The time zone is not host-dependent configuration.

## Checkpoint 4: Make reconciliation cooperatively cancellable

### Reason

Stopping future cron ticks is not enough. An in-flight comparison must notice a
timeout or shutdown request between pages, and Elasticsearch requests should
receive the abort signal directly. Prisma does not make every in-flight query
instantly cancellable, so keep its pool connection timeout bounded and check
the signal immediately before and after each database page.

The timeout is a cooperative application bound, not permission to abandon
client-level timeouts. Keep `ELASTICSEARCH_REQUEST_TIMEOUT_MS` and the Prisma
adapter's connection timeout shorter than the overall reconciliation timeout.

Update `EventSearchSourceRepository.iterateEligible` in
`src/modules/search/event-search-source.repository.ts` (**replacement
method**):

```ts
  public async *iterateEligible(
    batchSize = 500,
    signal?: AbortSignal,
  ): AsyncGenerator<EventSearchDocument> {
    let cursor: string | undefined;

    for (;;) {
      signal?.throwIfAborted();
      const records = await this.prisma.event.findMany({
        where: eligibleWhere,
        select: projectionSelection,
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });
      signal?.throwIfAborted();

      if (records.length === 0) return;
      for (const record of records) {
        signal?.throwIfAborted();
        yield mapProjection(record);
      }

      const [lastRecord] = records.slice(-1);
      if (lastRecord === undefined) return;
      cursor = lastRecord.id;
      if (records.length < batchSize) return;
    }
  }
```

Replace `src/modules/search/search-reconciler.ts` (**complete file**):

```ts
import type { Client, estypes } from '@elastic/elasticsearch';

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

  public async reconcile(signal?: AbortSignal): Promise<SearchReconciliationResult> {
    const eligible = new Map<string, string>();
    for await (const document of this.source.iterateEligible(500, signal)) {
      signal?.throwIfAborted();
      eligible.set(document.id, document.updatedAt);
    }

    const indexed = new Map<string, string>();
    let searchAfter: estypes.SortResults | undefined;

    for (;;) {
      signal?.throwIfAborted();
      const request = {
        index: EVENT_SEARCH_READ_ALIAS,
        size: 500,
        _source: ['id', 'updatedAt'],
        sort: [{ id: 'asc' }],
        ...(searchAfter === undefined ? {} : { search_after: searchAfter }),
      } satisfies estypes.SearchRequest;
      const response =
        signal === undefined
          ? await this.elasticsearch.search<IndexedVersion>(request)
          : await this.elasticsearch.search<IndexedVersion>(request, { signal });
      signal?.throwIfAborted();

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
      signal?.throwIfAborted();
      const indexedVersion = indexed.get(eventId);
      if (indexedVersion === undefined) missing += 1;
      else if (indexedVersion !== updatedAt) stale += 1;
    }

    let ineligible = 0;
    for (const eventId of indexed.keys()) {
      signal?.throwIfAborted();
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

The existing tests keep working because the signal is optional. Add this case
to `tests/unit/search-reconciler.test.ts` (**edit**):

```ts
it('stops before reading Elasticsearch when cancellation is already requested', async () => {
  const search = vi.fn();
  const controller = new AbortController();
  controller.abort(new Error('test cancellation'));
  const reconciler = new SearchReconciler(sourceRepository([]), {
    search,
  } as unknown as Client);

  await expect(reconciler.reconcile(controller.signal)).rejects.toThrow('test cancellation');
  expect(search).not.toHaveBeenCalled();
});
```

### Verification

```bash
yarn test:unit -- tests/unit/search-reconciler.test.ts
yarn typecheck
```

### Exit evidence

- Cancellation is checked between all paged operations and comparison loops.
- Elasticsearch receives the signal as a transport option, not in the query
  body.
- Existing callers compile without manufacturing an unused signal.

## Checkpoint 5: Extract one observable reconciliation job

### Reason

The cron callback, manual CLI, and tests need one implementation of timeout,
locking, metrics, logging, and result classification. The job below owns that
application orchestration while `SearchReconciler` remains the search-domain
comparison.

### Extend the metrics contract

Edit `src/infrastructure/observability/metrics.ts`.

Add these members to `ApplicationMetrics` (**edit**):

```ts
reconciliationRuns: Counter<'result'>;
reconciliationDuration: Histogram<'result'>;
reconciliationLastCompleted: Gauge;
```

Add these objects immediately after `reconciliationDrift` in the returned
object from `createApplicationMetrics` (**edit**):

```ts
    reconciliationRuns: new Counter({
      name: 'gatherly_search_reconciliation_runs_total',
      help: 'Search reconciliation runs by bounded outcome',
      labelNames: ['result'],
      registers,
    }),
    reconciliationDuration: new Histogram({
      name: 'gatherly_search_reconciliation_duration_seconds',
      help: 'Search reconciliation duration by bounded outcome',
      labelNames: ['result'],
      buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
      registers,
    }),
    reconciliationLastCompleted: new Gauge({
      name: 'gatherly_search_reconciliation_last_completed_timestamp_seconds',
      help: 'Unix time of the last completed search reconciliation comparison',
      registers,
    }),
```

The `result` label is restricted in code to six stable values. Never put an
error message, event ID, run ID, cron expression, or timestamp in a metric
label.

### Create the job

Create `src/workers/search-reconciliation-job.ts` (**complete file**):

```ts
import { performance } from 'node:perf_hooks';

import type { Logger } from 'pino';

import type { ApplicationMetrics } from '../infrastructure/observability/metrics.js';
import type {
  SearchReconciler,
  SearchReconciliationResult,
} from '../modules/search/search-reconciler.js';

export const SEARCH_RECONCILIATION_LOCK_NAME = 'gatherly:search-reconciliation';

type LockOutcome = { acquired: false } | { acquired: true; value: SearchReconciliationResult };

export type SearchReconciliationLock = (
  operation: () => Promise<SearchReconciliationResult>,
) => Promise<LockOutcome>;

type ReconciliationMetrics = Pick<
  ApplicationMetrics,
  | 'reconciliationDrift'
  | 'reconciliationRuns'
  | 'reconciliationDuration'
  | 'reconciliationLastCompleted'
>;

export interface SearchReconciliationRunInput {
  trigger: 'manual' | 'scheduled';
  runId: string;
  signal: AbortSignal;
  scheduledFor?: Date;
  triggeredAt?: Date;
}

export type SearchReconciliationRunOutcome =
  | {
      status: 'completed';
      drifted: boolean;
      result: SearchReconciliationResult;
      durationMs: number;
    }
  | { status: 'skipped_locked'; durationMs: number }
  | { status: 'cancelled'; reason: 'shutdown' | 'timeout'; durationMs: number };

interface SearchReconciliationJobDependencies {
  reconciler: Pick<SearchReconciler, 'reconcile'>;
  withLock: SearchReconciliationLock;
  metrics: ReconciliationMetrics;
  logger: Logger;
  timeoutMs: number;
}

type MetricResult =
  'completed_clean' | 'completed_drift' | 'skipped_locked' | 'cancelled' | 'timed_out' | 'failed';

export class SearchReconciliationJob {
  public constructor(private readonly dependencies: SearchReconciliationJobDependencies) {}

  public async run(input: SearchReconciliationRunInput): Promise<SearchReconciliationRunOutcome> {
    const started = performance.now();
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(new Error('Search reconciliation timed out'));
    }, this.dependencies.timeoutMs);
    timeout.unref();
    const signal = AbortSignal.any([input.signal, timeoutController.signal]);

    const durationMs = (): number => Math.round(performance.now() - started);
    const record = (result: MetricResult): number => {
      const elapsed = durationMs();
      this.dependencies.metrics.reconciliationRuns.inc({ result });
      this.dependencies.metrics.reconciliationDuration.observe({ result }, elapsed / 1_000);
      return elapsed;
    };

    this.dependencies.logger.info(
      {
        trigger: input.trigger,
        runId: input.runId,
        scheduledFor: input.scheduledFor?.toISOString(),
        triggeredAt: input.triggeredAt?.toISOString(),
        timeoutMs: this.dependencies.timeoutMs,
      },
      'Search reconciliation started',
    );

    try {
      const lockOutcome = await this.dependencies.withLock(() =>
        this.dependencies.reconciler.reconcile(signal),
      );

      if (!lockOutcome.acquired) {
        const elapsed = record('skipped_locked');
        this.dependencies.logger.info(
          { trigger: input.trigger, runId: input.runId, durationMs: elapsed },
          'Search reconciliation skipped because another run owns the lock',
        );
        return { status: 'skipped_locked', durationMs: elapsed };
      }

      const result = lockOutcome.value;
      const drifted = result.missing + result.stale + result.ineligible > 0;
      const metricResult: MetricResult = drifted ? 'completed_drift' : 'completed_clean';
      const elapsed = record(metricResult);

      this.dependencies.metrics.reconciliationDrift.set({ kind: 'missing' }, result.missing);
      this.dependencies.metrics.reconciliationDrift.set({ kind: 'stale' }, result.stale);
      this.dependencies.metrics.reconciliationDrift.set({ kind: 'ineligible' }, result.ineligible);
      this.dependencies.metrics.reconciliationLastCompleted.set(Date.now() / 1_000);

      this.dependencies.logger.info(
        {
          trigger: input.trigger,
          runId: input.runId,
          durationMs: elapsed,
          drifted,
          ...result,
        },
        'Search reconciliation completed',
      );

      return { status: 'completed', drifted, result, durationMs: elapsed };
    } catch (error) {
      if (signal.aborted) {
        const reason = input.signal.aborted ? 'shutdown' : 'timeout';
        const metricResult: MetricResult = reason === 'timeout' ? 'timed_out' : 'cancelled';
        const elapsed = record(metricResult);
        this.dependencies.logger.warn(
          { trigger: input.trigger, runId: input.runId, durationMs: elapsed, reason },
          'Search reconciliation cancelled',
        );
        return { status: 'cancelled', reason, durationMs: elapsed };
      }

      const elapsed = record('failed');
      this.dependencies.logger.error(
        { err: error, trigger: input.trigger, runId: input.runId, durationMs: elapsed },
        'Search reconciliation failed',
      );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

This job deliberately returns cancellation and lock contention as ordinary
outcomes. An unexpected PostgreSQL, Prisma, or Elasticsearch failure still
throws so node-cron's `execution:failed` event and the process logs can expose
it.

### Create the PostgreSQL lock adapter

Create `src/workers/search-reconciliation-lock.ts` (**complete file**):

```ts
import type { Pool } from 'pg';

import { withPostgresAdvisoryLock } from '../infrastructure/postgres/advisory-lock.js';
import type { SearchReconciliationLock } from './search-reconciliation-job.js';
import { SEARCH_RECONCILIATION_LOCK_NAME } from './search-reconciliation-job.js';

export const createSearchReconciliationLock =
  (pool: Pool): SearchReconciliationLock =>
  async (operation) => {
    const client = await pool.connect();
    try {
      return await withPostgresAdvisoryLock(client, SEARCH_RECONCILIATION_LOCK_NAME, operation);
    } finally {
      client.release();
    }
  };
```

Do not use `pool.query()` for this lock. A pool may use different sessions for
the lock, operation, and unlock. The checked-out client makes session ownership
explicit.

### Verification

```bash
yarn typecheck
yarn lint
```

### Exit evidence

- All triggers share one stable lock name.
- Lock contention does not emit an error.
- Unexpected dependency errors still reject.
- Metric labels are bounded.

## Checkpoint 6: Build the scheduler lifecycle around a testable callback

### Reason

`cron.schedule()` starts immediately, which can emit an event before listeners
are attached. `cron.createTask()` starts stopped, so Gatherly can attach
observability first and call `start()` last.

Use two overlap defenses for different scopes:

```text
node-cron noOverlap       one JavaScript process
PostgreSQL advisory lock  all scheduler/manual processes sharing the database
```

The local flag is a fast guard and produces an `execution:overlap` event. It is
not a replacement for the database lock.

Create `src/workers/search-reconciliation-scheduler.ts` (**complete file**):

```ts
import cron, { type ScheduledTask, type TaskContext } from 'node-cron';
import type { Logger } from 'pino';

import type { SearchReconciliationJob } from './search-reconciliation-job.js';

interface SchedulerDependencies {
  cronExpression: string;
  job: Pick<SearchReconciliationJob, 'run'>;
  logger: Logger;
}

export interface SchedulerShutdownResult {
  forced: boolean;
}

export interface SearchReconciliationScheduler {
  start: () => Promise<void>;
  shutdown: (timeoutMs: number) => Promise<SchedulerShutdownResult>;
  task: ScheduledTask;
}

export const createScheduledReconciliationHandler =
  (job: Pick<SearchReconciliationJob, 'run'>, signal: AbortSignal) =>
  async (context: TaskContext): Promise<void> => {
    if (signal.aborted) return;

    await job.run({
      trigger: 'scheduled',
      runId: context.execution?.id ?? context.triggeredAt.toISOString(),
      signal,
      scheduledFor: context.date,
      triggeredAt: context.triggeredAt,
    });
  };

export const createSearchReconciliationScheduler = (
  dependencies: SchedulerDependencies,
): SearchReconciliationScheduler => {
  const runController = new AbortController();
  const handler = createScheduledReconciliationHandler(dependencies.job, runController.signal);
  let activeRun: Promise<void> | undefined;
  let shutdownPromise: Promise<SchedulerShutdownResult> | undefined;

  const task = cron.createTask(
    dependencies.cronExpression,
    async (context) => {
      const run = handler(context);
      activeRun = run;
      try {
        await run;
      } finally {
        if (activeRun === run) activeRun = undefined;
      }
    },
    {
      name: 'search-projection-reconciliation',
      timezone: 'Etc/UTC',
      noOverlap: true,
    },
  );

  task.on('execution:missed', (context) => {
    dependencies.logger.warn(
      { scheduledFor: context.date.toISOString(), triggeredAt: context.triggeredAt.toISOString() },
      'Search reconciliation schedule was missed',
    );
  });

  task.on('execution:overlap', (context) => {
    dependencies.logger.info(
      { scheduledFor: context.date.toISOString() },
      'Search reconciliation tick skipped because the local task is still running',
    );
  });

  task.on('execution:failed', (context) => {
    dependencies.logger.error(
      { err: context.execution?.error, executionId: context.execution?.id },
      'Scheduled search reconciliation execution failed',
    );
  });

  return {
    task,
    start: async () => {
      await task.start();
      dependencies.logger.info(
        {
          cronExpression: dependencies.cronExpression,
          timezone: 'Etc/UTC',
          nextRun: task.getNextRun()?.toISOString(),
        },
        'Search reconciliation scheduler started',
      );
    },
    shutdown: (timeoutMs) => {
      if (shutdownPromise !== undefined) return shutdownPromise;

      shutdownPromise = (async () => {
        await task.stop();
        dependencies.logger.info(
          { timeoutMs, active: activeRun !== undefined },
          'Search reconciliation scheduler shutdown started',
        );

        let forced = false;
        if (activeRun !== undefined) {
          let timeout: NodeJS.Timeout | undefined;
          const finished = activeRun.then(
            () => true,
            () => true,
          );
          const deadline = new Promise<false>((resolve) => {
            timeout = setTimeout(() => {
              forced = true;
              runController.abort(new Error('Scheduler shutdown deadline exceeded'));
              resolve(false);
            }, timeoutMs);
          });

          await Promise.race([finished, deadline]);
          if (timeout !== undefined) clearTimeout(timeout);
        }

        await task.destroy();
        dependencies.logger.info({ forced }, 'Search reconciliation scheduler shutdown completed');
        return { forced };
      })();

      return shutdownPromise;
    },
  };
};
```

Stopping the task prevents future ticks. It does not kill an inline callback
already running. The scheduler therefore tracks that promise, waits up to the
configured shutdown bound, and then aborts the job's cooperative signal. The
entry point closes clients after this lifecycle returns, providing the final
process-level bound.

### Test the callback separately

Create `tests/unit/search-reconciliation-scheduler.test.ts` (**complete file**):

```ts
import type { TaskContext } from 'node-cron';
import { describe, expect, it, vi } from 'vitest';

import { createScheduledReconciliationHandler } from '../../src/workers/search-reconciliation-scheduler.js';

const context = {
  date: new Date('2026-08-16T12:15:00.000Z'),
  dateLocalIso: '2026-08-16T12:15:00.000Z',
  triggeredAt: new Date('2026-08-16T12:15:00.050Z'),
  execution: { id: 'execution-1', reason: 'scheduled' },
} as TaskContext;

describe('scheduled search reconciliation callback', () => {
  it('passes bounded schedule metadata and the process signal to the job', async () => {
    const controller = new AbortController();
    const run = vi.fn().mockResolvedValue({
      status: 'skipped_locked',
      durationMs: 2,
    });
    const handler = createScheduledReconciliationHandler({ run }, controller.signal);

    await handler(context);

    expect(run).toHaveBeenCalledWith({
      trigger: 'scheduled',
      runId: 'execution-1',
      signal: controller.signal,
      scheduledFor: context.date,
      triggeredAt: context.triggeredAt,
    });
  });

  it('does not begin new work after shutdown cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();
    const handler = createScheduledReconciliationHandler({ run }, controller.signal);

    await handler(context);

    expect(run).not.toHaveBeenCalled();
  });

  it('preserves an unexpected job failure for node-cron lifecycle events', async () => {
    const failure = new Error('Elasticsearch unavailable');
    const handler = createScheduledReconciliationHandler(
      { run: vi.fn().mockRejectedValue(failure) },
      new AbortController().signal,
    );

    await expect(handler(context)).rejects.toBe(failure);
  });
});
```

### Verification

```bash
yarn test:unit -- tests/unit/search-reconciliation-scheduler.test.ts
yarn typecheck
```

### Exit evidence

- Listeners are attached before `start()`.
- The schedule is explicitly `Etc/UTC`.
- The pure callback can be tested without waiting for wall-clock time.
- Callback failures are not swallowed.

## Checkpoint 7: Wire the dedicated process and preserve the manual command

### Reason

The scheduler needs the same application image but a distinct process entry
point. It opens only the dependencies its one use case needs. It does not open
an Express listener, Redis connection, Kafka consumer, SSE stream, or WebSocket
server.

### Create a composition helper

Create `src/workers/create-search-reconciliation-job.ts` (**complete file**):

```ts
import type { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import pg, { type Pool } from 'pg';
import type { Logger } from 'pino';

import type { SearchSchedulerEnvironment } from '../config/search-scheduler-env.js';
import type { ApplicationMetrics } from '../infrastructure/observability/metrics.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { EventSearchSourceRepository } from '../modules/search/event-search-source.repository.js';
import { SearchReconciler } from '../modules/search/search-reconciler.js';
import { SearchReconciliationJob } from './search-reconciliation-job.js';
import { createSearchReconciliationLock } from './search-reconciliation-lock.js';

export interface SearchReconciliationComposition {
  job: SearchReconciliationJob;
  lockPool: Pool;
}

export const createSearchReconciliationJob = (
  environment: SearchSchedulerEnvironment,
  prisma: PrismaClient,
  elasticsearch: ElasticsearchClient,
  metrics: ApplicationMetrics,
  logger: Logger,
): SearchReconciliationComposition => {
  const lockPool = new pg.Pool({
    connectionString: environment.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  const reconciler = new SearchReconciler(new EventSearchSourceRepository(prisma), elasticsearch);

  return {
    lockPool,
    job: new SearchReconciliationJob({
      reconciler,
      withLock: createSearchReconciliationLock(lockPool),
      metrics,
      logger,
      timeoutMs: environment.SEARCH_RECONCILIATION_TIMEOUT_MS,
    }),
  };
};
```

The lock pool maximum is two for connection recovery headroom, but each job
checks out only one connection and `noOverlap` prevents local concurrent jobs.
Include this pool when calculating the environment's total PostgreSQL
connection budget.

### Create the scheduler entry point

Create `src/workers/search-scheduler.ts` (**complete file**):

```ts
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { parseSearchSchedulerEnvironment } from '../config/search-scheduler-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { startInternalMetricsServer } from '../infrastructure/observability/internal-metrics-server.js';
import { createApplicationMetrics } from '../infrastructure/observability/metrics.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { shutdownTelemetry } from '../instrumentation.js';
import { createLogger } from '../shared/logging/logger.js';
import { createSearchReconciliationJob } from './create-search-reconciliation-job.js';
import { createSearchReconciliationScheduler } from './search-reconciliation-scheduler.js';

const logger = createLogger();
const environment = parseSearchSchedulerEnvironment(process.env);
const metrics = createApplicationMetrics();
const metricsServer = startInternalMetricsServer(
  metrics,
  environment.SCHEDULER_METRICS_PORT,
  logger,
);
const prisma = createPrismaClient(environment);
const elasticsearch = createElasticsearchClient(environment, logger);
const composition = createSearchReconciliationJob(
  environment,
  prisma,
  elasticsearch,
  metrics,
  logger,
);
const scheduler = createSearchReconciliationScheduler({
  cronExpression: environment.SEARCH_RECONCILIATION_CRON,
  job: composition.job,
  logger,
});

let resolveStopped!: () => void;
const stopped = new Promise<void>((resolve) => {
  resolveStopped = resolve;
});
let shutdownPromise: Promise<void> | undefined;

const requestShutdown = (signal: NodeJS.Signals): void => {
  if (shutdownPromise !== undefined) return;

  shutdownPromise = (async () => {
    try {
      logger.info({ signal }, 'Search scheduler shutdown requested');
      const result = await scheduler.shutdown(environment.SCHEDULER_SHUTDOWN_TIMEOUT_MS);
      if (result.forced) process.exitCode = 1;
    } catch (error) {
      logger.error({ err: error }, 'Search scheduler shutdown failed');
      process.exitCode = 1;
    } finally {
      resolveStopped();
    }
  })();
};

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

try {
  await scheduler.start();
  logger.info(
    { processRunId: randomUUID() },
    'Search scheduler process is accepting scheduled work',
  );
  await stopped;
} catch (error) {
  logger.error({ err: error }, 'Search scheduler stopped unexpectedly');
  process.exitCode = 1;
} finally {
  process.off('SIGINT', requestShutdown);
  process.off('SIGTERM', requestShutdown);
  await Promise.allSettled([
    composition.lockPool.end(),
    prisma.$disconnect(),
    closeElasticsearchClient(elasticsearch),
  ]);
  await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
  await shutdownTelemetry();
  logger.info('Search scheduler process stopped');
}
```

The startup parse happens before dependencies are constructed. The random
process run ID is safe cardinality in logs, never in metrics.

### Refactor the one-shot worker

Replace `src/workers/search-reconcile.ts` so it uses the same job (**complete
file**):

```ts
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { parseSearchSchedulerEnvironment } from '../config/search-scheduler-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { createApplicationMetrics } from '../infrastructure/observability/metrics.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { createLogger } from '../shared/logging/logger.js';
import { createSearchReconciliationJob } from './create-search-reconciliation-job.js';

const logger = createLogger();
const environment = parseSearchSchedulerEnvironment(process.env);
const metrics = createApplicationMetrics();
const prisma = createPrismaClient(environment);
const elasticsearch = createElasticsearchClient(environment, logger);
const composition = createSearchReconciliationJob(
  environment,
  prisma,
  elasticsearch,
  metrics,
  logger,
);
const controller = new AbortController();

const requestCancellation = (signal: NodeJS.Signals): void => {
  controller.abort(new Error(`Search reconciliation interrupted by ${signal}`));
};

process.once('SIGINT', requestCancellation);
process.once('SIGTERM', requestCancellation);

try {
  const outcome = await composition.job.run({
    trigger: 'manual',
    runId: randomUUID(),
    signal: controller.signal,
  });

  if (outcome.status === 'completed' && outcome.drifted) process.exitCode = 2;
  if (outcome.status === 'cancelled') process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  process.off('SIGINT', requestCancellation);
  process.off('SIGTERM', requestCancellation);
  await Promise.allSettled([
    composition.lockPool.end(),
    prisma.$disconnect(),
    closeElasticsearchClient(elasticsearch),
  ]);
}
```

A manual locked skip remains exit code `0`: another active run owns the work,
and no failure occurred. The structured log makes the skip visible.

### Add scripts

Add these `package.json` scripts (**edit**):

```json
"search:scheduler": "tsx --import ./src/instrumentation.ts src/workers/search-scheduler.ts",
"search:scheduler:prod": "node --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import ./dist/instrumentation.js dist/workers/search-scheduler.js"
```

Keep the existing `search:reconcile` and `search:reconcile:prod` scripts.
Once the files and scripts exist, add these entries to README's available
scripts and list `node-cron` as an active scheduled-maintenance dependency:

```text
yarn search:scheduler       Run the dedicated scheduler from TypeScript
yarn search:scheduler:prod  Run the compiled scheduler with instrumentation
```

### Verification

```bash
yarn typecheck
yarn lint
yarn build
```

### Exit evidence

- Scheduler and manual command compose the same job.
- The scheduler entry point imports no Express, Redis, Kafka, SSE, or WebSocket
  runtime.
- Both development and production scripts initialize instrumentation before
  worker imports.

## Checkpoint 8: Prove job outcomes and cross-process exclusion

### Unit-test the job

Create `tests/unit/search-reconciliation-job.test.ts` (**complete file**):

```ts
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { createApplicationMetrics } from '../../src/infrastructure/observability/metrics.js';
import { SearchReconciliationJob } from '../../src/workers/search-reconciliation-job.js';

const cleanResult = {
  eligible: 3,
  indexed: 3,
  missing: 0,
  stale: 0,
  ineligible: 0,
};

const logger = (): Logger =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger;

describe('SearchReconciliationJob', () => {
  it('records a clean completed comparison', async () => {
    const reconcile = vi.fn().mockResolvedValue(cleanResult);
    const metrics = createApplicationMetrics();
    const job = new SearchReconciliationJob({
      reconciler: { reconcile },
      withLock: async (operation) => ({ acquired: true, value: await operation() }),
      metrics,
      logger: logger(),
      timeoutMs: 1_000,
    });

    const outcome = await job.run({
      trigger: 'manual',
      runId: 'run-1',
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({ status: 'completed', drifted: false, result: cleanResult });
    const body = await metrics.registry.metrics();
    expect(body).toContain('result="completed_clean"');
    expect(body).toContain('gatherly_search_reconciliation_last_completed_timestamp_seconds');
  });

  it('records a completed comparison that found drift', async () => {
    const driftedResult = { ...cleanResult, indexed: 2, missing: 1 };
    const metrics = createApplicationMetrics();
    const job = new SearchReconciliationJob({
      reconciler: { reconcile: vi.fn().mockResolvedValue(driftedResult) },
      withLock: async (operation) => ({ acquired: true, value: await operation() }),
      metrics,
      logger: logger(),
      timeoutMs: 1_000,
    });

    await expect(
      job.run({
        trigger: 'scheduled',
        runId: 'run-drift',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 'completed', drifted: true, result: driftedResult });

    const body = await metrics.registry.metrics();
    expect(body).toContain('result="completed_drift"');
    expect(body).toMatch(/gatherly_search_reconciliation_drift\{kind="missing"[^}]*\} 1/);
  });

  it('treats lock contention as an expected skip', async () => {
    const reconcile = vi.fn();
    const metrics = createApplicationMetrics();
    const job = new SearchReconciliationJob({
      reconciler: { reconcile },
      withLock: vi.fn().mockResolvedValue({ acquired: false }),
      metrics,
      logger: logger(),
      timeoutMs: 1_000,
    });

    await expect(
      job.run({
        trigger: 'scheduled',
        runId: 'run-2',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 'skipped_locked' });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('requests cancellation when the run reaches its timeout', async () => {
    const job = new SearchReconciliationJob({
      reconciler: {
        reconcile: (signal) =>
          new Promise<typeof cleanResult>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                const reason = signal.reason as unknown;
                reject(reason instanceof Error ? reason : new Error('Reconciliation aborted'));
              },
              { once: true },
            );
          }),
      },
      withLock: async (operation) => ({ acquired: true, value: await operation() }),
      metrics: createApplicationMetrics(),
      logger: logger(),
      timeoutMs: 5,
    });

    await expect(
      job.run({
        trigger: 'scheduled',
        runId: 'run-3',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 'cancelled', reason: 'timeout' });
  });

  it('classifies process cancellation separately from a run timeout', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutdown requested'));
    const job = new SearchReconciliationJob({
      reconciler: {
        reconcile: (signal) => {
          signal?.throwIfAborted();
          return Promise.resolve(cleanResult);
        },
      },
      withLock: async (operation) => ({ acquired: true, value: await operation() }),
      metrics: createApplicationMetrics(),
      logger: logger(),
      timeoutMs: 1_000,
    });

    await expect(
      job.run({
        trigger: 'scheduled',
        runId: 'run-shutdown',
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ status: 'cancelled', reason: 'shutdown' });
  });

  it('preserves an unexpected dependency error', async () => {
    const failure = new Error('PostgreSQL unavailable');
    const job = new SearchReconciliationJob({
      reconciler: { reconcile: vi.fn() },
      withLock: vi.fn().mockRejectedValue(failure),
      metrics: createApplicationMetrics(),
      logger: logger(),
      timeoutMs: 1_000,
    });

    await expect(
      job.run({
        trigger: 'manual',
        runId: 'run-4',
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure);
  });
});
```

The production environment schema intentionally rejects a 5 ms timeout. The
unit test constructs the job directly so it can prove timeout behavior quickly.

### Integration-test the PostgreSQL lock

Create `tests/integration/search-scheduler-lock.integration.test.ts`
(**complete file**):

```ts
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApplicationMetrics } from '../../src/infrastructure/observability/metrics.js';
import { SearchReconciliationJob } from '../../src/workers/search-reconciliation-job.js';
import { createSearchReconciliationLock } from '../../src/workers/search-reconciliation-lock.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';

const cleanResult = {
  eligible: 0,
  indexed: 0,
  missing: 0,
  stale: 0,
  ineligible: 0,
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('search scheduler advisory lock', { concurrent: false }, () => {
  let postgres: PostgresHarness;

  beforeAll(async () => {
    postgres = await startPostgresHarness();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  it('allows only one process-like runner into reconciliation', async () => {
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const firstReconcile = vi.fn(async () => {
      firstEntered();
      await holdFirst;
      return cleanResult;
    });
    const secondReconcile = vi.fn().mockResolvedValue(cleanResult);
    const common = {
      withLock: createSearchReconciliationLock(postgres.pool),
      metrics: createApplicationMetrics(),
      logger: logger as unknown as Logger,
      timeoutMs: 10_000,
    };
    const firstJob = new SearchReconciliationJob({
      ...common,
      reconciler: { reconcile: firstReconcile },
    });
    const secondJob = new SearchReconciliationJob({
      ...common,
      metrics: createApplicationMetrics(),
      reconciler: { reconcile: secondReconcile },
    });

    const firstRun = firstJob.run({
      trigger: 'scheduled',
      runId: 'scheduler-a',
      signal: new AbortController().signal,
    });
    await firstHasLock;

    try {
      await expect(
        secondJob.run({
          trigger: 'scheduled',
          runId: 'scheduler-b',
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ status: 'skipped_locked' });
      expect(secondReconcile).not.toHaveBeenCalled();
    } finally {
      releaseFirst();
    }

    await expect(firstRun).resolves.toMatchObject({ status: 'completed' });
    expect(firstReconcile).toHaveBeenCalledOnce();
  });
});
```

This is the important concurrency proof. A mocked lock unit test cannot prove
that two real PostgreSQL sessions exclude each other.

### Verification

```bash
yarn test:unit -- tests/unit/search-reconciliation-job.test.ts tests/unit/search-reconciliation-scheduler.test.ts
yarn test:integration -- tests/integration/search-scheduler-lock.integration.test.ts
yarn test
```

### Exit evidence

- The callback test does not wait for real clock time.
- Timeout, lock skip, success, drift, and failure have stable classifications.
- Two real PostgreSQL sessions cannot enter the protected operation together.

## Checkpoint 9: Run the scheduler as its own Compose role

### Reason

The scheduler comes from the same modular-monolith image, but it must not run
inside each API replica. A named Compose service makes the role visible and
allows it to be deployed, restarted, observed, and stopped independently.

### Local production-style Compose service

Add this service to `compose.yaml` beside the other worker roles (**edit**):

```yaml
search-scheduler:
  build:
    context: .
    dockerfile: Dockerfile
    target: runtime
  command: yarn search:scheduler:prod
  environment:
    NODE_ENV: production
    DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
    PRISMA_POOL_MAX: ${PRISMA_POOL_MAX:-5}
    ELASTICSEARCH_URL: http://elasticsearch:9200
    ELASTICSEARCH_REQUEST_TIMEOUT_MS: ${ELASTICSEARCH_REQUEST_TIMEOUT_MS:-2000}
    ELASTICSEARCH_INDEX_PREFIX: ${ELASTICSEARCH_INDEX_PREFIX:-gatherly-events}
      SEARCH_RECONCILIATION_CRON: '${SEARCH_RECONCILIATION_CRON:-*/15 * * * *}'
    SEARCH_RECONCILIATION_TIMEOUT_MS: ${SEARCH_RECONCILIATION_TIMEOUT_MS:-120000}
    SCHEDULER_SHUTDOWN_TIMEOUT_MS: ${SCHEDULER_SHUTDOWN_TIMEOUT_MS:-30000}
    SCHEDULER_METRICS_PORT: 9466
    OTEL_SERVICE_NAME: gatherly-search-scheduler
  depends_on:
    migration:
      condition: service_completed_successfully
    elasticsearch:
      condition: service_healthy
  restart: unless-stopped
  init: true
  stop_grace_period: 35s
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

`stop_grace_period` is slightly longer than the application shutdown bound so
Docker does not send `SIGKILL` before the scheduler has a chance to finish its
own cleanup.

### Development override

Add this service override to `compose.dev.yaml` only if you want the scheduler
to reload from source during the exercise (**edit**):

```yaml
search-scheduler:
  build:
    target: development
  environment:
    NODE_ENV: development
  command: yarn search:scheduler
  volumes:
    - ./src:/app/src:ro
    - ./tests:/app/tests:ro
    - ./tsconfig.json:/app/tsconfig.json:ro
    - ./tsconfig.build.json:/app/tsconfig.build.json:ro
    - ./vitest.config.ts:/app/vitest.config.ts:ro
    - ./prisma:/app/prisma:ro
    - ./prisma.config.ts:/app/prisma.config.ts:ro
```

### Production overlay

Add this service to `deploy/compose.production.yaml` (**edit**):

```yaml
search-scheduler:
  image: ${APP_IMAGE:?APP_IMAGE must be an immutable digest reference}
  pull_policy: never
  command: yarn search:scheduler:prod
  env_file:
    - .env.production
  environment:
    DEPLOYMENT_ENVIRONMENT: ${DEPLOYMENT_ENVIRONMENT:-production}
    APP_REVISION: ${APP_REVISION:?set APP_REVISION}
    APP_IMAGE_DIGEST: ${APP_IMAGE_DIGEST:?set APP_IMAGE_DIGEST}
    OTEL_SERVICE_NAME: gatherly-search-scheduler
    SCHEDULER_METRICS_PORT: 9466
  init: true
  read_only: true
  tmpfs:
    - /tmp:size=32m,mode=1777
  restart: unless-stopped
  stop_grace_period: 35s
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL
  pids_limit: 100
  mem_limit: 384m
  logging:
    driver: json-file
    options:
      max-size: 10m
      max-file: '5'
```

Use exactly one intended scheduler service. The advisory lock makes accidental
duplicates safe, but duplication should be observable and corrected rather
than treated as normal topology.

### Observability overlay

Add this block to `compose.observability.yaml` (**edit**):

```yaml
search-scheduler:
  environment:
    OTEL_SDK_DISABLED: 'false'
    OTEL_SERVICE_NAME: gatherly-search-scheduler
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
  depends_on:
    otel-collector:
      condition: service_started
```

Add the scheduler target to `deploy/observability/prometheus.yaml` (**edit**):

```yaml
- job_name: gatherly-workers
  metrics_path: /metrics
  static_configs:
    - targets:
        - outbox-publisher:9464
        - search-consumer:9465
        - search-scheduler:9466
```

Do not publish port 9466 to the public host or proxy it through Nginx.

### Validate Compose

```bash
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose -f compose.yaml -f compose.observability.yaml config --quiet
docker compose -f compose.yaml -f deploy/compose.production.yaml config --quiet
```

### Exit evidence

- The HTTP API contains no scheduler import.
- The scheduler uses the runtime image and its own command.
- Production has one intended long-running scheduler role.
- Metrics remain private.

## Checkpoint 10: Add alerts and a recovery runbook

### Reason

A cron container can be running while its task is invalid, continually locked,
timing out, or failing. Container state alone is not enough. Observe outcomes
and recency.

Add these rules under the existing `gatherly-async` group in
`deploy/observability/alerts/gatherly.rules.yaml` (**edit**):

```yaml
- alert: GatherlySearchReconciliationNotCompleting
  expr: |
    absent(gatherly_search_reconciliation_last_completed_timestamp_seconds)
    or
    time() - gatherly_search_reconciliation_last_completed_timestamp_seconds > 1800
  for: 30m
  labels:
    severity: warning
    service: gatherly-search-scheduler
  annotations:
    summary: Scheduled search reconciliation has not completed recently
    impact: Search drift may remain undetected.
    runbook: deploy/runbooks/search-drift.md

- alert: GatherlySearchReconciliationFailing
  expr: |
    increase(gatherly_search_reconciliation_runs_total{result=~"failed|timed_out"}[30m]) > 0
  for: 5m
  labels:
    severity: warning
    service: gatherly-search-scheduler
  annotations:
    summary: Search reconciliation is failing or timing out
    impact: Elasticsearch drift detection is degraded; PostgreSQL APIs remain authoritative.
    runbook: deploy/runbooks/search-drift.md
```

The 30-minute recency threshold is twice the default 15-minute interval. If the
cron expression changes, update this alert deliberately; Prometheus cannot
infer an arbitrary cron interval from a string.

Extend `deploy/runbooks/search-drift.md` with this scheduler section (**edit**):

```md
## Scheduler checks

1. Confirm exactly one intended `search-scheduler` container is running.
2. Inspect `gatherly_search_reconciliation_runs_total` by bounded result.
3. Inspect the last-completed timestamp and duration histogram.
4. Look for `execution:missed`, local `execution:overlap`, PostgreSQL
   `skipped_locked`, timeout, and dependency-failure logs.
5. Verify PostgreSQL and Elasticsearch connectivity without printing URLs,
   credentials, API keys, or event documents.
6. Run `yarn search:reconcile:prod` manually from the same immutable image.

A missed tick is not replayed. Restore the scheduler and allow the next tick,
or run the same idempotent comparison manually. Do not schedule a full reindex.
Use the existing confirmed-drift recovery sequence below.
```

Useful starter PromQL:

```promql
sum by (result) (increase(gatherly_search_reconciliation_runs_total[1h]))
histogram_quantile(0.95, sum by (le) (rate(gatherly_search_reconciliation_duration_seconds_bucket[1h])))
time() - gatherly_search_reconciliation_last_completed_timestamp_seconds
sum by (kind) (gatherly_search_reconciliation_drift)
```

### Exit evidence

- A clean run, drifted run, lock skip, cancellation, timeout, and failure are
  distinguishable.
- Alerts point to a checked-in runbook.
- The runbook never suggests making Elasticsearch authoritative.

## Checkpoint 11: Perform the manual runtime drills

Automated tests prove deterministic branches. These drills prove process and
container behavior.

### Fast local schedule

Temporarily use a six-field expression:

```powershell
$env:SEARCH_RECONCILIATION_CRON = '*/10 * * * * *'
yarn search:scheduler
```

Observe at least two runs. Each log should include trigger, run ID, duration,
and safe counts. Stop with Ctrl+C and confirm the process exits within the
shutdown bound. Then remove the override:

```powershell
Remove-Item Env:SEARCH_RECONCILIATION_CRON
```

### Cross-process lock drill

1. Start the fast scheduler.
2. While it is reconciling, run `yarn search:reconcile` in another terminal.
3. Confirm at most one process enters `SearchReconciler`.
4. Confirm the loser logs `skipped_locked` and does not fail.

If the dataset is too small to overlap naturally, rely on the deterministic
integration test rather than adding sleeps to production code.

### Elasticsearch outage drill

1. Keep PostgreSQL running.
2. Stop only Elasticsearch.
3. Wait for or manually invoke one reconciliation.
4. Confirm a failure outcome and safe error log.
5. Confirm PostgreSQL-backed API readiness and data remain unchanged.
6. Restart Elasticsearch and confirm a later comparison succeeds.

### Missed-tick drill

1. Stop the scheduler for longer than one fast local interval.
2. Start it again.
3. Confirm it resumes future ticks without inventing replayed fires.
4. Run the manual command if immediate comparison is desired.

### Graceful-shutdown drill

1. Begin a reconciliation against a realistic seeded dataset.
2. Send `SIGTERM` or stop the Compose service.
3. Confirm new ticks are disabled immediately.
4. Confirm the active run finishes, or is cancelled at the configured bound.
5. Confirm the PostgreSQL lock is available to a later run.

### Full gate

```bash
yarn format:check
yarn typecheck
yarn lint
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

## Suggested commit sequence

Keep review units small enough to reason about:

```text
1. docs: define Phase 8 node-cron reliability contract
2. config: add node-cron and validate scheduler environment
3. search: make reconciliation cooperatively cancellable
4. scheduler: extract observable locked reconciliation job
5. scheduler: add UTC node-cron lifecycle and dedicated worker
6. tests: prove callback, timeout outcomes, and PostgreSQL lock exclusion
7. ops: add scheduler Compose role, metrics scrape, alerts, and runbook
8. docs: update README commands and Phase 8 status
```

## Common wrong turns

```text
cron.schedule(...) in src/server.ts
  -> every HTTP replica creates its own timer

noOverlap: true with no PostgreSQL lock
  -> protects one JavaScript process only

advisory lock through pool.query()
  -> acquire and unlock may run on different database sessions

full reindex every fifteen minutes
  -> expensive repair becomes routine synchronization

cron callback contains Elasticsearch comparison code
  -> manual and scheduled behavior diverge and tests couple to time

catch every error and return success
  -> execution failures disappear from node-cron lifecycle signals

unbounded shutdown await
  -> deployment can hang forever

immediate process.exit()
  -> lock/client cleanup and telemetry flushing are skipped

dynamic metric labels such as runId or error.message
  -> cardinality grows without a bound

search failure added to /health/ready
  -> optional discovery outage removes healthy PostgreSQL APIs from service

cron used for reservations or waitlist promotion
  -> best-effort timer becomes owner of permanent business work
```

## Completion checklist

Phase 8's node-cron increment is complete when you can answer all of these
without guessing:

- Why is the scheduler a separate process rather than an API-server import?
- Why are both `noOverlap` and a PostgreSQL advisory lock present?
- Why must the advisory lock hold one checked-out PostgreSQL session?
- What happens to a tick missed while the process is stopped?
- Why is `Etc/UTC` explicit even when hosts are configured for UTC?
- Which operations observe an `AbortSignal`, and which underlying client
  timeout still bounds an in-flight call?
- Which outcomes throw and which are ordinary results?
- How can an operator run the exact same job immediately?
- Why does drift detection not repair or reindex automatically?
- Why does a search scheduler outage not fail general readiness?
- Which metrics prove recent completion, duration, drift, and lock contention?
- Which integration test uses two real PostgreSQL sessions?
- How does Docker's stop grace period relate to the application shutdown
  timeout?
- Why is BullMQ still absent?

Only after this checklist and the full quality gate pass should Phase 8 move to
its separate BullMQ/full-reindex increment.
