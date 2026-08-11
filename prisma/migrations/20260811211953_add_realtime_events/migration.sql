CREATE TABLE "realtime_events" (
  "id" BIGSERIAL NOT NULL,
  "type" TEXT NOT NULL,
  "audience_user_id" UUID,
  "community_id" UUID,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "realtime_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "realtime_events_one_audience_check" CHECK (
    (("audience_user_id" IS NOT NULL)::integer
      + ("community_id" IS NOT NULL)::integer) = 1
  ),
  CONSTRAINT "realtime_events_type_check" CHECK (
    "type" IN ('notification.created', 'event.attendance.updated')
  )
);

CREATE INDEX "realtime_events_user_id_idx"
  ON "realtime_events" ("audience_user_id", "id");

CREATE INDEX "realtime_events_community_id_idx"
  ON "realtime_events" ("community_id", "id");

ALTER TABLE "realtime_events"
  ADD CONSTRAINT "realtime_events_audience_user_id_fkey"
    FOREIGN KEY ("audience_user_id") REFERENCES "users"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "realtime_events"
  ADD CONSTRAINT "realtime_events_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "communities"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
