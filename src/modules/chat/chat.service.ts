import { AppError } from '../../shared/errors/app-error.js';
import type { ChatRepository } from './chat.repository.js';
import type {
  ChatAccess,
  ChatHistoryPage,
  ChatMessage,
  DeleteMessageResult,
  SendMessageResult,
} from './chat.types.js';

export class ChatService {
  public constructor(private readonly repository: ChatRepository) {}

  public async requireActiveUser(userId: string): Promise<{ userId: string; username: string }> {
    const username = await this.repository.findActiveUsername(userId);
    if (username === null) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
    }
    return { userId, username };
  }

  public async requireAccess(eventId: string, userId: string): Promise<ChatAccess> {
    const access = await this.repository.findAccess(eventId, userId);
    if (access === null) {
      throw new AppError(403, 'CHAT_ACCESS_DENIED', 'Active community membership is required');
    }
    return access;
  }

  public async history(
    eventId: string,
    userId: string,
    encodedCursor: string | undefined,
    limit: number,
  ): Promise<ChatHistoryPage> {
    const page = await this.repository.findHistory(eventId, userId, encodedCursor, limit);
    if (page === null) {
      throw new AppError(403, 'CHAT_ACCESS_DENIED', 'Active community membership is required');
    }
    return page;
  }

  public async sendMessage(
    eventId: string,
    userId: string,
    clientMessageId: string,
    body: string,
  ): Promise<SendMessageResult> {
    const result = await this.repository.createMessage(eventId, userId, clientMessageId, body);
    if (result === null) {
      throw new AppError(403, 'CHAT_ACCESS_DENIED', 'Active community membership is required');
    }
    return result;
  }

  public async deleteMessage(
    eventId: string,
    messageId: string,
    actorUserId: string,
  ): Promise<DeleteMessageResult> {
    const result = await this.repository.deleteMessage(eventId, messageId, actorUserId);
    if (result === null) {
      throw new AppError(404, 'CHAT_MESSAGE_NOT_FOUND', 'Chat message was not found');
    }
    if (result === 'FORBIDDEN') {
      throw new AppError(403, 'CHAT_MODERATION_DENIED', 'You cannot delete this message');
    }
    return result;
  }

  public findMessageForBroadcast(eventId: string, messageId: string): Promise<ChatMessage | null> {
    return this.repository.findMessageForBroadcast(eventId, messageId);
  }
}
