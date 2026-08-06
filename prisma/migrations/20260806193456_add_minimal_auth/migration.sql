ALTER TABLE users
  ADD COLUMN password_hash text,
  ADD COLUMN platform_role text NOT NULL DEFAULT 'USER',
  ADD COLUMN last_login_at timestamptz;

UPDATE users
SET password_hash = 'locked:' || gen_random_uuid()::text
WHERE password_hash IS NULL;

ALTER TABLE users
  ALTER COLUMN password_hash SET NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_password_hash_not_blank_check
    CHECK (btrim(password_hash) <> ''),
  ADD CONSTRAINT users_platform_role_check
    CHECK (platform_role IN ('USER', 'PLATFORM_MODERATOR', 'PLATFORM_ADMIN'));
