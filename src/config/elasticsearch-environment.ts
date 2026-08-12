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
