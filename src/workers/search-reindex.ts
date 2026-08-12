import 'dotenv/config';

import pino from 'pino';

import { parseSearchReindexEnvironment } from '../config/search-reindex-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { EventSearchIndex } from '../infrastructure/elasticsearch/event-search-index.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { EventSearchSourceRepository } from '../modules/search/event-search-source.repository.js';

const logger = pino();
const searchReindexEnvironment = parseSearchReindexEnvironment(process.env);
const prisma = createPrismaClient(searchReindexEnvironment);
const elasticsearch = createElasticsearchClient(searchReindexEnvironment, logger);

try {
  const source = new EventSearchSourceRepository(prisma);
  const index = new EventSearchIndex(
    elasticsearch,
    searchReindexEnvironment.ELASTICSEARCH_INDEX_PREFIX,
    logger,
  );
  const result = await index.rebuild(source);
  logger.info(result, 'Event search reindex completed');
} catch (error) {
  logger.error({ err: error }, 'Event search reindex failed');
  process.exitCode = 1;
} finally {
  await Promise.all([prisma.$disconnect(), closeElasticsearchClient(elasticsearch)]);
}
