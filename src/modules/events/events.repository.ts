import pg, { type Pool } from 'pg';

import { AppError } from '../../shared/errors/app-error.js';
import type {
  CreateEventInput,
  Event,
  EventCreationAuthorization,
  EventFilters,
  EventFormat,
  EventPage,
  EventVisibility,
} from './events.types.js';

interface EventRow {
  id: string;
  community_id: string;
  created_by_user_id: string;
  title: string;
  slug: string;
  description: string;
  format: EventFormat;
  status: string;
  visibility: EventVisibility;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  capacity: number;
  created_at: Date;
  updated_at: Date;
}

interface AuthorizationRow {
  community_status: string;
  membership_status: string | null;
  role: string | null;
}

const eventSelection = `
  e.id, e.community_id, e.created_by_user_id, e.title, e.slug,
  e.description, e.format, e.status, e.visibility, e.starts_at,
  e.ends_at, e.timezone, e.capacity, e.created_at, e.updated_at
`;

const mapEvent = (row: EventRow): Event => ({
  id: row.id,
  communityId: row.community_id,
  createdByUserId: row.created_by_user_id,
  title: row.title,
  slug: row.slug,
  description: row.description,
  format: row.format,
  status: row.status,
  visibility: row.visibility,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  timezone: row.timezone,
  capacity: row.capacity,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class EventsRepository {
  public constructor(private readonly pool: Pool) {}

  public async findCreationAuthorization(
    communityId: string,
    userId: string,
  ): Promise<EventCreationAuthorization | null> {
    const result = await this.pool.query<AuthorizationRow>(
      `SELECT c.status AS community_status,
              m.status AS membership_status,
              m.role
       FROM communities AS c
       LEFT JOIN community_memberships AS m
         ON m.community_id = c.id AND m.user_id = $2
       WHERE c.id = $1`,
      [communityId, userId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          communityStatus: row.community_status,
          membershipStatus: row.membership_status,
          role: row.role,
        };
  }

  public async create(
    communityId: string,
    userId: string,
    input: CreateEventInput,
  ): Promise<Event> {
    try {
      const result = await this.pool.query<EventRow>(
        `INSERT INTO events
           (community_id, created_by_user_id, title, slug, description,
            format, visibility, starts_at, ends_at, timezone, capacity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING
           id, community_id, created_by_user_id, title, slug, description,
           format, status, visibility, starts_at, ends_at, timezone,
           capacity, created_at, updated_at`,
        [
          communityId,
          userId,
          input.title,
          input.slug,
          input.description,
          input.format,
          input.visibility,
          input.startsAt,
          input.endsAt,
          input.timezone,
          input.capacity,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('Event insert returned no row');
      return mapEvent(row);
    } catch (error) {
      if (
        error instanceof pg.DatabaseError &&
        error.code === '23505' &&
        error.constraint === 'events_community_slug_key'
      ) {
        throw new AppError(409, 'EVENT_SLUG_TAKEN', 'That event slug is already used here');
      }
      throw error;
    }
  }

  public async findPublicById(eventId: string): Promise<Event | null> {
    const result = await this.pool.query<EventRow>(
      `SELECT ${eventSelection}
       FROM events AS e
       JOIN communities AS c ON c.id = e.community_id
       WHERE e.id = $1
         AND e.visibility = 'PUBLIC'
         AND e.status IN ('PUBLISHED', 'CANCELLED', 'COMPLETED')
         AND c.status = 'ACTIVE'`,
      [eventId],
    );
    return result.rows[0] === undefined ? null : mapEvent(result.rows[0]);
  }

  public async listPublic(filters: EventFilters): Promise<EventPage> {
    const clauses = [
      `e.visibility = 'PUBLIC'`,
      `e.status IN ('PUBLISHED', 'CANCELLED', 'COMPLETED')`,
      `c.status = 'ACTIVE'`,
    ];
    const values: unknown[] = [];
    const add = (columnAndOperator: string, value: unknown): void => {
      values.push(value);
      clauses.push(`${columnAndOperator} $${String(values.length)}`);
    };

    if (filters.communityId !== null) add('e.community_id =', filters.communityId);
    if (filters.status !== null) add('e.status =', filters.status);
    if (filters.startsAfter !== null) add('e.starts_at >=', filters.startsAfter);
    if (filters.startsBefore !== null) add('e.starts_at <', filters.startsBefore);

    const where = clauses.join(' AND ');
    const filterValues = [...values];
    values.push(filters.limit, (filters.page - 1) * filters.limit);
    const limitParameter = String(values.length - 1);
    const offsetParameter = String(values.length);

    const [events, count] = await Promise.all([
      this.pool.query<EventRow>(
        `SELECT ${eventSelection}
         FROM events AS e
         JOIN communities AS c ON c.id = e.community_id
         WHERE ${where}
         ORDER BY e.starts_at ASC, e.id ASC
         LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
        values,
      ),
      this.pool.query<{ total: number }>(
        `SELECT count(*)::integer AS total
         FROM events AS e
         JOIN communities AS c ON c.id = e.community_id
         WHERE ${where}`,
        filterValues,
      ),
    ]);

    return {
      items: events.rows.map(mapEvent),
      page: filters.page,
      limit: filters.limit,
      total: count.rows[0]?.total ?? 0,
    };
  }
}
