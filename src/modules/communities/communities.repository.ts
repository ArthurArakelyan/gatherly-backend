import pg, { type Pool } from 'pg';

import { AppError } from '../../shared/errors/app-error.js';
import { withTransaction } from '../../shared/database/transaction.js';
import type { Community, CommunityPage, CreateCommunityInput } from './communities.types.js';

interface CommunityRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  city: string | null;
  country: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

const mapCommunity = (row: CommunityRow): Community => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  description: row.description,
  city: row.city,
  country: row.country,
  createdByUserId: row.created_by_user_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const selection = `
  id, name, slug, description, city, country,
  created_by_user_id, created_at, updated_at
`;

export class CommunitiesRepository {
  public constructor(private readonly pool: Pool) {}

  public async createWithOwner(userId: string, input: CreateCommunityInput): Promise<Community> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const created = await client.query<CommunityRow>(
          `INSERT INTO communities
             (name, slug, description, city, country, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${selection}`,
          [input.name, input.slug, input.description, input.city, input.country, userId],
        );
        const community = created.rows[0];
        if (community === undefined) throw new Error('Community insert returned no row');

        await client.query(
          `INSERT INTO community_memberships (community_id, user_id, role, status)
           VALUES ($1, $2, 'OWNER', 'ACTIVE')`,
          [community.id, userId],
        );
        return mapCommunity(community);
      });
    } catch (error) {
      if (
        error instanceof pg.DatabaseError &&
        error.code === '23505' &&
        error.constraint === 'communities_slug_key'
      ) {
        throw new AppError(409, 'COMMUNITY_SLUG_TAKEN', 'That community slug is already used');
      }
      throw error;
    }
  }

  public async findById(id: string): Promise<Community | null> {
    const result = await this.pool.query<CommunityRow>(
      `SELECT ${selection} FROM communities WHERE id = $1 AND status = 'ACTIVE'`,
      [id],
    );
    return result.rows[0] === undefined ? null : mapCommunity(result.rows[0]);
  }

  public async list(page: number, limit: number): Promise<CommunityPage> {
    const offset = (page - 1) * limit;
    const [rows, count] = await Promise.all([
      this.pool.query<CommunityRow>(
        `SELECT ${selection}
         FROM communities
         WHERE status = 'ACTIVE' AND visibility = 'PUBLIC'
         ORDER BY created_at DESC, id DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      this.pool.query<{ total: number }>(
        `SELECT count(*)::integer AS total
         FROM communities WHERE status = 'ACTIVE' AND visibility = 'PUBLIC'`,
      ),
    ]);
    return { items: rows.rows.map(mapCommunity), page, limit, total: count.rows[0]?.total ?? 0 };
  }
}
