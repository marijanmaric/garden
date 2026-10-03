# One image for all Node services (api, gateway, web). The service is chosen by the compose command.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/adapters/package.json packages/adapters/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

FROM deps AS app
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build -w @m1/web
ENV NODE_ENV=production
