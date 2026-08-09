-- CreateIndex
CREATE INDEX "events_public_community_starts_idx" ON "events"("community_id", "visibility", "starts_at", "id", "status");
