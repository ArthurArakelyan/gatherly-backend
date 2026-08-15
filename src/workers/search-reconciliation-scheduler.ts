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
