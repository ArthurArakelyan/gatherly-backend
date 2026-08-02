# Phase 1 Handbook: Docker, Compose, and PostgreSQL

This phase packages the existing Gatherly Node server into an image and runs it beside PostgreSQL with Docker Compose.

You are learning container fundamentals here—not Express, application tables, Prisma, or deployment. Type the files yourself, run every checkpoint, deliberately break selected settings, and explain why the behavior changes.

## What you will build

```text
Your browser / PowerShell
        │
        │ localhost:3000
        ▼
┌───────────────────────┐
│ app container         │
│ Node 24               │
│ dist/server.js        │
│ container port 3000   │
└───────────┬───────────┘
            │ postgres:5432
            │ Compose network
            ▼
┌───────────────────────┐
│ postgres container    │
│ PostgreSQL            │
│ container port 5432   │
└───────────┬───────────┘
            │
            ▼
    named Docker volume
      postgres_data
```

The expected new files are:

```text
Dockerfile
.dockerignore
compose.yaml
.env.example
```

Create a local `.env` from `.env.example`, but do not commit `.env`.

## Vocabulary before starting

- **Dockerfile:** instructions for building an image.
- **Image:** an immutable packaged filesystem plus metadata describing how to run the application.
- **Container:** a running or stopped instance of an image.
- **Build context:** the host files Docker is allowed to read during a build, normally `.`.
- **Layer:** a cached result produced by an image-building instruction.
- **Compose project:** a related collection of services, networks, and volumes described by `compose.yaml`.
- **Service:** Compose’s definition of a container role, such as `app` or `postgres`.
- **Named volume:** Docker-managed persistent storage whose lifecycle is separate from a container.
- **Published port:** a forwarding rule from a host port to a container port.
- **Health check:** a command Docker runs repeatedly to decide whether a container is healthy.

## Step 1: Check the prerequisites

Install and start Docker Desktop, then run:

```powershell
docker version
docker compose version
docker info
```

What these prove:

- `docker version` shows whether the CLI can communicate with the Docker Engine.
- `docker compose version` confirms you are using the modern `docker compose` plugin, not the old `docker-compose` command.
- `docker info` confirms the engine is running and describes its storage, network, and container environment.

If `docker version` prints client information but cannot contact the server, Docker Desktop probably is not running yet.

Checkpoint:

```text
I can explain why the Docker CLI and Docker Engine are separate components.
```

## Step 2: Understand the existing process

Before putting Node in a container, run it normally:

```powershell
yarn build
yarn start
```

In a second PowerShell window:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3000/health
```

Stop it with Ctrl+C and observe the graceful-shutdown log.

The container must eventually run the same production command:

```text
node dist/server.js
```

Docker is not changing the application language or turning Node into a different kind of server. It is packaging the environment needed to run that command.

Checkpoint:

```text
The application builds and starts outside Docker before I debug it inside Docker.
```

## Step 3: Create `.dockerignore`

Docker sends the build context to the builder. Exclude files that should not participate in the image build:

```dockerignore
node_modules
dist
coverage
.git
.gitignore
.env
.env.*
!.env.example
*.log
README.md
AGENTS.md
PHASE_1_DOCKER_HANDBOOK.md
```

Why:

- Host `node_modules` may contain Windows binaries that cannot run inside a Linux container.
- `dist` should be compiled inside the image, proving the build is reproducible.
- `.env` may contain secrets and must not become part of the image.
- Git history, coverage, logs, and documentation do not belong in the runtime artifact.
- A smaller context transfers faster and invalidates fewer cached layers.

Do not confuse `.dockerignore` with `.gitignore`:

- `.gitignore` controls what Git tracks.
- `.dockerignore` controls what Docker can copy from the build context.

Checkpoint question:

> What could happen if Windows `node_modules` were copied into a Linux image containing native packages such as Argon2?

## Step 4: Write the Dockerfile

Use a multi-stage Dockerfile. Type and study this structure rather than treating it as magic:

```dockerfile
# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN yarn build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true && yarn cache clean

COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 3000

CMD ["node", "dist/server.js"]
```

### What each instruction means

`# syntax=docker/dockerfile:1`

Selects the current Dockerfile frontend syntax understood by BuildKit.

`FROM node:24-bookworm-slim AS build`

Starts the build stage from the official Node 24 Debian-based image. The stage name lets later instructions reference it as `build`.

`WORKDIR /app`

Creates/selects `/app` as the working directory for later `COPY`, `RUN`, and `CMD` instructions. Without an explicit working directory, commands may run from an image-dependent location such as `/`.

`COPY package.json yarn.lock ./`

Copies dependency manifests before source code. Docker can reuse the dependency-install layer when source files change but dependency manifests do not.

`RUN yarn install --frozen-lockfile`

Installs the exact dependency graph from `yarn.lock`. The build stage needs development dependencies such as TypeScript.

`COPY tsconfig.json tsconfig.build.json ./` and `COPY src ./src`

Copies only what the production compilation needs.

`RUN yarn build`

Compiles `src/**/*.ts` into `dist/**/*.js` inside the Linux build environment.

The second `FROM` begins a clean runtime stage. Files from the build stage do not automatically carry over.

`ENV NODE_ENV=production`

Defines the default runtime environment inside the image. Compose can override it.

`RUN yarn install --frozen-lockfile --production=true`

Installs runtime dependencies without development-only tools. This project currently has many later-phase runtime clients, so the result is not tiny, but the separation remains valuable.

`COPY --from=build ...`

Copies only compiled output from the build stage. TypeScript sources and compiler output from intermediate steps are not implicitly copied.

`USER node`

Runs the application as the non-root `node` user supplied by the official Node image. Building as root is common; running the network-facing process as root is unnecessary.

`EXPOSE 3000`

Documents that the image expects the application to listen on port 3000. It does **not** publish that port to your host.

`CMD ["node", "dist/server.js"]`

Defines the default container process using exec-array form. Node receives termination signals directly, which helps graceful shutdown.

### Build only the image

```powershell
docker build --tag gatherly-backend:phase1 .
```

Inspect it:

```powershell
docker image ls gatherly-backend
docker image inspect gatherly-backend:phase1
```

Rebuild immediately:

```powershell
docker build --tag gatherly-backend:phase1 .
```

Notice which lines say `CACHED`. Then change only a line in `src/app.ts` and build again. The dependency layer should remain cached because `package.json` and `yarn.lock` did not change.

Checkpoint questions:

- Why does copying `package.json` before `src` improve rebuild speed?
- Why does the build stage need TypeScript while the runtime stage does not?
- What is the difference between `EXPOSE` and publishing a port?
- Which user runs `dist/server.js`?

## Step 5: Define local environment values

Create `.env.example`:

```dotenv
APP_PORT=3000
POSTGRES_PORT=5432
POSTGRES_DB=gatherly
POSTGRES_USER=gatherly
POSTGRES_PASSWORD=replace-with-a-local-password
```

Copy it to the ignored `.env` file:

```powershell
Copy-Item .env.example .env
```

Set a local password in `.env`.

There are two related but different uses of environment values:

1. Compose interpolation replaces `${APP_PORT}` and similar expressions while reading `compose.yaml`.
2. A service’s `environment` section injects values into that container’s `process.env`.

An `.env` value is not automatically available to every container merely because the file exists. The Compose model must pass it into a service.

Preview the resolved Compose model later with:

```powershell
docker compose config
```

Warning: resolved configuration can display passwords. Do not paste its output into public issues or logs.

Checkpoint question:

> What is the difference between Compose using a variable and the Node process receiving that variable?

## Step 6: Write `compose.yaml`

Use two services and one named volume:

```yaml
services:
  postgres:
    image: postgres:17-bookworm
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    ports:
      - '127.0.0.1:${POSTGRES_PORT}:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}']
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  app:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      NODE_ENV: production
      PORT: 3000
      PGHOST: postgres
      PGPORT: 5432
      PGDATABASE: ${POSTGRES_DB}
      PGUSER: ${POSTGRES_USER}
      PGPASSWORD: ${POSTGRES_PASSWORD}
    ports:
      - '127.0.0.1:${APP_PORT}:3000'
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test:
        [
          'CMD',
          'node',
          '-e',
          "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
        ]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 5s
    init: true
    stop_grace_period: 15s

volumes:
  postgres_data:
```

Do not add a top-level `version` field; modern Compose uses the current Compose specification.

### Understand the PostgreSQL service

`image: postgres:17-bookworm`

Uses a pinned PostgreSQL major release. Avoid `latest`, because it can silently move to a new major version with different storage or upgrade requirements.

`POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`

The official image uses these values when initializing an empty data directory. Changing them later does not automatically rewrite users or databases already stored in an existing volume.

`127.0.0.1:${POSTGRES_PORT}:5432`

Publishes PostgreSQL to the local machine for tools such as `psql` or a database GUI:

```text
host 127.0.0.1:${POSTGRES_PORT} → container postgres:5432
```

Binding to `127.0.0.1` avoids publishing it on every host network interface. The app container does not use this host port; it uses `postgres:5432` on the Compose network. You may later remove PostgreSQL’s published port if only containers require access.

`postgres_data:/var/lib/postgresql/data`

Mounts named persistent storage at PostgreSQL’s data directory. Replacing/removing the container does not remove this volume.

### Understand the app service

`build`

Tells Compose to build the Dockerfile from the current directory rather than pull a prebuilt Gatherly image.

`PGHOST: postgres`

Uses the **service name**, not `localhost`. Compose places both services on a shared default network and provides DNS for their service names.

Inside the app container:

```text
localhost → the app container itself
postgres  → the PostgreSQL service
```

`PGPORT: 5432`

Service-to-service communication uses the PostgreSQL container port, regardless of the host’s published `POSTGRES_PORT`.

`127.0.0.1:${APP_PORT}:3000`

Forwards requests from your machine to Node inside the container:

```text
host 127.0.0.1:${APP_PORT} → app container port 3000
```

`init: true`

Runs a small init process as PID 1. It forwards signals and reaps orphaned child processes. Node still receives `SIGTERM` and runs its shutdown handler.

`stop_grace_period: 15s`

Compose allows up to 15 seconds after `SIGTERM` before forcing termination. The server’s own forced-shutdown timeout is 10 seconds, so it has time to perform its cleanup first.

Checkpoint:

```powershell
docker compose config --quiet
```

This validates the Compose model without starting containers.

## Step 7: Understand health checks

### PostgreSQL health

Starting a PostgreSQL process does not mean it is ready to accept queries. The check runs inside the database container:

```text
pg_isready -U <user> -d <database>
```

Health-check timing means:

- `start_period`: initial grace period.
- `interval`: delay between checks.
- `timeout`: maximum duration of one check.
- `retries`: consecutive failures allowed before the container becomes unhealthy.

The doubled dollars in Compose are deliberate:

```yaml
$${POSTGRES_USER}
```

`$$` escapes Compose interpolation so `$POSTGRES_USER` reaches the container shell and is expanded there.

### Application health

The app check uses Node’s built-in `fetch` to call `/health` from inside its own container. No `curl` installation is required.

The current `/health` endpoint is a **liveness** check:

```text
Is the Node process responding to HTTP?
```

It is not yet a true **readiness** check:

```text
Can this instance safely serve requests, including required dependencies?
```

During Phase 2, add `/health/ready` that can fail when PostgreSQL is required but unavailable. Keep `/health/live` independent enough to show that the Node process itself is alive.

Health checks are not restarts by themselves. They assign health status; restart behavior is a separate policy.

## Step 8: Understand `depends_on`

This configuration:

```yaml
depends_on:
  postgres:
    condition: service_healthy
```

tells Compose not to start the app until PostgreSQL’s health check succeeds.

It solves an initial startup-order race, but it does not make the application resilient forever. If PostgreSQL becomes unavailable after startup, Phase 2 code must handle connection errors and recovery appropriately.

Remember:

```text
depends_on controls Compose lifecycle ordering
≠ application retry strategy
≠ permanent dependency guarantee
```

Experiment later by intentionally breaking the PostgreSQL health-check database name. The app should remain blocked while PostgreSQL fails to become healthy. Restore the correct value afterward.

## Step 9: Start and inspect the stack

Build and start in the foreground:

```powershell
docker compose up --build
```

Foreground mode is best while learning because logs from both services stay visible.

In a second terminal:

```powershell
docker compose ps
Invoke-RestMethod -Uri http://127.0.0.1:3000/health
docker compose logs app
docker compose logs postgres
```

If you changed `APP_PORT`, use that host port instead of `3000`.

Start in the background when you no longer need attached logs:

```powershell
docker compose up --detach
docker compose logs --follow
```

Useful inspection commands:

```powershell
docker compose ps
docker compose top
docker compose images
docker compose exec app node --version
docker compose exec app id
docker compose exec app pwd
```

Expected lessons:

- `id` shows the runtime is not root.
- `pwd` prints `/app` because of `WORKDIR`.
- `ps` shows health and published ports.
- Logs are container output, not files you must enter the container to read.

## Step 10: Verify Compose networking

Ask Docker’s internal DNS to resolve the PostgreSQL service from the app container:

```powershell
docker compose exec app node --input-type=module -e "import { lookup } from 'node:dns'; lookup('postgres', console.log)"
```

Inspect the injected PostgreSQL hostname:

```powershell
docker compose exec app node -e "console.log(process.env.PGHOST)"
```

It should print:

```text
postgres
```

Verify PostgreSQL readiness directly:

```powershell
docker compose exec postgres pg_isready -U gatherly -d gatherly
```

Use the actual values from your `.env` if you changed them.

The resolved container IP may change after recreation. Never store it in application configuration; the service name remains stable.

Checkpoint question:

> Why would `PGHOST=localhost` fail when Node and PostgreSQL run in different containers?

## Step 11: Verify the named volume

List the Compose-created volume:

```powershell
docker volume ls
```

Create disposable probe data—not an application schema:

```powershell
docker compose exec postgres psql -U gatherly -d gatherly -c "CREATE TABLE phase1_probe (message text NOT NULL);"
docker compose exec postgres psql -U gatherly -d gatherly -c "INSERT INTO phase1_probe VALUES ('volume survives');"
```

Remove the containers and Compose network while keeping the volume:

```powershell
docker compose down
```

Start again:

```powershell
docker compose up --detach
```

Read the probe data:

```powershell
docker compose exec postgres psql -U gatherly -d gatherly -c "SELECT * FROM phase1_probe;"
```

The row should still exist because `docker compose down` does not remove named volumes by default.

Clean up only the probe table:

```powershell
docker compose exec postgres psql -U gatherly -d gatherly -c "DROP TABLE phase1_probe;"
```

Destructive command to understand, but not casually run:

```powershell
docker compose down --volumes
```

`--volumes` deletes the Compose-managed named volume and therefore the database data inside it. Use it only when you deliberately want a completely fresh local database.

Checkpoint:

```text
I can remove/recreate a database container without losing data, and I know exactly which command would delete the volume.
```

## Step 12: Verify graceful shutdown

Keep logs visible:

```powershell
docker compose logs --follow app
```

In another terminal:

```powershell
docker compose stop app
```

You should see logs corresponding to:

```text
SIGTERM received
→ stop accepting new connections
→ finish/close existing connections
→ graceful shutdown completed
```

What happens:

1. Compose sends `SIGTERM` by default.
2. The init process forwards it to Node.
3. `server.ts` calls `server.close()`.
4. Node stops accepting connections and waits for current connections.
5. The app has an internal ten-second forced-close fallback.
6. Compose allows 15 seconds before it can send `SIGKILL`.

Start it again:

```powershell
docker compose start app
```

Compare these commands:

- `stop`: stops existing containers without removing them.
- `start`: starts previously stopped containers.
- `restart`: stops and starts existing containers.
- `down`: stops and removes Compose containers and its default network, normally preserving named volumes.
- `up`: creates/recreates what is necessary and starts it.

Checkpoint question:

> Why is `SIGKILL` unsuitable for graceful cleanup?

## Step 13: Rebuild after source changes

Images are immutable. Editing `src/app.ts` on the host does not change an already-created image or container.

Make a harmless response change, then run:

```powershell
docker compose up --detach --build app
```

Compose will:

1. Build a new app image.
2. Reuse unchanged cached layers.
3. Stop/remove the old app container when replacement is needed.
4. Create a new container from the new image.
5. Attach it to the same Compose network under the `app` service name.

Inspect the result:

```powershell
docker compose ps
docker compose logs app
Invoke-RestMethod -Uri http://127.0.0.1:3000/health
```

Commands worth distinguishing:

```powershell
docker compose build app
docker compose up --detach app
docker compose up --detach --build app
docker compose build --no-cache app
```

- `build app` creates the image but does not necessarily recreate/start the service.
- `up app` converges the service to the current Compose definition.
- `up --build app` builds first, then recreates if needed.
- `build --no-cache` deliberately ignores layer cache; use it for diagnosis, not ordinary iteration.

This local replacement may cause brief downtime. Zero-downtime deployment with two app instances, readiness checks, Nginx traffic switching, migration compatibility, and rollback is intentionally a late-stage problem.

Optional later development optimization: bind-mount source code and run `tsx watch` inside a development-only Compose target/profile. Do not begin there—the rebuild workflow teaches what an image actually represents.

## Step 14: Validate failure behavior

Perform these experiments one at a time and restore the correct configuration after each.

### Invalid host port

Start another process on port 3000 or choose an occupied `APP_PORT`. Compose should report that it cannot bind the host port. Change the host port; do not change the app’s internal port merely to fix a host conflict.

### Wrong PostgreSQL hostname

Temporarily set `PGHOST` to `localhost`. DNS is no longer the issue—`localhost` resolves—but it refers to the app container, where PostgreSQL is not listening.

### Bad health check

Change the health-check database name to one that does not exist. PostgreSQL may be running, but its readiness command fails and Compose does not satisfy `service_healthy`.

### Changed credentials with an existing volume

Change `POSTGRES_USER` after the database has already initialized. The official image does not recreate the stored cluster just because environment variables changed. Either restore the original local credentials, deliberately modify the database roles, or—only if the data is disposable—remove the volume and initialize from scratch.

### Broken application health route

Change `/health` or return a failure status. The Node process can continue running while Docker marks the container unhealthy. This demonstrates that running and healthy are different states.

For each failure, inspect before changing random settings:

```powershell
docker compose ps
docker compose logs app
docker compose logs postgres
docker compose config
```

## Step 15: Phase completion exercise

Starting from stopped/removed containers but an existing named database volume:

1. Explain every relevant line of `Dockerfile`.
2. Explain every relevant line of `compose.yaml`.
3. Run `docker compose config --quiet`.
4. Run `docker compose up --build`.
5. Show that PostgreSQL becomes healthy before the app starts.
6. Call the application health endpoint from the host.
7. Show that `app` resolves `postgres` using Compose DNS.
8. Show that the app container runs as a non-root user in `/app`.
9. Create probe data and show that it survives `docker compose down` plus `up`.
10. Rebuild the app after a source change and identify which layers were cached.
11. Stop the app and identify its graceful-shutdown logs.
12. Explain which command would remove the database volume without running it accidentally.

Phase 1 is complete when you can perform and explain all twelve steps without treating Compose as a black box.

## Final understanding checklist

You should now be able to explain:

- **Building the Node image:** Docker follows the Dockerfile, produces cached immutable layers, compiles TypeScript in a build stage, and runs compiled JavaScript in a clean runtime stage.
- **Container users and working directories:** `WORKDIR` makes paths predictable; `USER node` avoids running the API as root.
- **Compose networking:** services share a network and are resolved by stable service names rather than changing container IPs.
- **The `postgres` hostname:** it is Compose DNS for the PostgreSQL service; `localhost` inside the app means the app container.
- **Environment variables:** Compose interpolation and container environment injection are distinct operations.
- **PostgreSQL health:** `pg_isready` tests database readiness, not merely whether a process was started.
- **Application health:** an HTTP check proves Node is responding; liveness and dependency-aware readiness are different.
- **`depends_on` health conditions:** Compose can wait for initial dependency health, but application code still needs runtime failure handling.
- **Named-volume persistence:** the database lives outside the replaceable container layer; `down --volumes` is intentionally destructive.
- **Port mapping:** host and container ports are different; service-to-service traffic normally uses container ports directly.
- **Graceful shutdown:** Compose sends `SIGTERM`, Node drains work, and a later timeout provides a forced fallback.
- **Rebuilding after changes:** source changes require a new immutable image/container unless a separate development bind-mount workflow is chosen.

## Common misconceptions

```text
Image ≠ container
EXPOSE ≠ publish a port
localhost in app ≠ PostgreSQL container
container started ≠ service ready
depends_on ≠ runtime fault tolerance
down ≠ delete named volumes
restart ≠ rebuild an image
.env interpolation ≠ automatic container environment
Docker Compose ≠ production orchestration
```

## Official references

- [Dockerfile reference](https://docs.docker.com/reference/dockerfile/)
- [Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Docker build best practices](https://docs.docker.com/build/building/best-practices/)
- [Compose networking and service-name discovery](https://docs.docker.com/compose/how-tos/networking/)
- [Compose startup and shutdown order](https://docs.docker.com/compose/how-tos/startup-order/)
- [Compose service reference](https://docs.docker.com/reference/compose-file/services/)
- [Compose environment interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)
- [Publishing ports](https://docs.docker.com/get-started/docker-concepts/running-containers/publishing-ports/)
- [Docker volumes](https://docs.docker.com/engine/storage/volumes/)
- [Official PostgreSQL image](https://hub.docker.com/_/postgres)
