# One build stage for the whole workspace, one small runtime target per process.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /app
COPY . .
# Node no longer ships corepack, so pnpm comes from npm in the version package.json pins.
RUN npm install --global "$(node -p "require('./package.json').packageManager")"
RUN pnpm install --frozen-lockfile && pnpm build
# A self-contained folder: the package, its production dependencies and the built workspace packages.
RUN pnpm --filter @app/api deploy --prod /out/api
RUN pnpm --filter @app/worker deploy --prod /out/worker

FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/api .
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/health/live`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "./dist/tracing.preload.js", "dist/main.js"]

# The worker has no HTTP server, so no port and no HTTP health check.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/worker .
USER node
CMD ["node", "--import", "./dist/tracing.preload.js", "dist/main.js"]

# One-shot scripts of the local stack (aws-init): the build stage already has the root dependencies
# and the built shared package.
FROM build AS tools
ENV NODE_ENV=production
USER node

# Caddy serves the built web app and is the reverse proxy in front of the API.
FROM caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0 AS web
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist/browser /srv
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/"]
