CREATE TABLE idempotency_keys (
                                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                                user_id uuid NOT NULL REFERENCES users(id),
                                scope text NOT NULL,
                                key text NOT NULL,
                                request_hash text NOT NULL,
                                response_status integer,
                                response_body jsonb,
                                created_at timestamptz NOT NULL DEFAULT now(),
                                completed_at timestamptz,

                                CONSTRAINT idempotency_keys_user_scope_key_key
                                  UNIQUE (user_id, scope, key),
                                CONSTRAINT idempotency_keys_http_status_check
                                  CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 599)
);
