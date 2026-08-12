import type { Logger } from 'pino';

import type { EventSearchIndex } from '../../infrastructure/elasticsearch/event-search-index.js';
import type { EventSearchProjection } from '../events/events.types.js';
import type { EventSearchSourceRepository } from './event-search-source.repository.js';

export class BestEffortEventSearchProjector implements EventSearchProjection {
  private readonly pending = new Set<Promise<void>>();

  public constructor(
    private readonly source: EventSearchSourceRepository,
    private readonly index: EventSearchIndex,
    private readonly logger: Logger,
  ) {}

  public schedule(eventId: string): void {
    const task = this.sync(eventId).catch((error: unknown) => {
      this.logger.warn(
        { err: error, eventId },
        'Event committed but its search projection could not be refreshed',
      );
    });

    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  public async drain(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async sync(eventId: string): Promise<void> {
    const document = await this.source.findEligibleById(eventId);
    if (document === null) {
      await this.index.delete(eventId);
      return;
    }
    await this.index.index(document);
  }
}
