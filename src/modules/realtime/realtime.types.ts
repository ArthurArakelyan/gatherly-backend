export interface NotificationCreatedEvent {
  id: string;
  type: 'notification.created';
  data: {
    notification: {
      id: string;
      type: string;
      title: string;
      message: string;
      data: Record<string, unknown>;
      readAt: null;
      createdAt: string;
    };
  };
  createdAt: Date;
}

export interface AttendanceUpdatedEvent {
  id: string;
  type: 'event.attendance.updated';
  data: {
    eventId: string;
    confirmedCount: number;
    waitingCount: number;
    capacity: number;
  };
  createdAt: Date;
}

export type RealtimeEvent = NotificationCreatedEvent | AttendanceUpdatedEvent;

export interface RealtimeStreamMessage {
  id?: string;
  event: RealtimeEvent['type'] | 'stream.refresh-required' | 'stream.closed';
  data: unknown;
}

export interface RealtimeStream {
  open(retryMilliseconds: number): void;
  send(message: RealtimeStreamMessage): boolean;
  heartbeat(): boolean;
  onClose(listener: () => void): void;
  close(): void;
}

export interface RealtimeWakeupPublisher {
  wake(): void;
}

export interface RealtimeWakeupTarget {
  wakeAll(): void;
}

export interface RealtimeEventReader {
  isActiveUser(userId: string): Promise<boolean>;
  findVisibleAfter(userId: string, afterId: bigint, limit: number): Promise<RealtimeEvent[]>;
}
