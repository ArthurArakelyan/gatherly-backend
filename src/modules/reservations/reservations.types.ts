export interface LockedEvent {
  id: string;
  communityId: string;
  status: string;
  startsAt: Date;
  capacity: number;
}

export interface ActiveAttendanceState {
  reserved: boolean;
  waiting: boolean;
}

export type AttendanceOutcome =
  | { attendanceStatus: 'CONFIRMED'; reservationId: string }
  | { attendanceStatus: 'WAITLISTED'; waitlistEntryId: string; position: number };

export interface ReservationSummary {
  id: string;
  status: 'CONFIRMED';
  reservedAt: Date;
}

export interface WaitlistSummary {
  id: string;
  status: 'WAITING';
  joinedAt: Date;
  position: number;
}

export type IdempotencyClaim =
  | { kind: 'CLAIMED'; id: string }
  | { kind: 'CONFLICT' }
  | { kind: 'INCOMPLETE' }
  | { kind: 'REPLAY'; status: number; body: AttendanceOutcome };

export interface ReservationCommandResult {
  status: number;
  body: AttendanceOutcome;
}
