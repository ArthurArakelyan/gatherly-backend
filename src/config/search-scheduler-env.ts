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
