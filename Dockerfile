FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p data && chown -R node:node data
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages packages
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 3001
CMD ["node","apps/api/src/server.js"]
