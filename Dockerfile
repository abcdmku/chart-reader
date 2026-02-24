# syntax=docker/dockerfile:1

FROM node:24-bullseye AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json

RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm --workspace apps/web run build
RUN npm --workspace apps/server run build

FROM node:24-bullseye AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/web/dist ./apps/server/public

EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
