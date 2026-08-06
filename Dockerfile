FROM node:24-bookworm-slim AS base

# Prisma's PostgreSQL runtime needs OpenSSL. Install it once in the shared base
# so the build, migration, and application stages use the same system library.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS dependencies

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile \
  && yarn cache clean

FROM dependencies AS development

ENV NODE_ENV=development
COPY tsconfig.json tsconfig.build.json vitest.config.ts prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY tests ./tests
RUN DATABASE_URL=postgresql://unused:unused@localhost:5432/unused yarn prisma:generate
USER node
CMD ["yarn", "dev"]

FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN DATABASE_URL=postgresql://unused:unused@localhost:5432/unused yarn build

# This stage intentionally retains Prisma CLI from the full dependency install.
# It is a one-shot release tool, not the HTTP application image.
FROM dependencies AS migration

ENV NODE_ENV=production
COPY prisma.config.ts ./
COPY prisma ./prisma
USER node
CMD ["yarn", "db:migrate:deploy"]

FROM base AS production-dependencies

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true \
  && yarn cache clean

FROM base AS runtime

ENV NODE_ENV=production

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
