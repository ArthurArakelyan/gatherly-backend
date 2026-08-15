import type { Logger } from 'pino';

export interface AuditEvent {
  action: string;
  actorUserId: string;
  targetType: 'community' | 'event' | 'membership' | 'reservation';
  targetId: string;
  communityId?: string;
  eventId?: string;
  result: 'allowed' | 'denied' | 'completed';
  reasonCode?: string;
}

export const logAuditEvent = (logger: Logger, event: AuditEvent): void => {
  logger.info({ audit: event }, 'Security-sensitive action');
};
