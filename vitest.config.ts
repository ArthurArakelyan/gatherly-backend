import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // Integration files each start disposable infrastructure. Keeping the
    // worker count below the host CPU count prevents Docker from running a
    // dozen PostgreSQL/Kafka/Elasticsearch containers at the same time.
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
});
