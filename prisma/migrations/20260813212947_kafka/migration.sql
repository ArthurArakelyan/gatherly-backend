-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "topic" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL CHECK ("event_version" > 0),
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "publish_attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("publish_attempts" >= 0),
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_kafka_events" (
    "consumer_name" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "partition" INTEGER NOT NULL CHECK ("partition" >= 0),
    "offset_value" BIGINT NOT NULL CHECK ("offset_value" >= 0),
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_kafka_events_pkey" PRIMARY KEY ("consumer_name","event_id")
);

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("occurred_at", "id") WHERE "published_at" IS NULL;

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_key_idx" ON "outbox_events"("event_key", "occurred_at", "id") WHERE "published_at" IS NULL;

-- CreateIndex
CREATE INDEX "processed_kafka_events_processed_at_idx" ON "processed_kafka_events"("processed_at");
