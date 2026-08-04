FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json yarn.lock ./
# Prisma's engine needs OpenSSL in the slim image.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN yarn install --frozen-lockfile

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

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true && yarn cache clean
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/generated ./dist/generated
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node prisma.config.ts ./prisma.config.ts
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
