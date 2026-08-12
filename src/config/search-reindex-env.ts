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
