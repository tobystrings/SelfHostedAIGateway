# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/admin/package.json apps/admin/package.json
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/admin/package.json apps/admin/package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/apps/gateway/dist apps/gateway/dist
COPY --from=build /app/apps/admin/dist apps/admin/dist
COPY migrations migrations
USER node
EXPOSE 8080
CMD ["sh", "-c", "node apps/gateway/dist/db/migrate.js && node apps/gateway/dist/server.js"]
