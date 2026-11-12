# One build stage for the whole workspace, one small runtime target per process.
FROM node:26.13.1-slim AS build
WORKDIR /app
COPY . .
# Node no longer ships corepack, so pnpm comes from npm in the version package.json pins.
RUN npm install --global "$(node -p "require('./package.json').packageManager")"
RUN pnpm install --frozen-lockfile && pnpm build
# A self-contained folder: the package, its production dependencies and the built workspace packages.
RUN pnpm --filter @app/api deploy --prod /out/api

FROM node:26.13.1-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/api .
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/health/live`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]

# Caddy serves the built web app and is the reverse proxy in front of the API.
FROM caddy:2.11.9-alpine AS web
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist/browser /srv
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/"]
