import type { PrismaClient } from '../../generated/prisma/client.js';

export interface KafkaRecordPosition {
  topic: string;
  partition: number;
  offset: string;
}

export class ProcessedEventsRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async hasProcessed(consumerName: string, eventId: string): Promise<boolean> {
    const record = await this.prisma.processedKafkaEvent.findUnique({
      where: {
        consumerName_eventId: { consumerName, eventId },
      },
      select: { eventId: true },
    });
    return record !== null;
  }

  public async markProcessed(
    consumerName: string,
    eventId: string,
    position: KafkaRecordPosition,
  ): Promise<void> {
    await this.prisma.processedKafkaEvent.createMany({
      data: {
        consumerName,
        eventId,
        topic: position.topic,
        partition: position.partition,
        offsetValue: BigInt(position.offset),
      },
      skipDuplicates: true,
    });
  }
}
