INSERT INTO users (id, username, password_hash)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'alice',
   '$argon2id$v=19$m=19456,p=1,t=2$oZv+KaEHtUTkggVPqQ6pZg$B6+dBgURlkH2UC3UrNT3wmG5KFP404xRHGljXULwVY0'), /* GatherlyTest123 */
  ('00000000-0000-4000-8000-000000000002', 'bob',
   '$argon2id$v=19$m=19456,p=1,t=2$oZv+KaEHtUTkggVPqQ6pZg$B6+dBgURlkH2UC3UrNT3wmG5KFP404xRHGljXULwVY0'), /* GatherlyTest123 */
  ('00000000-0000-4000-8000-000000000003', 'carol',
   '$argon2id$v=19$m=19456,p=1,t=2$oZv+KaEHtUTkggVPqQ6pZg$B6+dBgURlkH2UC3UrNT3wmG5KFP404xRHGljXULwVY0') /* GatherlyTest123 */
  ON CONFLICT (id) DO UPDATE
                        SET username = EXCLUDED.username,
                        password_hash = EXCLUDED.password_hash,
                        status = 'ACTIVE';
