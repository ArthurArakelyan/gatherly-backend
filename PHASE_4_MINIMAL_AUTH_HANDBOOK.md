# Phase 4 Handbook: Minimal Authentication and Object-Level Authorization

This handbook starts from the completed Phase 3 repository: Express 5, Zod,
PostgreSQL, Prisma for ordinary repositories, and raw `pg` transactions for
reservation and waitlist locking. It replaces the temporary `x-user-id` header
with real authentication without turning Gatherly into an authentication
project.

Work through the steps in order. Code samples use the repository's ES modules,
strict TypeScript, `NodeNext` resolution, dependency injection, stable error
shape, and Testcontainers setup. The samples are deliberately complete enough
to type rather than merely pseudocode, but read each explanation before copying
it: the lesson is where authentication ends and authorization begins.

## Phase outcome

At the end of Phase 4, Gatherly has:

- username/password sign-up and sign-in;
- a protected endpoint for reading the current authenticated user;
- Argon2id password hashes and no recoverable passwords;
- a short-lived signed bearer access token;
- a database-backed authentication check on every protected request;
- immediate rejection of suspended or deleted accounts;
- separate sign-up and sign-in rate limiting plus generic invalid-credential responses;
- no remaining trust in `x-user-id`;
- object-level community authorization in services;
- tests for missing, malformed, expired, and forged tokens;
- tests for bans, inactive membership, insufficient roles, cross-community ID
  substitution, and owner protection when member management is exposed;
- updated OpenAPI and local setup documentation.

The protected request flow becomes:

```text
Authorization: Bearer <access-token>
  -> verify signature, issuer, audience, and expiry
  -> read token subject
  -> load current user from PostgreSQL
  -> require ACTIVE account
  -> controller reads authenticated user
  -> service authorizes the exact requested object
  -> repository performs persistence
```

The database lookup is intentional. A completely stateless role-bearing JWT
would let a suspended user or demoted organizer retain old authority until the
token expired. Gatherly favors simple, immediately effective authorization over
eliminating one small indexed user lookup.

## Scope and deliberate omissions

Build only:

```text
POST /auth/sign-up
POST /auth/sign-in
GET  /auth/me
Authorization: Bearer <short-lived access token>
```

Do not add:

- email verification or any other email delivery;
- password recovery;
- refresh-token rotation;
- magic links;
- OAuth, OIDC, or social providers;
- device/session dashboards;
- MFA;
- API keys;
- Redis-backed sessions or token deny lists;
- cookie authentication merely because browsers exist.

An access token lifetime around 15 minutes is enough for this learning phase.
When it expires, the client signs in again. That is intentionally less
convenient than a production session system and keeps the lesson narrow.

### Refresh tokens are not bad; incomplete refresh-token systems are bad

This phase omits refresh tokens because of scope, not because refresh tokens are
an insecure idea. A correctly implemented refresh token lets a client obtain a
new short-lived access token without asking the user for credentials again. It
is useful when a product needs long-lived sign-in across browser restarts,
native applications, multiple devices, or independent API clients.

The security tradeoff is that a refresh token is normally a long-lived
credential. Anyone who steals an ordinary bearer refresh token can keep minting
new access tokens until the refresh token expires or is revoked. A 15-minute
access token limits one stolen access token; a 30-day refresh token can silently
extend the compromise for 30 days. The refresh token therefore requires more
protection and lifecycle management than the access token it replaces.

Current OAuth security guidance does not say “never use refresh tokens.” It
says an authorization server must decide whether a client actually needs one,
and public clients that receive refresh tokens need replay detection through
rotation or sender-constraining. See
[OAuth 2.0 Security Best Current Practice, RFC 9700, section 4.14](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14).

Although Gatherly's direct username/password flow is not an OAuth authorization
server, the same stolen-bearer-token and replay risks apply.

#### What adding refresh tokens really adds

A credible implementation needs all of these decisions and tests:

1. **Storage:** where the client keeps the token without exposing it to routine
   JavaScript, logs, URLs, crash reports, browser extensions, backups, or other
   applications.
2. **Server state:** which user, session, token family, device label, creation
   time, last-use time, idle expiry, and absolute expiry belong to the token.
3. **Rotation:** whether every successful refresh invalidates the presented
   token and returns a new one.
4. **Replay detection:** what happens when an already rotated token is used
   again. The usual safe response is to revoke the entire token family because
   the server cannot know whether the attacker or legitimate client arrived
   first.
5. **Concurrency:** how two browser tabs or simultaneous API retries avoid
   rotating the same token twice and falsely looking like theft.
6. **Revocation:** how logout, account suspension, password change, credential
   reset, administrator action, and suspected compromise invalidate sessions.
7. **Expiry:** both a sliding idle timeout and a non-extendable absolute session
   lifetime.
8. **Request security:** refresh endpoint rate limiting, safe errors, token
   hashing at rest, transaction boundaries, and audit events.
9. **Browser threats:** an `HttpOnly` cookie reduces token theft by JavaScript
   but introduces ambient cookie submission, so CSRF and `Origin` validation
   must be addressed. A JavaScript-readable token avoids cookie CSRF but is
   directly exposed to successful XSS.
10. **Cleanup and operations:** deleting expired session rows, listing/revoking
    active sessions when the product needs it, and handling signing-key or
    database incidents.

That is why “just issue another JWT with a longer expiration” is not a complete
refresh-token design. A self-contained JWT refresh token is still replayable
after theft. Once rotation, reuse detection, logout, and revocation are
required, the server needs session state anyway. An opaque random refresh token
whose hash is stored in PostgreSQL is usually simpler for a first-party system.

#### Good choices by client type

| Client/product shape                                   | Usually best starting design                                                                                                                      | Why                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-party browser and API owned together             | Opaque server-side session ID in a secure cookie                                                                                                  | The browser never receives an API bearer or refresh token; PostgreSQL can revoke the session immediately.                                                                                                                                          |
| Browser frontend using an external OAuth/OIDC provider | Backend for Frontend (BFF) with tokens stored server-side and an opaque browser session cookie                                                    | The BFF acts as the confidential client and keeps access/refresh tokens out of browser JavaScript. Current browser-app guidance describes this pattern in [RFC 10017](https://www.rfc-editor.org/rfc/rfc10017.html#name-backend-for-frontend-bff). |
| Native/mobile application                              | Authorization Code with PKCE through the system browser, tokens in OS-protected storage, with rotation or sender-constraining                     | Native apps cannot safely hold a universal client secret; use the platform browser and protected key/token storage. See [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html).                                                                   |
| Public SPA with no backend component                   | Short access tokens plus rotating refresh tokens, strict browser hardening, and careful reuse handling; accept that XSS can still act as the user | This is possible but exposes more security-sensitive machinery to a public client. PKCE protects the authorization-code exchange, not tokens from malicious JavaScript already executing in the app.                                               |
| High-risk OAuth client able to protect key material    | Sender-constrained tokens using DPoP or mutual TLS                                                                                                | A stolen token alone is insufficient without proof of the bound key. [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) defines DPoP. This is far beyond Gatherly's current needs.                                                            |

For a future Gatherly browser frontend, the simplest robust upgrade would
usually be a normal server-side session rather than access-token plus
refresh-token machinery:

```text
browser receives:
  Set-Cookie: gatherly_session=<random opaque value>;
              HttpOnly; Secure; SameSite=Lax; Path=/

PostgreSQL stores:
  hash(session value), user_id, created_at, last_used_at,
  idle_expires_at, absolute_expires_at, revoked_at

each request:
  hash cookie -> load current session and user -> require both active

logout:
  revoke/delete session row -> expire cookie
```

This still requires CSRF analysis for state-changing requests because the
browser automatically sends cookies. `SameSite` is a useful layer, not the sole
defense; verify allowed origins and use a CSRF token where the deployment and
request shape require it.

#### If Gatherly later chooses rotating refresh tokens

Use short-lived access tokens plus opaque, database-backed refresh sessions.
Do not put the raw refresh token in PostgreSQL. A reasonable data shape is:

```text
auth_sessions
  id                  UUID primary key
  user_id             UUID foreign key
  family_id           UUID
  refresh_token_hash  bytea unique
  created_at          timestamptz
  last_used_at        timestamptz
  idle_expires_at     timestamptz
  absolute_expires_at timestamptz
  rotated_at          timestamptz nullable
  replaced_by_id      UUID nullable
  revoked_at          timestamptz nullable
  revocation_reason   text nullable
```

The refresh operation must be one PostgreSQL transaction:

```text
POST /auth/refresh
  -> read refresh credential from its protected transport/storage
  -> hash it before lookup
  -> SELECT session row FOR UPDATE
  -> reject revoked, idle-expired, or absolute-expired session
  -> if already rotated:
       revoke every active row in family_id (probable replay)
       reject with one safe authentication error
  -> create a cryptographically random replacement refresh token
  -> insert its hash as the next session row
  -> mark current row rotated and link replaced_by_id
  -> issue a new short-lived access token
  -> COMMIT
  -> return the new access token and replacement refresh credential
```

Generate at least 256 bits of randomness for an opaque refresh token, transmit
it only over TLS, compare hashes safely, and rate-limit refresh attempts. Give
the session both idle and absolute expiration. Rotate on every successful use;
never extend the absolute lifetime during rotation.

For a browser, a common arrangement is:

```text
access token:
  held only in application memory
  sent in Authorization header
  expires in roughly 5-15 minutes

refresh token:
  Secure + HttpOnly cookie
  narrow Path=/auth/refresh
  appropriate SameSite policy
  never returned in JSON and never stored in localStorage
```

The refresh endpoint must then defend against cross-site requests. Check the
expected `Origin`, choose an intentional `SameSite` policy, and add a CSRF token
when cross-site deployment requirements prevent a strict same-site design.

Rotation also needs an explicit client concurrency rule. For example, the
client can allow only one refresh request at a time and make other failed API
requests await it. The server may retain a very short, carefully designed grace
window for the immediately previous token, but that weakens strict replay
detection and must never become unlimited reuse. An atomic database exchange
plus single-flight client refresh is the clearer starting point.

Required tests would include:

- successful rotation invalidates the old token;
- replay of an old token revokes the whole family;
- two concurrent refreshes cannot both create valid successor chains;
- logout revokes the session;
- account suspension rejects both refresh and protected API requests;
- idle expiry and absolute expiry behave independently;
- a database failure midway leaves either the old session usable or the new
  session committed, never a half-rotated family;
- raw refresh tokens never appear in PostgreSQL, logs, URLs, or JSON error
  responses.

This is a good later vertical slice if persistent sign-in becomes a real
requirement. It is intentionally not smuggled into Phase 4 merely to make the
authentication feature look more complete.

## Step 1: Prove the Phase 3 baseline

Before changing authentication, prove that failures are not inherited from the
Prisma migration:

```powershell
yarn prisma:validate
yarn prisma:generate
yarn typecheck
yarn lint
yarn test:unit
yarn test:api
yarn test:integration
yarn test:e2e
yarn build
```

Docker must be running for database-backed tests. Preserve the architectural
boundary already learned in Phase 3:

| Work                                          | Persistence                   |
| --------------------------------------------- | ----------------------------- |
| Users and credentials                         | Prisma repository             |
| Communities, memberships, and ordinary events | Prisma repositories           |
| Reservation capacity and waitlist promotion   | raw `pg`, transactions, locks |

Authentication does not justify rewriting the reservation transaction.

## Step 2: Write the threat model before code

For this phase, defend against these concrete mistakes:

1. A client invents another user's ID.
2. A client changes a community, event, reservation, or target-user path ID.
3. A leaked or edited token is accepted without a valid signature.
4. An expired token remains usable.
5. A suspended account continues using an otherwise valid token.
6. A sign-in response reveals whether a username exists.
7. Repeated sign-in guesses are unlimited.
8. Repeated sign-up attempts consume hashing resources and create account spam.
9. Passwords, bearer tokens, or the `Authorization` header enter logs.
10. A moderator removes or demotes the community owner.
11. An organizer in community A manages an object in community B.

Authentication answers only:

> Which current user made this request?

Authorization separately answers:

> May this user perform this action on this exact object now?

Never turn `requireAuthenticatedUser` into a universal role checker. Community
roles live on memberships, so the service must query the membership associated
with the requested community.

## Step 3: Add credential and platform-role columns safely

The current `users` table predates authentication. Add a reviewed Prisma
migration instead of editing the Phase 2 baseline.

Update `User` in `prisma/schema.prisma`:

```prisma
model User {
  id              String                @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  username        String                @unique(map: "users_username_key")
  passwordHash    String                @map("password_hash")
  status          String                @default("ACTIVE")
  platformRole    String                @default("USER") @map("platform_role")
  createdAt       DateTime              @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime              @default(now()) @map("updated_at") @db.Timestamptz(6)
  lastLoginAt     DateTime?             @map("last_login_at") @db.Timestamptz(6)
  communitiesMade Community[]           @relation("CommunityCreator")
  eventsMade      Event[]               @relation("EventCreator")
  memberships     CommunityMembership[]
  reservations    Reservation[]
  waitlistEntries WaitlistEntry[]
  notifications   Notification[]
  idempotencyKeys IdempotencyKey[]

  @@map("users")
}
```

`platformRole` is stored now so the platform/community role distinction is
explicit. Do not build platform moderation endpoints in this phase. Community
permissions must still come from `community_memberships`.

Generate a migration without blindly accepting it:

```powershell
yarn db:migrate:dev --create-only --name add_minimal_auth
```

Prisma cannot invent passwords for the three existing development users. Edit
the generated migration to lock existing rows with an unrecognizable random
marker, then enforce `NOT NULL`:

1. Run the command above exactly once. It may warn that adding required
   `password_hash` is impossible with the three existing rows, but
   `--create-only` still creates a new, **unapplied** directory such as
   `prisma/migrations/20260806123000_add_minimal_auth/`.
2. Open that directory's `migration.sql`. Do **not** edit the already-applied
   `0_phase2_baseline` migration.
3. Replace the **entire contents** of that generated file with the complete SQL
   below. Do not keep unrelated generated foreign-key or default-value changes;
   this migration is only for the credential and platform-role columns. The
   initially nullable `password_hash` column lets PostgreSQL update Alice, Bob,
   and Carol before `NOT NULL` is enforced.
4. Save the migration, review it, and run `yarn db:migrate:dev` (without
   `--create-only`) to apply it. Do not rerun `--create-only` after the first
   command: Prisma will instead try to apply the still-unedited pending file.

```text
Existing development users are deliberately locked by this migration; they
cannot sign in yet. Step 13 replaces their marker values with real,
development-only Argon2id hashes through the explicit seed command.
```

### Recovering from an accidentally applied generated migration

If `yarn db:migrate:dev --create-only ...` was run a second time before you
replaced its SQL, Prisma may try the unsafe generated migration and report
`P3018` / `password_hash ... contains null values`. Do not assume all earlier
statements were rolled back: a Prisma SQL migration is not automatically one
PostgreSQL transaction. The generated file may already have dropped foreign
keys before reaching the failing statement.

First replace the migration file with the SQL below. Then run
`yarn db:migrate:dev` and read any drift report. If it reports foreign keys
removed from the Phase 2 tables, restore those exact constraints from
`0_phase2_baseline/migration.sql` after verifying there are no orphaned rows.
Do not accept a reset just to repair migration metadata or dropped constraints.

For this project, the unsafe generated migration may have removed these eleven
baseline constraints. After checking the child rows still reference existing
parents, restore them in one transaction:

```sql
BEGIN;

ALTER TABLE communities
  ADD CONSTRAINT communities_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES users(id);
ALTER TABLE community_memberships
  ADD CONSTRAINT community_memberships_community_id_fkey
  FOREIGN KEY (community_id) REFERENCES communities(id),
  ADD CONSTRAINT community_memberships_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE events
  ADD CONSTRAINT events_community_id_fkey
  FOREIGN KEY (community_id) REFERENCES communities(id),
  ADD CONSTRAINT events_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES users(id);
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE notifications
  ADD CONSTRAINT notifications_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE reservations
  ADD CONSTRAINT reservations_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES events(id),
  ADD CONSTRAINT reservations_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE waitlist_entries
  ADD CONSTRAINT waitlist_entries_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES events(id),
  ADD CONSTRAINT waitlist_entries_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id);

COMMIT;
```

After the physical schema again matches the baseline, mark the failed attempt
as rolled back only if Prisma still records it as failed, then apply the
corrected migration:

```powershell
# Use the exact directory name created on your machine.
yarn prisma migrate resolve --rolled-back 20260806123000_add_minimal_auth
yarn db:migrate:dev
```

Use `--rolled-back` only for a migration whose application failed. Never delete
the migration directory. Use `prisma migrate reset` only when you deliberately
choose to discard the entire disposable development database.

```sql
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
```

Why use a locked marker instead of a shared migration password?

- database migrations must not contain a usable shared credential;
- `gen_random_uuid()` is already required by the Phase 2 baseline, whereas
  `gen_random_bytes()` would add an undocumented dependency on `pgcrypto` and
  fail when Prisma builds its shadow database;
- old users cannot authenticate until a development seed explicitly gives
  them a development-only password;
- new sign-ups always receive a real Argon2id hash;
- the service can reject any stored value that is not an Argon2 encoding.

Review and apply:

```powershell
Get-Content prisma/migrations/*_add_minimal_auth/migration.sql
yarn db:migrate:dev
yarn prisma:generate
yarn prisma:validate
```

Do not log `passwordHash`, select it for normal user DTOs, or put it in a token.

## Step 4: Add and validate authentication configuration

Extend `.env.example`:

```dotenv
# Generate a different high-entropy value for each deployed environment.
JWT_SECRET=replace-with-at-least-32-random-characters
JWT_ISSUER=gatherly-api
JWT_AUDIENCE=gatherly-client
JWT_ACCESS_TOKEN_TTL_SECONDS=900

# Used only by the explicit development seed command, never by the server.
DEVELOPMENT_SEED_PASSWORD=replace-with-a-local-development-password
```

A project `.env` file supplies values for Compose interpolation; Docker Compose
does not automatically inject every entry into the application container. Add
the runtime authentication settings to `app.environment` in `compose.yaml`:

```yaml
JWT_SECRET: ${JWT_SECRET}
JWT_ISSUER: ${JWT_ISSUER:-gatherly-api}
JWT_AUDIENCE: ${JWT_AUDIENCE:-gatherly-client}
JWT_ACCESS_TOKEN_TTL_SECONDS: ${JWT_ACCESS_TOKEN_TTL_SECONDS:-900}
```

Add only the development seed credential to `app.environment` in
`compose.dev.yaml`:

```yaml
DEVELOPMENT_SEED_PASSWORD: ${DEVELOPMENT_SEED_PASSWORD}
```

This makes `docker compose -f compose.yaml -f compose.dev.yaml exec app yarn
db:seed` work without exposing the development seed credential in the base
production-style container. The running development server inherits the value
but never reads it; only `prisma/seed.ts` does.

Extend `src/config/env.ts`:

```ts
const environmentSchema = z.object({
  // Keep the existing fields.
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default('gatherly-api'),
  JWT_AUDIENCE: z.string().min(1).default('gatherly-client'),
  JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
});
```

The real file should retain every existing PostgreSQL, Prisma, CORS, port, and
pool field; the snippet shows only the additions.

Generate a secret without printing it into source control. One local option is:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Put the result in the untracked `.env`. Do not use the `.env.example` placeholder
as a real secret. Do not log parsed environment configuration wholesale.

## Step 5: Define identity-owned types and boundary schemas

Create `src/modules/identity/identity.types.ts`:

```ts
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';
export type PlatformRole = 'USER' | 'PLATFORM_MODERATOR' | 'PLATFORM_ADMIN';

export interface PublicUser {
  id: string;
  username: string;
  status: UserStatus;
  platformRole: PlatformRole;
  createdAt: Date;
}

export interface CredentialUser extends PublicUser {
  passwordHash: string;
}

export type AuthenticatedUser = PublicUser;

export interface SignUpInput {
  username: string;
  password: string;
}

export interface SignInInput {
  username: string;
  password: string;
}

export interface AuthenticationResult {
  user: PublicUser;
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}
```

Create `src/modules/identity/identity.schemas.ts`:

```ts
import { z } from 'zod';

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,30}$/);

const passwordSchema = z.string().min(12).max(128);

const credentialsSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export const signUpRequestSchema = z.object({
  body: credentialsSchema,
  params: z.object({}),
  query: z.object({}),
});

export const signInRequestSchema = z.object({
  body: credentialsSchema,
  params: z.object({}),
  query: z.object({}),
});

export type SignUpRequest = z.infer<typeof signUpRequestSchema>;
export type SignInRequest = z.infer<typeof signInRequestSchema>;
```

The upper password bound limits accidental or malicious hashing work. Do not
trim, lowercase, normalize, or log passwords. Username normalization is safe
because the product defines usernames as lowercase ASCII identifiers and the
database already enforces the same format.

## Step 6: Isolate Argon2id in infrastructure

The identity module keeps only its six standard file roles. The concrete
third-party adapter belongs under infrastructure and does not import from the
identity module. `IdentityService` will describe the small shape it needs;
TypeScript's structural typing connects the two at the composition root.

Create `src/infrastructure/security/argon2-password-hasher.ts`:

```ts
import argon2 from 'argon2';

const options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export class Argon2PasswordHasher {
  public hash(password: string): Promise<string> {
    return argon2.hash(password, options);
  }

  public async verify(passwordHash: string, password: string): Promise<boolean> {
    if (!passwordHash.startsWith('$argon2id$')) return false;

    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}
```

The selected parameters match the practical OWASP minimum Argon2id profile of
19 MiB memory, two iterations, and one lane. Benchmark on the eventual host
before production use; stronger parameters are useful only when the server can
afford them. The stored encoding contains the salt and parameters, so no
separate salt column is needed.

`verify()` receives no hashing-options object. Argon2 reads its algorithm and
cost parameters from the encoded hash, and the package's `VerifyOptions` type
does not accept the hashing-options object.

The `startsWith` check makes the migration's `locked:` values safely
unverifiable. Catch only inside this credential comparison boundary: a damaged
hash means invalid credentials, not a 500 containing storage details.

## Step 7: Isolate JWT handling in infrastructure

JWT signing and verification wrap another third-party package, so they also do
not belong in an extra identity-module file. Create
`src/infrastructure/security/jwt-access-tokens.ts`:

```ts
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';

import { AppError } from '../../shared/errors/app-error.js';

interface AccessTokenConfiguration {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

const tokenPayloadSchema = z.object({
  sub: z.uuid(),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  iat: z.number().int(),
});

export class JwtAccessTokens {
  public constructor(private readonly configuration: AccessTokenConfiguration) {}

  public sign(userId: string): string {
    return jwt.sign({}, this.configuration.secret, {
      algorithm: 'HS256',
      subject: userId,
      issuer: this.configuration.issuer,
      audience: this.configuration.audience,
      expiresIn: this.configuration.ttlSeconds,
    });
  }

  public verify(token: string): string {
    let decoded: string | JwtPayload;

    try {
      decoded = jwt.verify(token, this.configuration.secret, {
        algorithms: ['HS256'],
        issuer: this.configuration.issuer,
        audience: this.configuration.audience,
      });
    } catch {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
    }

    const result = tokenPayloadSchema.safeParse(decoded);
    if (!result.success) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
    }

    return result.data.sub;
  }
}
```

Important properties:

- `algorithms: ['HS256']` prevents accepting an unintended algorithm;
- issuer and audience prevent a valid token from another application context
  being accepted here;
- `exp` is checked by `jsonwebtoken`;
- the payload schema rejects a missing or non-UUID subject;
- username, account status, and roles are deliberately absent from the token.

The token is signed, not encrypted. Anyone holding it may decode its payload,
which is another reason to include only the opaque user ID.

## Step 8: Build the Prisma identity repository

Create `src/modules/identity/identity.repository.ts`:

```ts
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

import { AppError } from '../../shared/errors/app-error.js';
import type {
  AuthenticatedUser,
  CredentialUser,
  PlatformRole,
  PublicUser,
  UserStatus,
} from './identity.types.js';

const publicUserSelection = {
  id: true,
  username: true,
  status: true,
  platformRole: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

const mapPublicUser = (record: {
  id: string;
  username: string;
  status: string;
  platformRole: string;
  createdAt: Date;
}): PublicUser => ({
  ...record,
  status: record.status as UserStatus,
  platformRole: record.platformRole as PlatformRole,
});

export class IdentityRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async create(username: string, passwordHash: string): Promise<PublicUser> {
    try {
      const user = await this.prisma.user.create({
        data: { username, passwordHash },
        select: publicUserSelection,
      });
      return mapPublicUser(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'USERNAME_TAKEN', 'That username is unavailable');
      }
      throw error;
    }
  }

  public async findCredentialsByUsername(username: string): Promise<CredentialUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: { ...publicUserSelection, passwordHash: true },
    });
    return user === null ? null : { ...mapPublicUser(user), passwordHash: user.passwordHash };
  }

  public async findAuthenticatedById(userId: string): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: publicUserSelection,
    });
    if (user === null || user.status !== 'ACTIVE') return null;
    return mapPublicUser(user);
  }

  public async recordSuccessfulLogin(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
      select: { id: true },
    });
  }
}
```

The credential query is the only normal application query that selects
`passwordHash`. The authenticated-user query reads current status and role from
PostgreSQL and does not return the hash.

## Step 9: Implement identity use cases

Create `src/modules/identity/identity.service.ts`:

```ts
import { AppError } from '../../shared/errors/app-error.js';
import type { IdentityRepository } from './identity.repository.js';
import type {
  AuthenticatedUser,
  AuthenticationResult,
  PublicUser,
  SignInInput,
  SignUpInput,
} from './identity.types.js';

interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

interface AccessTokens {
  sign(userId: string): string;
  verify(token: string): string;
}

// This is a valid hash for an irrelevant password. It is public on purpose and
// exists only to make an unknown username perform one Argon2 verification.
const dummyPasswordHash =
  '$argon2id$v=19$m=19456,p=1,t=2$NRVdMqrctPeU3C/oSliwcg$' +
  'SnjAx/RqJtCJioymG850l8ukZGfBJ0f+PYt4zGvIFII';

export class IdentityService {
  public constructor(
    private readonly repository: IdentityRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly accessTokens: AccessTokens,
    private readonly accessTokenTtlSeconds: number,
  ) {}

  private createResult(user: PublicUser): AuthenticationResult {
    return {
      user,
      accessToken: this.accessTokens.sign(user.id),
      tokenType: 'Bearer',
      expiresIn: this.accessTokenTtlSeconds,
    };
  }

  public async signUp(input: SignUpInput): Promise<AuthenticationResult> {
    const passwordHash = await this.passwordHasher.hash(input.password);
    const user = await this.repository.create(input.username, passwordHash);
    return this.createResult(user);
  }

  public async signIn(input: SignInInput): Promise<AuthenticationResult> {
    const user = await this.repository.findCredentialsByUsername(input.username);
    const passwordMatches = await this.passwordHasher.verify(
      user?.passwordHash ?? dummyPasswordHash,
      input.password,
    );

    if (user === null || !passwordMatches) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect');
    }
    if (user.status !== 'ACTIVE') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account cannot sign in');
    }

    await this.repository.recordSuccessfulLogin(user.id);
    return this.createResult(user);
  }

  public async authenticateAccessToken(token: string): Promise<AuthenticatedUser> {
    const userId = this.accessTokens.verify(token);
    const user = await this.repository.findAuthenticatedById(userId);
    if (user === null) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
    }
    return user;
  }
}
```

The dummy hash reduces the most obvious timing difference between “unknown
username” and “wrong password.” The external error remains identical. Do not
claim this makes all timing perfectly equal; rate limiting and monitoring are
still needed.

Account status is checked after a correct password so arbitrary callers cannot
use the status response to enumerate registered usernames. Protected requests
map an inactive or missing current user to the same generic 401 as an invalid
token.

## Step 10: Add controller, DTO, rate limit, and routes

Create `src/modules/identity/identity.controller.ts`:

```ts
import type { RequestHandler } from 'express';

import { getAuthenticatedUser } from '../../shared/auth/authentication.middleware.js';
import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { SignInRequest, SignUpRequest } from './identity.schemas.js';
import type { IdentityService } from './identity.service.js';
import type { AuthenticationResult, PublicUser } from './identity.types.js';

const toPublicUserDto = (user: PublicUser) => ({
  id: user.id,
  username: user.username,
  status: user.status,
  platformRole: user.platformRole,
  createdAt: user.createdAt.toISOString(),
});

const toAuthenticationDto = (result: AuthenticationResult) => ({
  data: {
    user: toPublicUserDto(result.user),
    accessToken: result.accessToken,
    tokenType: result.tokenType,
    expiresIn: result.expiresIn,
  },
});

export class IdentityController {
  public constructor(private readonly service: IdentityService) {}

  public readonly signUp: RequestHandler = async (_request, response) => {
    const { body } = getValidated<SignUpRequest>(response);
    response.status(201).json(toAuthenticationDto(await this.service.signUp(body)));
  };

  public readonly signIn: RequestHandler = async (_request, response) => {
    const { body } = getValidated<SignInRequest>(response);
    response.json(toAuthenticationDto(await this.service.signIn(body)));
  };

  public readonly me: RequestHandler = (_request, response) => {
    response.json({ data: { user: toPublicUserDto(getAuthenticatedUser(response)) } });
  };
}
```

Create `src/modules/identity/identity.routes.ts`:

```ts
import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { AppError } from '../../shared/errors/app-error.js';
import { validate } from '../../shared/validation/validate.middleware.js';
import type { IdentityController } from './identity.controller.js';
import { signInRequestSchema, signUpRequestSchema } from './identity.schemas.js';

const signInLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_request, _response, next) => {
    next(new AppError(429, 'SIGN_IN_RATE_LIMITED', 'Try signing in again later'));
  },
});

const signUpLimiter = rateLimit({
  windowMs: 60 * 60 * 1_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_request, _response, next) => {
    next(new AppError(429, 'SIGN_UP_RATE_LIMITED', 'Try creating an account again later'));
  },
});

export const createIdentityRouter = (
  controller: IdentityController,
  requireAuthenticatedUser: RequestHandler,
): Router => {
  const router = Router();
  router.post('/sign-up', signUpLimiter, validate(signUpRequestSchema), controller.signUp);
  router.post('/sign-in', signInLimiter, validate(signInRequestSchema), controller.signIn);
  router.get('/me', requireAuthenticatedUser, controller.me);
  return router;
};
```

Sign-up and sign-in use separate buckets because they defend different costs:
sign-up limits expensive hashing plus durable account creation, while sign-in
limits credential guessing. The in-memory limiters are enough for one-process
Phase 4. They are not durable and do not coordinate multiple application
replicas. Redis rate limiting belongs to its later phase, when there is a real
multi-instance need.

`GET /auth/me` does not query PostgreSQL a second time. The authentication
middleware has already verified the token and loaded the current active user;
the controller serializes that value from `response.locals`.

Do not set Express `trust proxy` casually. Behind the future Nginx deployment,
configure the exact trusted proxy topology before relying on forwarded client
addresses; otherwise IP-based limiting can group all users or trust spoofed
headers.

## Step 11: Replace temporary identity middleware

Delete `src/shared/http/request-user.middleware.ts` after every import has been
replaced. Create `src/shared/auth/authentication.middleware.ts`:

```ts
import type { RequestHandler, Response } from 'express';

import type { IdentityService } from '../../modules/identity/identity.service.js';
import type { AuthenticatedUser } from '../../modules/identity/identity.types.js';
import { AppError } from '../errors/app-error.js';

const readBearerToken = (authorization: string | undefined): string => {
  if (authorization === undefined) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
  }

  const [scheme, token, extra] = authorization.split(' ');
  if (scheme !== 'Bearer' || token === undefined || token === '' || extra !== undefined) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
  }
  return token;
};

export const createRequireAuthenticatedUser = (
  identityService: IdentityService,
): RequestHandler => {
  return async (request, response, next) => {
    try {
      const token = readBearerToken(request.headers.authorization);
      response.locals['authenticatedUser'] = await identityService.authenticateAccessToken(token);
      next();
    } catch (error) {
      next(error);
    }
  };
};

export const getAuthenticatedUser = (response: Response): AuthenticatedUser => {
  const user: unknown = response.locals['authenticatedUser'];
  if (typeof user !== 'object' || user === null || !('id' in user) || typeof user.id !== 'string') {
    throw new AppError(500, 'INTERNAL_ERROR', 'Authentication middleware was not applied');
  }
  return user as AuthenticatedUser;
};
```

Express 5 forwards rejected promises, but the explicit `try/catch` makes this
middleware's error flow obvious and remains safe if its implementation later
changes. Never attach the password hash or raw token to `response.locals`.

Update protected controllers. For example, in
`communities.controller.ts`:

```ts
import { getAuthenticatedUser } from '../../shared/auth/authentication.middleware.js';

// Inside create:
const community = await this.service.create(getAuthenticatedUser(response).id, body);
```

Apply the same replacement in memberships, events, and reservations. Services
continue receiving a plain user ID; they do not depend on Express or JWT types.

Update router factories to accept the middleware instead of importing a global
instance:

```ts
import type { RequestHandler } from 'express';

export const createCommunitiesRouter = (
  controller: CommunitiesController,
  requireAuthenticatedUser: RequestHandler,
): Router => {
  const router = Router();
  router.post(
    '/',
    requireAuthenticatedUser,
    validate(createCommunityRequestSchema),
    controller.create,
  );
  router.get('/', validate(listCommunitiesRequestSchema), controller.list);
  router.get('/:communityId', validate(getCommunityRequestSchema), controller.get);
  return router;
};
```

Make the equivalent signature change to all protected module routers. Passing
the middleware from the composition root makes the dependency visible and lets
tests use the real authentication path.

Audit until no runtime trust remains:

```powershell
rg -n "x-user-id|requireRequestUser|getRequestUserId" src tests docs README.md
```

After test and documentation migration, this command should return no matches
except historical handbooks that explicitly describe the old phase.

## Step 12: Wire identity in the application and server

Add the identity router to `AppDependencies` in `src/app.ts`:

```ts
export interface AppDependencies {
  // Existing configuration, logger, readiness, and module routers.
  identityRouter: Router;
}

// Public auth endpoints are mounted before the API modules.
app.use('/auth', dependencies.identityRouter);
app.use('/api/communities', dependencies.communitiesRouter);
```

In `src/server.ts`, compose one shared identity service and one authentication
middleware:

```ts
import { createRequireAuthenticatedUser } from './shared/auth/authentication.middleware.js';
import { JwtAccessTokens } from './infrastructure/security/jwt-access-tokens.js';
import { IdentityController } from './modules/identity/identity.controller.js';
import { IdentityRepository } from './modules/identity/identity.repository.js';
import { createIdentityRouter } from './modules/identity/identity.routes.js';
import { IdentityService } from './modules/identity/identity.service.js';
import { Argon2PasswordHasher } from './infrastructure/security/argon2-password-hasher.js';

const accessTokens = new JwtAccessTokens({
  secret: environment.JWT_SECRET,
  issuer: environment.JWT_ISSUER,
  audience: environment.JWT_AUDIENCE,
  ttlSeconds: environment.JWT_ACCESS_TOKEN_TTL_SECONDS,
});
const identityRepository = new IdentityRepository(prisma);
const identityService = new IdentityService(
  identityRepository,
  new Argon2PasswordHasher(),
  accessTokens,
  environment.JWT_ACCESS_TOKEN_TTL_SECONDS,
);
const requireAuthenticatedUser = createRequireAuthenticatedUser(identityService);
const identityRouter = createIdentityRouter(
  new IdentityController(identityService),
  requireAuthenticatedUser,
);

const communitiesRouter = createCommunitiesRouter(
  new CommunitiesController(communitiesService),
  requireAuthenticatedUser,
);
// Pass the same middleware to memberships, events, and reservations routers.

const app = createApp({
  // Existing dependencies.
  identityRouter,
  communitiesRouter,
  membershipsRouter,
  eventsRouter,
  reservationsRouter,
});
```

Identity uses the existing Prisma client. Do not create another database client,
connection pool, or token singleton inside a controller.

The middleware performs a user lookup, so PostgreSQL/Prisma readiness already
covers authentication readiness. Graceful shutdown remains responsible for the
same Prisma client and raw reservation pool.

## Step 13: Make development seed users sign-in capable

The migration intentionally locks existing users. Update `prisma/seed.ts` to
hash an explicit development-only password:

```ts
import argon2 from 'argon2';

const developmentPassword = process.env['DEVELOPMENT_SEED_PASSWORD'];
if (developmentPassword === undefined || developmentPassword.length < 12) {
  throw new Error('DEVELOPMENT_SEED_PASSWORD of at least 12 characters is required');
}

const passwordHash = await argon2.hash(developmentPassword, {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

for (const user of users) {
  await prisma.user.upsert({
    where: { username: user.username },
    update: { status: 'ACTIVE', passwordHash },
    create: { ...user, status: 'ACTIVE', passwordHash },
  });
}
```

Place the hashing inside the existing `seed` async function; top-level code is
shown compactly. One shared password is acceptable only for deterministic local
seed accounts. Never run that seed against a real-user database.

Run:

```powershell
yarn db:seed
```

The legacy `db/seeds/development.sql` is still used by the current test harness.
Update its inserts to include a fixed test-only Argon2id hash, for example the
hash below represents `GatherlyTest123!` only in disposable tests:

```sql
INSERT INTO users (id, username, password_hash)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'alice',
   '$argon2id$v=19$m=19456,p=1,t=2$9qk3VP0ZfcpgZ/SaLqEN0A$dRZ8d6H5BM8cD+6HLaqaZDC9nzIBDywpqehIQc5GmZ0'),
  ('00000000-0000-4000-8000-000000000002', 'bob',
   '$argon2id$v=19$m=19456,p=1,t=2$9qk3VP0ZfcpgZ/SaLqEN0A$dRZ8d6H5BM8cD+6HLaqaZDC9nzIBDywpqehIQc5GmZ0'),
  ('00000000-0000-4000-8000-000000000003', 'carol',
   '$argon2id$v=19$m=19456,p=1,t=2$9qk3VP0ZfcpgZ/SaLqEN0A$dRZ8d6H5BM8cD+6HLaqaZDC9nzIBDywpqehIQc5GmZ0')
ON CONFLICT (id) DO UPDATE
SET username = EXCLUDED.username,
    password_hash = EXCLUDED.password_hash,
    status = 'ACTIVE';
```

This hash is not a secret. Its purpose is stable, fast test setup. Production
passwords are always independently salted by Argon2.

## Step 14: Update all tests for authentication (AI-assisted)

This is a separate implementation step and is suitable to delegate to AI after
Steps 3-13 compile. Ask it to preserve the existing behavioral assertions, not
merely make the suite green.

Required changes:

- build the real identity service and bearer middleware in `createTestApp`;
- add `signInAs(app, username)` and `authorize(token)` test helpers;
- replace every API/E2E `x-user-id` header with a real bearer token;
- sign users in before starting reservation concurrency races;
- keep repository integration tests using direct fixture IDs;
- add identity API coverage for sign-up, sign-in, `GET /auth/me`, validation,
  duplicate username, invalid credentials, inactive accounts, and both rate
  limiters;
- prove `/auth/me` returns the current database-backed user for a valid token
  and returns 401 for missing, malformed, expired, or now-inactive users;
- cover missing, malformed, forged, wrong-issuer, wrong-audience, and expired
  tokens;
- prove an issued token stops working after account suspension;
- retain all reservation/waitlist concurrency and idempotency assertions.

Use a fixed test-only JWT secret and the disposable seed password
`GatherlyTest123!`. Never bypass middleware by writing directly to
`response.locals`.

Minimum helper shape:

```ts
export const signInAs = async (app: Express, username: string): Promise<string> => {
  const response = await request(app).post('/auth/sign-in').send({
    username,
    password: 'GatherlyTest123!',
  });
  if (response.status !== 200) throw new Error(`Test sign-in failed: ${response.status}`);
  return (response.body as { data: { accessToken: string } }).data.accessToken;
};

export const authorize = (token: string): string => `Bearer ${token}`;
```

## Step 15: Keep authorization in services and object-specific

The current event creation flow already has the correct shape:

```ts
const authorization = await repository.findCreationAuthorization(communityId, actorId);

if (authorization?.communityStatus !== 'ACTIVE') {
  throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'The requested community does not exist');
}
if (
  authorization.membershipStatus !== 'ACTIVE' ||
  authorization.role === null ||
  !creationRoles.has(authorization.role)
) {
  throw new AppError(403, 'COMMUNITY_PERMISSION_DENIED', 'You cannot create events here');
}
```

Retain this after JWT migration. The authenticated ID replaces only the
temporary header; it does not replace membership authorization.

Use this permission table for Phase 4 behavior:

| Action                          | Required current state                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Create community                | active platform account                                                                     |
| Join open community             | active account, active/open community, not banned/suspended                                 |
| Leave community                 | actor's own active non-owner membership                                                     |
| Create community event          | active membership with OWNER/ORGANIZER/MODERATOR in that exact community                    |
| Reserve or waitlist             | active account and ACTIVE membership in event's exact community                             |
| Read `/me` reservation/waitlist | row must belong to authenticated user                                                       |
| Manage members                  | active sufficiently privileged membership in exact community; never improperly target OWNER |

Do not accept any `userId`, `createdByUserId`, role, account status, or ownership
field from a request body. The actor comes from authentication; the target comes
from a validated path where the endpoint genuinely manages another member.

The following tests are mandatory before completing the phase:

1. Bob is `ORGANIZER` in community A but cannot create an event in community B.
2. A `MEMBER`, `LEFT`, `SUSPENDED`, or `BANNED` membership cannot create events.
3. A banned membership cannot reserve even with a valid account token.
4. Alice cannot read or cancel Bob's reservation by changing an ID or using a
   route intended for the current caller.
5. An archived/suspended community is not manageable.
6. If member management is exposed, a moderator cannot remove, suspend, ban,
   or demote the owner.
7. A user's valid token stops working after account suspension.

Prefer 404 where revealing the existence of a private cross-community object
would leak information. Use 403 where the object is already safely known and
the denial itself is not sensitive. Apply the rule consistently.

## Step 16: Add owner-safe membership management before exposing it

The README lists member-management endpoints, but the current Phase 3 code has
only join and leave. If Phase 4 adds `PATCH
/api/communities/:communityId/members/:userId`, define and test the policy before
wiring the route.

Do not add a standalone policy function or management types while that endpoint
is absent. They would have no caller and would be speculative dead code.

The default Phase 4 path is therefore to defer member management and skip the
rest of this step. The owner-protection invariant becomes mandatory when a
member-management endpoint is actually introduced.

If you intentionally include the endpoint now, implement it as one complete
vertical slice using only the existing six membership files:

1. Add the request/response and policy shapes to `memberships.types.ts` and the
   untrusted request validator to `memberships.schemas.ts`.
2. Add the owner-safe authorization rule and management use case to
   `memberships.service.ts`; the use case must call the rule.
3. Add a repository operation that loads actor and target from the same
   community and keeps authorization plus update inside one transaction.
4. Add the controller method and protected route only after the transactional
   use case exists.
5. Add unit, repository/integration, and API tests in the same change.

This intentionally does not transfer ownership. Add a separate, transactionally
safe ownership-transfer use case only when the product needs it.

The repository operation must load the actor and target by the same
`communityId`, lock or otherwise recheck their current rows in one transaction,
invoke the policy on that current state, and then update the target. Do not do:

```text
authorize actor -> transaction ends -> permission changes -> update target
```

For Prisma, an interactive `Serializable` transaction with bounded retry is a
reasonable implementation. A raw `SELECT ... FOR UPDATE` is also justified for
this authorization race, just as raw SQL remains justified for reservations.
The service owns the policy; the repository owns transaction mechanics. Never
ship the route with a non-atomic “read roles, later update” gap.

The complete slice must include a unit test proving a moderator cannot act on
the owner. Then add an API test where the moderator is valid in community A but the target
owner ID belongs to community B. The exact-community query must return not found
or denied and must not modify either membership.

If member-management endpoints are deferred, do not create policy types,
unused functions, empty routes, or placeholder tests in Phase 4. The skipped
real-user MVP milestone and the new Phase 5 hardening work do not implicitly
add this product feature; implement it only when explicitly requested.

## Step 17: Verify logging and HTTP security boundaries

The current development Morgan format does not need request headers. Keep it
that way. Pino should never serialize a complete Express request object or all
headers. If structured request logging later includes headers, configure
redaction before enabling it:

```ts
const logger = pino({
  redact: {
    paths: [
      'req.headers.authorization',
      'request.headers.authorization',
      'headers.authorization',
      'password',
      '*.password',
      '*.passwordHash',
    ],
    censor: '[REDACTED]',
  },
});
```

Adapt paths to the actual logged object rather than copying a list that never
matches. Add a logger test if request bodies or headers are logged anywhere.

Helmet remains enabled. CORS still controls which browser origins may read the
API; it is not an authentication defense. Because this phase uses an
`Authorization` header rather than an automatically attached cookie, a CSRF
token is not part of this design. If authentication later moves to cookies,
revisit `SameSite`, `Secure`, origin checks, and CSRF as one coherent change.

Never place access tokens in URLs, query parameters, logs, local error details,
or OpenAPI examples containing a real token.

## Step 18: Update OpenAPI (AI-assisted)

Treat OpenAPI as a separate step after the routes and tests are stable. It is
suitable to delegate to AI, followed by a quick contract review.

Required changes in `docs/openapi.yaml` and its module source files:

- add `POST /auth/sign-up`, `POST /auth/sign-in`, and protected `GET /auth/me`;
- add credential, public-user, and authentication-response schemas;
- add an HTTP bearer `bearerAuth` security scheme;
- apply bearer security to every protected operation;
- keep health and existing public discovery operations public;
- remove the temporary `RequestUserId`/`x-user-id` parameter;
- document 400, 401, 403, 409, and 429 responses where applicable;
- never include a real password or token in examples.

## Step 19: Update README and run a manual smoke test

Update README to remove temporary-header instructions, document JWT environment
variables, describe sign-up/sign-in, state that refresh/recovery flows are
deliberately absent, and link this handbook. Keep the no-email boundary.

Then sign in as a development seed user, call `GET /auth/me`, and call one
protected domain endpoint with `Authorization: Bearer <token>`. Do not save the
real password or response token in documentation or shell history shared with
others.

## Step 20: Run security-focused failure drills

Perform these drills against disposable test infrastructure:

### Edited token

Change one character in a valid token. The protected endpoint must return 401
and perform no domain write.

### Wrong issuer or audience

Sign a token with the correct secret but a different issuer or audience. It must
still return 401.

### Expired token

Use an already-expired test token. It must return 401; do not add clock sleeps to
the suite.

### Suspended account after token issue

Sign in, suspend the user directly in the disposable database, then reuse the
token. It must fail immediately because middleware reloads current state.

### Banned community membership

Sign in with an active platform account whose exact membership is `BANNED`.
Event creation, restricted reads, reservation, and waitlist actions must fail
without changing reservation or waitlist tables.

### Cross-community substitution

Give the actor a privileged role in community A and request an event/member
operation using community B's ID. The service must authorize B, not merely find
some privileged membership for the actor.

### Owner target substitution

Attempt member management as a moderator with the owner's user ID in the path.
The owner row must remain unchanged. Repeat with an owner ID from another
community to catch loose user-only target queries.

### Database unavailable

A cryptographically valid token is not enough when current user state cannot be
loaded. The request may return the standard safe 500/availability error, but it
must not proceed under cached or assumed authority. Readiness should report
not-ready while PostgreSQL is unavailable.

### Log inspection

Run sign-up, failed sign-in, successful sign-in, and one protected request.
Inspect logs and confirm that passwords, password hashes, bearer tokens, and
complete authorization headers are absent.

## Step 21: Run the complete quality gate

Run focused checks while working, then the complete gate:

```powershell
yarn prisma:validate
yarn prisma:generate
yarn typecheck
yarn lint
yarn format:check
yarn test:unit
yarn test:api
yarn test:integration
yarn test:e2e
yarn build
```

Also audit the migration and removed temporary boundary:

```powershell
yarn db:migrate:status
rg -n "x-user-id|requireRequestUser|getRequestUserId" src tests docs README.md
rg -n "passwordHash|password_hash|authorization" src
git diff --check
```

Interpret the last search manually. Expected password-hash occurrences are the
identity repository, hasher boundary, Prisma schema, and carefully redacted
logging configuration. A controller DTO, log call, token payload, or unrelated
module selecting it is a defect.

Database-backed tests must still prove the final-place reservation race and
atomic waitlist promotion. Authentication work is incomplete if it quietly
weakens those Phase 2 guarantees.

## Step 22: Phase completion examination

You should be able to answer and demonstrate all of these without reading the
implementation:

1. Why is `x-user-id` not authentication?
2. What does Argon2 store, and why is a separate salt column unnecessary here?
3. Why does an unknown username still perform one password-hash verification?
4. Why are invalid username and password responses identical?
5. Which exact JWT properties are verified?
6. Why does the token contain a user ID but not community roles?
7. How does an already-issued token stop working after account suspension?
8. Why is CORS not authentication?
9. Why is authentication middleware not the right place to authorize an event?
10. How does the event query prevent cross-community organizer substitution?
11. If member management was implemented, how is the community owner protected
    from a moderator inside the same transaction as the update?
12. Why does `/reservations/me` not accept a user ID from the client?
13. Which identity queries use Prisma, and why do reservations still use raw
    `pg`?
14. What does the in-memory sign-in limiter fail to coordinate?
15. Why are refresh tokens and password recovery absent?
16. Which logs and DTOs were checked for credential leakage?
17. Which tests prove the difference between a valid account and current
    object-level permission?

Phase 4 is complete when the answers are reflected in passing behavioral tests,
not merely when sign-in returns a token.

## Suggested commit sequence

Keep commits reviewable:

1. `docs: add phase 4 minimal auth handbook`
2. `db: add user credential and platform role fields`
3. `feat: add argon2 and JWT security adapters`
4. `feat: add sign-up and sign-in identity slice`
5. `feat: replace temporary request user header with bearer auth`
6. `test: migrate API and lifecycle tests to authenticated users`
7. `test: add object-level authorization cases` (include owner protection only
   when member management is implemented)
8. `docs: document phase 4 auth contract and setup`

Do not force this sequence if a smaller coherent set is safer, but keep schema,
generated client, repository code, and affected tests together when splitting
them would leave a broken commit.

## Common mistakes

| Mistake                                                 | Why it is wrong                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Put username/password in a JWT                          | Credentials must never be token payload data.                                             |
| Put community roles in a 15-minute token and trust them | Revocation/demotion is delayed and roles are object-specific.                             |
| Decode without verifying                                | Anyone can construct the payload.                                                         |
| Accept any JWT algorithm                                | It broadens the verification boundary unexpectedly.                                       |
| Return “username not found”                             | It enables account enumeration.                                                           |
| Hash in a controller                                    | Credential rules become coupled to HTTP and harder to test.                               |
| Query Prisma from middleware everywhere                 | Authentication should use the identity service/repository boundary.                       |
| Authorize only by endpoint role                         | It misses the exact community/event/target object.                                        |
| Accept `userId` for `/me` routes                        | It reintroduces client-controlled identity.                                               |
| Add refresh tokens “for completeness”                   | It expands storage, rotation, replay, and revocation work outside scope.                  |
| Use a shared password in a migration                    | Every migrated account becomes immediately compromised.                                   |
| Log request headers or bodies wholesale                 | Tokens and passwords leak into durable logs.                                              |
| Rewrite reservation locking in Prisma                   | Authentication does not change the proven concurrency boundary.                           |
| Use only mocked auth tests                              | Signature verification, middleware order, DB state, and real HTTP wiring remain unproved. |

## Reference reading

When checking library behavior, prefer the installed package types and primary
documentation for:

- Node.js `crypto` and environment handling;
- `argon2` password hashing and the OWASP Password Storage Cheat Sheet;
- `jsonwebtoken` signing and verification options;
- Express 5 middleware/error behavior;
- `express-rate-limit` configuration and proxy guidance;
- Prisma unique-error handling and interactive transactions;
- RFC 6750 bearer-token usage;
- the OpenAPI bearer security scheme.

Library APIs and security guidance can change. Verify details against the
versions locked in `yarn.lock` when implementing this handbook.

## Appendix: Hashing algorithms and why Gatherly uses Argon2id

“Hashing” covers several different jobs. Choosing an algorithm starts by asking
what is being protected:

```text
ordinary data integrity       -> fast cryptographic hash
message authenticity          -> keyed MAC such as HMAC
password storage              -> deliberately slow password KDF
hash-table/checksum speed      -> non-cryptographic hash
```

These families are not interchangeable. A secure fast file hash can be a poor
password hash precisely because attackers can calculate billions of guesses
quickly.

### Properties worth knowing

A cryptographic hash maps arbitrary input to a fixed-size digest. Important
properties are:

- **preimage resistance:** given a digest, finding an input that produces it is
  infeasible;
- **second-preimage resistance:** given one input, finding a different input
  with the same digest is infeasible;
- **collision resistance:** finding any two different inputs with the same
  digest is infeasible;
- **avalanche behavior:** a small input change drastically changes the digest.

Password hashing adds tunable work. Modern password KDFs are intentionally
expensive in CPU, memory, or both, slowing every offline guess after a database
leak.

### General-purpose cryptographic hashes

#### MD5

MD5 produces a 128-bit digest and is extremely fast. Practical collision attacks
have broken it. It must not be used for signatures, certificates, security
integrity decisions, or password storage. It remains useful only where accidental
corruption detection and compatibility matter and no adversary can choose the
input; even there, a modern checksum is usually clearer.

#### SHA-1

SHA-1 produces a 160-bit digest. Practical chosen-prefix collisions have broken
its collision resistance. It is obsolete for new security designs and is not a
password hash.

#### SHA-2: SHA-256 and SHA-512

SHA-2 is the widely deployed family containing SHA-224, SHA-256, SHA-384, and
SHA-512. SHA-256 and SHA-512 remain secure general-purpose cryptographic hashes
when used correctly. They are excellent for file integrity, content addressing,
digital-signature preprocessing, and constructions such as HMAC.

Plain `SHA-256(password)` is bad password storage. SHA-256 is designed to be
fast, so GPUs and specialized hardware can test enormous password dictionaries.
Adding one salt prevents rainbow-table reuse but does not make each guess
expensive enough.

#### SHA-3

SHA-3 is based on the Keccak sponge construction rather than SHA-2's design. It
provides SHA3-224/256/384/512 plus extendable-output functions such as SHAKE.
It is a strong general-purpose alternative and useful for design diversity, but
it is still fast and therefore not a password-storage function by itself.

#### BLAKE2

BLAKE2b and BLAKE2s are modern, fast cryptographic hashes with optional keyed
operation. They often outperform older hashes in software and are useful for
integrity and authentication constructions. Their speed is a benefit for files
and protocols but a disadvantage for direct password hashing.

#### BLAKE3

BLAKE3 is a newer tree-based hash designed for high performance, parallelism,
streaming, keyed hashing, and extendable output. It is excellent for fast content
hashing but deliberately unsuitable as a direct password hash because attackers
also benefit from that speed and parallelism.

### Message authentication: HMAC

HMAC is a construction that combines a secret key with a cryptographic hash,
commonly HMAC-SHA-256. It proves both integrity and knowledge of the shared
secret. It is not password hashing.

Gatherly's JWT `HS256` signatures use HMAC-SHA-256. The JWT secret must therefore
be high entropy and environment-specific. The password database never uses that
JWT secret, and JWT signing never uses password hashes. Separating these keys and
purposes prevents compromise in one boundary from automatically compromising the
other.

### Password hashing and key-derivation algorithms

#### PBKDF2

PBKDF2 repeatedly applies a pseudorandom function, usually HMAC-SHA-256, for a
configurable iteration count. It is old, standardized, widely supported, and
still appropriate where compatibility or FIPS-validated implementations are a
hard requirement. Its main weakness for password storage is that it is primarily
CPU-hard, not memory-hard, so GPUs and specialized parallel hardware attack it
more efficiently than modern memory-hard designs.

#### bcrypt

bcrypt is an adaptive password hash based on Blowfish. Its cost factor can be
raised as hardware improves, and it remains a defensible choice for existing
systems. Limitations include its age, CPU-focused rather than strongly
memory-hard design, and a 72-byte password input limit in common implementations.
New code should not silently truncate passwords to fit it.

#### scrypt

scrypt was designed to require significant memory as well as CPU, increasing the
cost of GPU, FPGA, and ASIC attacks. Its `N`, `r`, and `p` parameters tune work,
memory, and parallelism. It remains a strong choice when configured correctly,
but parameter selection can be less intuitive and Argon2 has become the usual
first recommendation for new password-storage systems.

#### Argon2d

Argon2d uses password-dependent memory access. This gives strong resistance to
GPU cracking but can expose data-dependent memory behavior to side-channel
attacks. It is best suited to contexts where side-channel exposure is not a
concern, rather than ordinary web password verification.

#### Argon2i

Argon2i uses data-independent memory access to reduce side-channel leakage. It
generally needs more passes to provide the same tradeoff-attack resistance as
Argon2d. It is useful when side-channel resistance is the dominant concern.

#### Argon2id

Argon2id combines the two modes: an initial data-independent portion limits
side-channel risk, while later data-dependent work improves resistance to GPU
and time-memory tradeoff attacks. It won the Password Hashing Competition as
part of the Argon2 family and is the common default recommendation for new
password storage.

#### Other platform password hashes

Algorithms such as yescrypt appear in operating-system password databases and
offer memory-hard behavior. They can be good choices in their ecosystems, but
Gatherly's Node.js stack already has a mature, focused Argon2 implementation and
does not gain a product lesson by adding another password-hash dependency.

### Non-cryptographic hashes

MurmurHash, xxHash, CRC32, and language runtime hash-table functions prioritize
speed and distribution or accidental-error detection. They do not promise
preimage or collision resistance against an attacker. Use them for hash tables,
sharding, fast checksums, or similar non-security work—not passwords, signatures,
tokens, idempotency authentication, or adversarial integrity checks.

### Salts, peppers, and encryption

A **salt** is a unique random value stored with each password hash. It prevents
identical passwords from producing identical stored values and stops attackers
from amortizing one precomputed table across every account. The encoded Argon2
string already contains its salt, algorithm version, parameters, and result.

A **pepper** is an additional server-held secret shared across hashes and stored
outside the database. It can add defense in depth when secret management and
rotation are mature, but it adds operational recovery and rotation complexity.
Gatherly does not add a pepper in this learning phase.

Password hashing is not encryption. Gatherly never needs to recover a user's
password, so there is no decryption key. On sign-in, it hashes/verifies the
candidate using the parameters and salt encoded in the stored Argon2 value.

### Why Argon2id is the Gatherly choice

Gatherly chooses Argon2id because:

1. it is designed specifically for password storage, not generic data hashing;
2. memory cost makes large-scale parallel guessing more expensive than plain
   SHA-2, SHA-3, PBKDF2, or bcrypt at comparable server latency;
3. the hybrid mode balances side-channel resistance with cracking resistance;
4. the installed Node `argon2` package handles random salts and encoded
   parameters correctly;
5. parameters can be raised later and old hashes can be recognized for rehashing;
6. it has no bcrypt-style 72-byte truncation issue;
7. it keeps the implementation small: one standard library boundary rather than
   a custom construction.

The handbook uses:

```text
memoryCost = 19,456 KiB (19 MiB)
timeCost = 2 iterations
parallelism = 1 lane
```

Those are a practical minimum profile, not timeless magic numbers. Benchmark
hash and verify latency on the actual deployment machine, choose the strongest
settings the sign-in capacity can safely sustain, limit concurrent attempts,
and revisit parameters as hardware changes. Store the complete encoded Argon2id
value so future logins can detect older parameters and rehash after successful
verification.
