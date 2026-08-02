import { z } from 'zod';

export const communityMembershipRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({ communityId: z.uuid() }),
  query: z.object({}),
});

export type CommunityMembershipRequest = z.infer<typeof communityMembershipRequestSchema>;
