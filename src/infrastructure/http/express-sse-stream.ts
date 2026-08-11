import type { Response } from 'express';

import type {
  RealtimeStream,
  RealtimeStreamMessage,
} from '../../modules/realtime/realtime.types.js';

const serializeMessage = (message: RealtimeStreamMessage): string => {
  const fields: string[] = [];
  if (message.id !== undefined) fields.push(`id: ${message.id}`);
  fields.push(`event: ${message.event}`);
  fields.push(`data: ${JSON.stringify(message.data)}`);
  return `${fields.join('\n')}\n\n`;
};

export class ExpressSseStream implements RealtimeStream {
  public constructor(private readonly response: Response) {}

  public open(retryMilliseconds: number): void {
    this.response.status(200);
    this.response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    this.response.setHeader('Cache-Control', 'no-cache, no-transform');
    this.response.setHeader('Connection', 'keep-alive');
    this.response.setHeader('X-Accel-Buffering', 'no');
    this.response.flushHeaders();
    this.response.write(`retry: ${String(retryMilliseconds)}\n\n`);
  }

  public send(message: RealtimeStreamMessage): boolean {
    return this.response.write(serializeMessage(message));
  }

  public heartbeat(): boolean {
    return this.response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }

  public onClose(listener: () => void): void {
    this.response.once('close', listener);
  }

  public close(): void {
    if (!this.response.writableEnded) this.response.end();
  }
}
