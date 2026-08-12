export type CommunityChatRole = 'MEMBER' | 'MODERATOR' | 'ORGANIZER' | 'OWNER';

export interface ChatAccess {
  eventId: string;
  userId: string;
  username: string;
  role: CommunityChatRole;
}

export interface ChatMessage {
  id: string;
  eventId: string;
  sender: { id: string; username: string };
  body: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface ChatHistoryCursor {
  createdAt: string;
  id: string;
}

export interface ChatHistoryPage {
  items: ChatMessage[];
  nextCursor: string | null;
}

export interface SendMessageResult {
  message: ChatMessage;
  duplicate: boolean;
}

export interface DeleteMessageResult {
  message: ChatMessage;
  changed: boolean;
}

export type ClientChatCommand =
  | { type: 'chat.join'; requestId: string; eventId: string }
  | { type: 'chat.leave'; requestId: string }
  | {
      type: 'chat.message.send';
      requestId: string;
      eventId: string;
      clientMessageId: string;
      body: string;
    }
  | {
      type: 'chat.message.delete';
      requestId: string;
      eventId: string;
      messageId: string;
    }
  | {
      type: 'chat.typing.set';
      requestId: string;
      eventId: string;
      isTyping: boolean;
    };

export type ServerChatEvent =
  | { type: 'connection.ready'; data: { protocol: 'gatherly.chat.v1' } }
  | { type: 'connection.refresh'; data: { reason: 'connection_age_limit' } }
  | { type: 'chat.joined'; requestId: string; data: { eventId: string } }
  | { type: 'chat.left'; requestId: string; data: { eventId: string | null } }
  | {
      type: 'chat.message.accepted';
      requestId: string;
      data: { messageId: string; clientMessageId: string; duplicate: boolean };
    }
  | { type: 'chat.message.deleted.accepted'; requestId: string; data: { messageId: string } }
  | { type: 'chat.message.created'; data: { message: ChatMessage } }
  | { type: 'chat.message.deleted'; data: { message: ChatMessage } }
  | {
      type: 'chat.typing.updated';
      data: { eventId: string; userId: string; username: string; isTyping: boolean };
    }
  | { type: 'chat.presence.snapshot'; data: { eventId: string; onlineUserIds: string[] } }
  | {
      type: 'chat.presence.updated';
      data: { eventId: string; userId: string; username: string; online: boolean };
    }
  | { type: 'error'; requestId?: string; error: { code: string; message: string } };

export type ChatSignal =
  | { kind: 'message.created'; eventId: string; messageId: string }
  | { kind: 'message.deleted'; eventId: string; messageId: string }
  | {
      kind: 'typing.updated';
      eventId: string;
      userId: string;
      username: string;
      isTyping: boolean;
    }
  | {
      kind: 'presence.updated';
      eventId: string;
      userId: string;
      username: string;
      online: boolean;
    };

export interface ChatSignalPublisher {
  publish(signal: ChatSignal): void;
}

export interface ChatSignalTarget {
  handleSignal(signal: ChatSignal): Promise<void>;
}

export interface ChatPresence {
  join(eventId: string, userId: string, connectionId: string): Promise<string[]>;
  renew(eventId: string, userId: string, connectionId: string): Promise<void>;
  leave(eventId: string, userId: string, connectionId: string): Promise<boolean>;
}
