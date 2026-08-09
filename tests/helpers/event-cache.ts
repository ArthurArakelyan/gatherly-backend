import { vi, type Mocked } from 'vitest';

import type { EventCache } from '../../src/modules/events/events.cache.js';

export const createEventCacheMock = (): Mocked<EventCache> => ({
  get: vi.fn<EventCache['get']>().mockResolvedValue(null),
  set: vi.fn<EventCache['set']>().mockResolvedValue(undefined),
  delete: vi.fn<EventCache['delete']>().mockResolvedValue(undefined),
});
