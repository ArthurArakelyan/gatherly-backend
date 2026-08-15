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
