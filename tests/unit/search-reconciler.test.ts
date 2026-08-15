import type { Client } from '@elastic/elasticsearch';
import { describe, expect, it, vi } from 'vitest';

import { EVENT_SEARCH_READ_ALIAS } from '../../src/infrastructure/elasticsearch/event-index-definition.js';
import type { EventSearchSourceRepository } from '../../src/modules/search/event-search-source.repository.js';
import { SearchReconciler } from '../../src/modules/search/search-reconciler.js';

interface SourceDocument {
  id: string;
  updatedAt: string;
}

const sourceRepository = (documents: SourceDocument[]): EventSearchSourceRepository =>
  ({
    iterateEligible: () =>
      (async function* () {
        await Promise.resolve();
        yield* documents;
      })(),
  }) as unknown as EventSearchSourceRepository;

describe('SearchReconciler', () => {
  it('counts missing, stale, and ineligible search documents without changing either store', async () => {
    const search = vi.fn().mockResolvedValue({
      hits: {
        hits: [
          { _source: { id: 'event-current', updatedAt: '2026-08-15T10:00:00.000Z' } },
          { _source: { id: 'event-stale', updatedAt: '2026-08-14T10:00:00.000Z' } },
          { _source: { id: 'event-ineligible', updatedAt: '2026-08-15T10:00:00.000Z' } },
        ],
      },
    });
    const reconciler = new SearchReconciler(
      sourceRepository([
        { id: 'event-current', updatedAt: '2026-08-15T10:00:00.000Z' },
        { id: 'event-stale', updatedAt: '2026-08-15T10:00:00.000Z' },
        { id: 'event-missing', updatedAt: '2026-08-15T10:00:00.000Z' },
      ]),
      { search } as unknown as Client,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({
      eligible: 3,
      indexed: 3,
      missing: 1,
      stale: 1,
      ineligible: 1,
    });
    expect(search).toHaveBeenCalledWith({
      index: EVENT_SEARCH_READ_ALIAS,
      size: 500,
      _source: ['id', 'updatedAt'],
      sort: [{ id: 'asc' }],
    });
  });

  it('paginates with the final hit sort value', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      _source: {
        id: `event-${String(index).padStart(3, '0')}`,
        updatedAt: '2026-08-15T10:00:00.000Z',
      },
      sort: [`event-${String(index).padStart(3, '0')}`],
    }));
    const search = vi
      .fn()
      .mockResolvedValueOnce({ hits: { hits: firstPage } })
      .mockResolvedValueOnce({
        hits: {
          hits: [
            {
              _source: { id: 'event-500', updatedAt: '2026-08-15T10:00:00.000Z' },
              sort: ['event-500'],
            },
          ],
        },
      });
    const reconciler = new SearchReconciler(sourceRepository([]), { search } as unknown as Client);

    const result = await reconciler.reconcile();

    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ search_after: ['event-499'] }),
    );
    expect(result).toEqual({ eligible: 0, indexed: 501, missing: 0, stale: 0, ineligible: 501 });
  });

  it('stops before reading Elasticsearch when cancellation is already requested', async () => {
    const search = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('test cancellation'));
    const reconciler = new SearchReconciler(sourceRepository([]), {
      search,
    } as unknown as Client);

    await expect(reconciler.reconcile(controller.signal)).rejects.toThrow('test cancellation');
    expect(search).not.toHaveBeenCalled();
  });
});
