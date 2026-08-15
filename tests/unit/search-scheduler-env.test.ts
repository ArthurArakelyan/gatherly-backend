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
