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
