import type { Client } from 'pg';

interface LockRow {
  acquired: boolean;
}

export const withPostgresAdvisoryLock = async <T>(
  client: Client,
  lockName: string,
  operation: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> => {
  const lockResult = await client.query<LockRow>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
    [lockName],
  );
  const acquired = lockResult.rows[0]?.acquired === true;
  if (!acquired) return { acquired: false };

  try {
    return { acquired: true, value: await operation() };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
  }
};
