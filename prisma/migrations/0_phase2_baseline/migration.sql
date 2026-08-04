CREATE TABLE users (
                     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                     username text NOT NULL,
                     status text NOT NULL DEFAULT 'ACTIVE',
                     created_at timestamptz NOT NULL DEFAULT now(),
                     updated_at timestamptz NOT NULL DEFAULT now(),

                     CONSTRAINT users_username_key UNIQUE (username),
                     CONSTRAINT users_username_format_check
                       CHECK (username ~ '^[a-z0-9_]{3,30}$'),
  CONSTRAINT users_status_check
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED'))
);

CREATE TABLE communities (
                           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                           name text NOT NULL,
                           slug text NOT NULL,
                           description text NOT NULL DEFAULT '',
                           city text,
                           country text,
                           visibility text NOT NULL DEFAULT 'PUBLIC',
                           join_policy text NOT NULL DEFAULT 'OPEN',
                           status text NOT NULL DEFAULT 'ACTIVE',
                           created_by_user_id uuid NOT NULL REFERENCES users(id),
                           created_at timestamptz NOT NULL DEFAULT now(),
                           updated_at timestamptz NOT NULL DEFAULT now(),

                           CONSTRAINT communities_slug_key UNIQUE (slug),
                           CONSTRAINT communities_name_not_blank_check CHECK (btrim(name) <> ''),
                           CONSTRAINT communities_slug_format_check
                             CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT communities_visibility_check
    CHECK (visibility IN ('PUBLIC', 'UNLISTED', 'PRIVATE')),
  CONSTRAINT communities_join_policy_check
    CHECK (join_policy IN ('OPEN', 'APPROVAL_REQUIRED', 'INVITE_ONLY')),
  CONSTRAINT communities_status_check
    CHECK (status IN ('ACTIVE', 'ARCHIVED', 'SUSPENDED'))
);

CREATE TABLE community_memberships (
                                     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                                     community_id uuid NOT NULL REFERENCES communities(id),
                                     user_id uuid NOT NULL REFERENCES users(id),
                                     role text NOT NULL DEFAULT 'MEMBER',
                                     status text NOT NULL DEFAULT 'ACTIVE',
                                     joined_at timestamptz NOT NULL DEFAULT now(),
                                     created_at timestamptz NOT NULL DEFAULT now(),
                                     updated_at timestamptz NOT NULL DEFAULT now(),

                                     CONSTRAINT community_memberships_user_community_key
                                       UNIQUE (community_id, user_id),
                                     CONSTRAINT community_memberships_role_check
                                       CHECK (role IN ('MEMBER', 'MODERATOR', 'ORGANIZER', 'OWNER')),
                                     CONSTRAINT community_memberships_status_check
                                       CHECK (status IN ('PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'BANNED', 'LEFT'))
);

CREATE TABLE events (
                      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                      community_id uuid NOT NULL REFERENCES communities(id),
                      created_by_user_id uuid NOT NULL REFERENCES users(id),
                      title text NOT NULL,
                      slug text NOT NULL,
                      description text NOT NULL DEFAULT '',
                      format text NOT NULL DEFAULT 'IN_PERSON',
                      status text NOT NULL DEFAULT 'PUBLISHED',
                      visibility text NOT NULL DEFAULT 'PUBLIC',
                      starts_at timestamptz NOT NULL,
                      ends_at timestamptz NOT NULL,
                      timezone text NOT NULL,
                      capacity integer NOT NULL,
                      created_at timestamptz NOT NULL DEFAULT now(),
                      updated_at timestamptz NOT NULL DEFAULT now(),

                      CONSTRAINT events_community_slug_key UNIQUE (community_id, slug),
                      CONSTRAINT events_title_not_blank_check CHECK (btrim(title) <> ''),
                      CONSTRAINT events_time_order_check CHECK (starts_at < ends_at),
                      CONSTRAINT events_capacity_positive_check CHECK (capacity > 0),
                      CONSTRAINT events_format_check CHECK (format IN ('IN_PERSON', 'ONLINE', 'HYBRID')),
                      CONSTRAINT events_status_check
                        CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED', 'ARCHIVED')),
                      CONSTRAINT events_visibility_check
                        CHECK (visibility IN ('PUBLIC', 'COMMUNITY_ONLY', 'INVITE_ONLY'))
);

CREATE TABLE reservations (
                            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                            event_id uuid NOT NULL REFERENCES events(id),
                            user_id uuid NOT NULL REFERENCES users(id),
                            status text NOT NULL DEFAULT 'CONFIRMED',
                            reserved_at timestamptz NOT NULL DEFAULT now(),
                            confirmed_at timestamptz NOT NULL DEFAULT now(),
                            cancelled_at timestamptz,
                            cancellation_reason text,
                            created_at timestamptz NOT NULL DEFAULT now(),
                            updated_at timestamptz NOT NULL DEFAULT now(),

                            CONSTRAINT reservations_status_check
                              CHECK (status IN ('CONFIRMED', 'CANCELLED_BY_USER', 'CANCELLED_BY_ORGANIZER')),
                            CONSTRAINT reservations_cancellation_time_check CHECK (
                              (status = 'CONFIRMED' AND cancelled_at IS NULL)
                                OR
                              (status IN ('CANCELLED_BY_USER', 'CANCELLED_BY_ORGANIZER') AND cancelled_at IS NOT NULL)
                              )
);

CREATE UNIQUE INDEX reservations_active_user_event_uidx
  ON reservations (event_id, user_id)
  WHERE status = 'CONFIRMED';

CREATE INDEX reservations_event_status_idx
  ON reservations (event_id, status);

CREATE TABLE waitlist_entries (
                                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                                event_id uuid NOT NULL REFERENCES events(id),
                                user_id uuid NOT NULL REFERENCES users(id),
                                status text NOT NULL DEFAULT 'WAITING',
                                joined_at timestamptz NOT NULL DEFAULT now(),
                                promoted_at timestamptz,
                                cancelled_at timestamptz,
                                created_at timestamptz NOT NULL DEFAULT now(),
                                updated_at timestamptz NOT NULL DEFAULT now(),

                                CONSTRAINT waitlist_entries_status_check
                                  CHECK (status IN ('WAITING', 'PROMOTED', 'CANCELLED', 'REMOVED'))
);

CREATE UNIQUE INDEX waitlist_entries_waiting_user_event_uidx
  ON waitlist_entries (event_id, user_id)
  WHERE status = 'WAITING';

CREATE INDEX waitlist_entries_event_order_idx
  ON waitlist_entries (event_id, joined_at, id)
  WHERE status = 'WAITING';

CREATE TABLE notifications (
                             id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                             user_id uuid NOT NULL REFERENCES users(id),
                             type text NOT NULL,
                             title text NOT NULL,
                             message text NOT NULL,
                             data jsonb NOT NULL DEFAULT '{}'::jsonb,
                             read_at timestamptz,
                             created_at timestamptz NOT NULL DEFAULT now(),

                             CONSTRAINT notifications_type_check CHECK (
                               type IN (
                                        'RESERVATION_CONFIRMED',
                                        'RESERVATION_CANCELLED',
                                        'WAITLIST_JOINED',
                                        'WAITLIST_PROMOTED',
                                        'EVENT_UPDATED',
                                        'EVENT_CANCELLED',
                                        'MEMBERSHIP_APPROVED'
                                 )
                               )
);

CREATE INDEX communities_status_created_idx
  ON communities (status, created_at DESC, id DESC);

CREATE INDEX events_status_starts_idx
  ON events (status, starts_at, id);

CREATE INDEX community_memberships_user_idx
  ON community_memberships (user_id, community_id);


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
