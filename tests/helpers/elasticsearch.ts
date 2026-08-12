import { randomUUID } from 'node:crypto';

import { Client, errors } from '@elastic/elasticsearch';
import {
  ElasticsearchContainer,
  type StartedElasticsearchContainer,
} from '@testcontainers/elasticsearch';

export interface ElasticsearchHarness {
  client: Client;
  indexPrefix: string;
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

const listTestIndices = async (client: Client, indexPrefix: string): Promise<string[]> => {
  try {
    const indices = await client.indices.get({
      index: `${indexPrefix}-v*`,
      allow_no_indices: true,
      expand_wildcards: 'all',
    });
    return Object.keys(indices);
  } catch (error) {
    if (error instanceof errors.ResponseError && error.statusCode === 404) return [];
    throw error;
  }
};

export const startElasticsearchHarness = async (): Promise<ElasticsearchHarness> => {
  const container: StartedElasticsearchContainer = await new ElasticsearchContainer(
    'docker.elastic.co/elasticsearch/elasticsearch:9.4.3',
  )
    .withPassword('test-only-elasticsearch-password')
    .start();
  const client = new Client({
    node: container.getHttpUrl(),
    auth: {
      username: container.getUsername(),
      password: container.getPassword(),
    },
  });
  const indexPrefix = `gatherly-events-test-${randomUUID()}`;

  return {
    client,
    indexPrefix,
    reset: async () => {
      const indices = await listTestIndices(client, indexPrefix);
      for (const index of indices) await client.indices.delete({ index });
    },
    stop: async () => {
      await client.close();
      await container.stop();
    },
  };
};
