import { createHash } from 'node:crypto';

import type { RealtimeWakeupPublisher } from '../realtime/realtime.types.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  type ReservationsRepository,
  type ReservationTransactionRepository,
} from './reservations.repository.js';
import type {
  AttendanceOutcome,
  LockedEvent,
  ReservationCommandResult,
  ReservationSummary,
  WaitlistSummary,
} from './reservations.types.js';

const hashRequest = (eventId: string, userId: string): string =>
  createHash('sha256')
    .update(JSON.stringify({ operation: 'reserve', eventId, userId }))
    .digest('hex');

export class ReservationsService {
  public constructor(
    private readonly repository: ReservationsRepository,
    private readonly realtime?: RealtimeWakeupPublisher,
  ) {}

  private async createAttendance(
    transaction: ReservationTransactionRepository,
    event: LockedEvent,
    userId: string,
  ): Promise<AttendanceOutcome> {
    if (event.status !== 'PUBLISHED' || event.startsAt <= new Date()) {
      throw new AppError(409, 'EVENT_NOT_RESERVABLE', 'This event cannot be reserved');
    }
    if ((await transaction.findMembershipStatus(event.communityId, userId)) !== 'ACTIVE') {
      throw new AppError(403, 'COMMUNITY_PERMISSION_DENIED', 'Active membership is required');
    }

    const state = await transaction.findActiveState(event.id, userId);
    if (state.reserved) {
      throw new AppError(409, 'ALREADY_RESERVED', 'You already have a reservation');
    }
    if (state.waiting) {
      throw new AppError(409, 'ALREADY_WAITLISTED', 'You are already waiting');
    }

    let outcome: AttendanceOutcome;
    if ((await transaction.countConfirmed(event.id)) < event.capacity) {
      const reservationId = await transaction.insertConfirmed(event.id, userId);
      await transaction.insertNotification(userId, event.id, 'RESERVATION_CONFIRMED');
      outcome = { attendanceStatus: 'CONFIRMED', reservationId };
    } else {
      const entry = await transaction.insertWaiting(event.id, userId);
      const position = await transaction.calculatePosition(event.id, entry.joinedAt, entry.id);
      await transaction.insertNotification(userId, event.id, 'WAITLIST_JOINED');
      outcome = { attendanceStatus: 'WAITLISTED', waitlistEntryId: entry.id, position };
    }

    await transaction.insertAttendanceRealtimeEvent(event.communityId, event.id);
    return outcome;
  }

  public async reserve(
    eventId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<ReservationCommandResult> {
    const result = await this.repository.inTransaction(async (transaction) => {
      const event = await transaction.lockEvent(eventId);
      if (event === null) {
        throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
      }

      const claim = await transaction.claimIdempotency(
        userId,
        `reserve:${eventId}`,
        idempotencyKey,
        hashRequest(eventId, userId),
      );
      if (claim.kind === 'CONFLICT') {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused');
      }
      if (claim.kind === 'INCOMPLETE') {
        throw new AppError(409, 'REQUEST_IN_PROGRESS', 'The original request is incomplete');
      }
      if (claim.kind === 'REPLAY') return { status: claim.status, body: claim.body };

      const commandResult = {
        status: 201,
        body: await this.createAttendance(transaction, event, userId),
      };
      await transaction.completeIdempotency(claim.id, commandResult);
      return commandResult;
    });

    this.realtime?.wake();
    return result;
  }

  public async getReservation(eventId: string, userId: string): Promise<ReservationSummary> {
    const reservation = await this.repository.findReservation(eventId, userId);
    if (reservation === null) {
      throw new AppError(404, 'RESERVATION_NOT_FOUND', 'No active reservation exists');
    }
    return reservation;
  }

  public async getWaitlistEntry(eventId: string, userId: string): Promise<WaitlistSummary> {
    const entry = await this.repository.findWaitlistEntry(eventId, userId);
    if (entry === null) {
      throw new AppError(404, 'WAITLIST_ENTRY_NOT_FOUND', 'No active waitlist entry exists');
    }
    return entry;
  }

  public async cancelReservation(eventId: string, userId: string): Promise<void> {
    await this.repository.inTransaction(async (transaction) => {
      const event = await transaction.lockEvent(eventId);
      if (event === null) {
        throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
      }
      if (!(await transaction.cancelConfirmed(eventId, userId))) {
        throw new AppError(404, 'RESERVATION_NOT_FOUND', 'No active reservation exists');
      }

      const entry = await transaction.findFirstWaiting(eventId);
      if (entry !== null) {
        await transaction.promoteWaitlistEntry(entry.id);
        await transaction.insertPromotedReservation(eventId, entry.userId);
        await transaction.insertPromotionNotification(entry.userId, eventId);
      }
      await transaction.insertAttendanceRealtimeEvent(event.communityId, event.id);
    });

    this.realtime?.wake();
  }

  public async cancelWaitlist(eventId: string, userId: string): Promise<void> {
    await this.repository.inTransaction(async (transaction) => {
      const event = await transaction.lockEvent(eventId);
      if (event === null) {
        throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
      }
      if (!(await transaction.cancelWaiting(eventId, userId))) {
        throw new AppError(404, 'WAITLIST_ENTRY_NOT_FOUND', 'No active waitlist entry exists');
      }
      await transaction.insertAttendanceRealtimeEvent(event.communityId, event.id);
    });

    this.realtime?.wake();
  }
}
