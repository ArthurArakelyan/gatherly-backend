import { errors, type Client, type estypes } from '@elastic/elasticsearch';
import type { Logger } from 'pino';

import type { EventSearchSourceRepository } from '../../modules/search/event-search-source.repository.js';
import type { EventSearchDocument } from '../../modules/search/search.types.js';
import {
  createEventIndexName,
  EVENT_SEARCH_READ_ALIAS,
  EVENT_SEARCH_WRITE_ALIAS,
  eventIndexDefinition,
} from './event-index-definition.js';

interface ReindexResult {
  index: string;
  previousIndices: string[];
  indexedDocuments: number;
}

const aliasIndices = async (client: Client, alias: string): Promise<string[]> => {
  try {
    const response = await client.indices.getAlias({ name: alias });
    return Object.keys(response);
  } catch (error) {
    if (error instanceof errors.ResponseError && error.statusCode === 404) return [];
    throw error;
  }
};

export class EventSearchIndex {
  public constructor(
    private readonly client: Client,
    private readonly indexPrefix: string,
    private readonly logger: Logger,
  ) {}

  public async index(document: EventSearchDocument): Promise<void> {
    await this.client.index({
      index: EVENT_SEARCH_WRITE_ALIAS,
      id: document.id,
      document,
    });
  }

  public async delete(eventId: string): Promise<void> {
    try {
      await this.client.delete({ index: EVENT_SEARCH_WRITE_ALIAS, id: eventId });
    } catch (error) {
      if (error instanceof errors.ResponseError && error.statusCode === 404) return;
      throw error;
    }
  }

  public async rebuild(source: EventSearchSourceRepository): Promise<ReindexResult> {
    const index = createEventIndexName(this.indexPrefix);
    const expectedCount = await source.countEligible();

    await this.client.indices.create({
      index,
      settings: eventIndexDefinition.settings,
      mappings: eventIndexDefinition.mappings,
    });

    this.logger.info({ index, expectedCount }, 'Created Elasticsearch rebuild target');

    const dropped: string[] = [];
    const result = await this.client.helpers.bulk<EventSearchDocument>({
      datasource: source.iterateEligible(),
      concurrency: 2,
      flushBytes: 1_000_000,
      retries: 3,
      onDocument: (document) => ({ index: { _index: index, _id: document.id } }),
      onDrop: ({ document, error }) => {
        dropped.push(document.id);
        this.logger.error({ eventId: document.id, error }, 'Dropped search projection');
      },
    });

    if (result.failed > 0 || dropped.length > 0) {
      throw new Error(`Search rebuild dropped ${String(result.failed)} documents`);
    }

    await this.client.indices.refresh({ index });
    const actualCount = (await this.client.count({ index })).count;

    if (actualCount !== expectedCount) {
      throw new Error(
        `Search rebuild count mismatch: PostgreSQL=${String(expectedCount)}, Elasticsearch=${String(actualCount)}`,
      );
    }

    const [oldReadIndices, oldWriteIndices] = await Promise.all([
      aliasIndices(this.client, EVENT_SEARCH_READ_ALIAS),
      aliasIndices(this.client, EVENT_SEARCH_WRITE_ALIAS),
    ]);
    const previousIndices = [...new Set([...oldReadIndices, ...oldWriteIndices])];

    const actions: estypes.IndicesUpdateAliasesAction[] = [
      ...oldReadIndices.map((oldIndex) => ({
        remove: { index: oldIndex, alias: EVENT_SEARCH_READ_ALIAS },
      })),
      ...oldWriteIndices.map((oldIndex) => ({
        remove: { index: oldIndex, alias: EVENT_SEARCH_WRITE_ALIAS },
      })),
      { add: { index, alias: EVENT_SEARCH_READ_ALIAS } },
      { add: { index, alias: EVENT_SEARCH_WRITE_ALIAS, is_write_index: true } },
    ];

    await this.client.indices.updateAliases({ actions });

    this.logger.info(
      { index, previousIndices, indexedDocuments: actualCount },
      'Elasticsearch aliases moved to rebuilt event index',
    );

    return { index, previousIndices, indexedDocuments: actualCount };
  }
}
