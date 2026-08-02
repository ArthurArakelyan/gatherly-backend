import type { CommunitiesRepository } from './communities.repository.js';
import type { Community, CommunityPage, CreateCommunityInput } from './communities.types.js';
import { AppError } from '../../shared/errors/app-error.js';

export class CommunitiesService {
  public constructor(private readonly repository: CommunitiesRepository) {}

  public create(userId: string, input: CreateCommunityInput): Promise<Community> {
    return this.repository.createWithOwner(userId, input);
  }

  public list(page: number, limit: number): Promise<CommunityPage> {
    return this.repository.list(page, limit);
  }

  public async get(id: string): Promise<Community> {
    const community = await this.repository.findById(id);

    if (community === null) {
      throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'The requested community does not exist');
    }

    return community;
  }
}
