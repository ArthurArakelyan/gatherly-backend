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
