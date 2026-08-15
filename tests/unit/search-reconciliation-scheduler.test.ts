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
