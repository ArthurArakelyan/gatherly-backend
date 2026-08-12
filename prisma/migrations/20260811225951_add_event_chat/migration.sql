CREATE TABLE "event_conversations" (
                                     "id" UUID NOT NULL DEFAULT gen_random_uuid(),
                                     "event_id" UUID NOT NULL,
                                     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                                     "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

                                     CONSTRAINT "event_conversations_pkey" PRIMARY KEY ("id"),
                                     CONSTRAINT "event_conversations_event_id_key" UNIQUE ("event_id")
);

CREATE TABLE "chat_messages" (
                               "id" UUID NOT NULL DEFAULT gen_random_uuid(),
                               "conversation_id" UUID NOT NULL,
                               "sender_user_id" UUID NOT NULL,
                               "client_message_id" UUID NOT NULL,
                               "body" TEXT NOT NULL,
                               "deleted_at" TIMESTAMPTZ(6),
                               "deleted_by_user_id" UUID,
                               "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

                               CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id"),
                               CONSTRAINT "chat_messages_body_check" CHECK (char_length("body") BETWEEN 1 AND 2000),
                               CONSTRAINT "chat_messages_deletion_check" CHECK (
                                 ("deleted_at" IS NULL AND "deleted_by_user_id" IS NULL)
                                   OR ("deleted_at" IS NOT NULL AND "deleted_by_user_id" IS NOT NULL)
                                 ),
                               CONSTRAINT "chat_messages_client_id_key"
                                 UNIQUE ("conversation_id", "sender_user_id", "client_message_id")
);

CREATE TABLE "chat_moderation_actions" (
                                         "id" UUID NOT NULL DEFAULT gen_random_uuid(),
                                         "message_id" UUID NOT NULL,
                                         "actor_user_id" UUID NOT NULL,
                                         "action" TEXT NOT NULL,
                                         "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

                                         CONSTRAINT "chat_moderation_actions_pkey" PRIMARY KEY ("id"),
                                         CONSTRAINT "chat_moderation_actions_action_check" CHECK ("action" = 'DELETE')
);

CREATE INDEX "chat_messages_history_idx"
  ON "chat_messages" ("conversation_id", "created_at" DESC, "id" DESC);

CREATE INDEX "chat_moderation_actions_message_idx"
  ON "chat_moderation_actions" ("message_id", "created_at");

ALTER TABLE "event_conversations"
  ADD CONSTRAINT "event_conversations_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "event_conversations"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_sender_user_id_fkey"
    FOREIGN KEY ("sender_user_id") REFERENCES "users"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_deleted_by_user_id_fkey"
    FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "chat_moderation_actions"
  ADD CONSTRAINT "chat_moderation_actions_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "chat_moderation_actions"
  ADD CONSTRAINT "chat_moderation_actions_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
