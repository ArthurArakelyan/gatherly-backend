import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // Integration files each start disposable infrastructure. Keeping the
    // Keep infrastructure-heavy suites below the host CPU count. More than two
    // concurrent files can start enough PostgreSQL/Kafka/Elasticsearch
    // containers for Kafka startup to become flaky on ordinary CI runners.
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
});
