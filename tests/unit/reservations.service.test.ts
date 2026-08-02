import { describe, expect, it, vi } from 'vitest';

import type { ReservationsRepository } from '../../src/modules/reservations/reservations.repository.js';
import { ReservationsService } from '../../src/modules/reservations/reservations.service.js';

describe('ReservationsService', () => {
  it('does not turn an absent reservation into a successful response', async () => {
    const findReservation = vi.fn().mockResolvedValue(null);
    const repository = {
      findReservation,
      findWaitlistEntry: vi.fn(),
    } as unknown as ReservationsRepository;

    await expect(
      new ReservationsService(repository).getReservation('event-id', 'user-id'),
    ).rejects.toMatchObject({
      status: 404,
      code: 'RESERVATION_NOT_FOUND',
    });
  });

  it('does not turn an absent waitlist entry into a successful response', async () => {
    const findWaitlistEntry = vi.fn().mockResolvedValue(null);
    const repository = {
      findReservation: vi.fn(),
      findWaitlistEntry,
    } as unknown as ReservationsRepository;

    await expect(
      new ReservationsService(repository).getWaitlistEntry('event-id', 'user-id'),
    ).rejects.toMatchObject({
      status: 404,
      code: 'WAITLIST_ENTRY_NOT_FOUND',
    });
  });
});
