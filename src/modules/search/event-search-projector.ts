import type { EventSearchIndex } from '../../infrastructure/elasticsearch/event-search-index.js';
import type { EventSearchSourceRepository } from './event-search-source.repository.js';

export class EventSearchProjector {
  public constructor(
    private readonly source: EventSearchSourceRepository,
    private readonly index: EventSearchIndex,
  ) {}

  public async sync(eventId: string): Promise<'indexed' | 'deleted'> {
    const document = await this.source.findEligibleById(eventId);
    if (document === null) {
      await this.index.delete(eventId);
      return 'deleted';
    }

    await this.index.index(document);
    return 'indexed';
  }
}
