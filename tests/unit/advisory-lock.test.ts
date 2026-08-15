import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { withPostgresAdvisoryLock } from '../../src/infrastructure/postgres/advisory-lock.js';

describe('withPostgresAdvisoryLock', () => {
  it('skips the operation when another process owns the lock', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ acquired: false }] });
    const operation = vi.fn();

    await expect(
      withPostgresAdvisoryLock({ query } as unknown as Client, 'gatherly:test', operation),
    ).resolves.toEqual({ acquired: false });

    expect(operation).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
  });

  it('returns the operation result and releases an acquired lock', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    const operation = vi.fn().mockResolvedValue('completed');

    await expect(
      withPostgresAdvisoryLock({ query } as unknown as Client, 'gatherly:test', operation),
    ).resolves.toEqual({ acquired: true, value: 'completed' });

    expect(operation).toHaveBeenCalledOnce();
    expect(query).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
      'gatherly:test',
    ]);
  });

  it('releases the lock when the operation fails and preserves the original error', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    const failure = new Error('reconciliation failed');

    await expect(
      withPostgresAdvisoryLock(
        { query } as unknown as Client,
        'gatherly:test',
        vi.fn().mockRejectedValue(failure),
      ),
    ).rejects.toBe(failure);

    expect(query).toHaveBeenCalledTimes(2);
  });
});
