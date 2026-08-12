import { Client } from '@elastic/elasticsearch';
import type { Logger } from 'pino';

interface ElasticsearchConfiguration {
  ELASTICSEARCH_URL: string;
  ELASTICSEARCH_API_KEY: string | undefined;
  ELASTICSEARCH_REQUEST_TIMEOUT_MS: number;
}

export const createElasticsearchClient = (
  configuration: ElasticsearchConfiguration,
  logger: Logger,
): Client => {
  const client = new Client({
    node: configuration.ELASTICSEARCH_URL,
    requestTimeout: configuration.ELASTICSEARCH_REQUEST_TIMEOUT_MS,
    maxRetries: 2,
    ...(configuration.ELASTICSEARCH_API_KEY === undefined
      ? {}
      : { auth: { apiKey: configuration.ELASTICSEARCH_API_KEY } }),
  });

  client.diagnostic.on('request', (_error, event) => {
    if (event === null) return;
    logger.debug(
      { method: event.meta.request.params.method, path: event.meta.request.params.path },
      'Elasticsearch request',
    );
  });

  client.diagnostic.on('response', (error, event) => {
    if (error === null || event === null) return;
    logger.warn(
      {
        err: error,
        method: event.meta.request.params.method,
        path: event.meta.request.params.path,
      },
      'Elasticsearch request failed',
    );
  });

  return client;
};

export const closeElasticsearchClient = async (client: Client): Promise<void> => {
  await client.close();
};
