# MAIZ Agents: one container serves the website (web/dist) and the API (/api) on $PORT.
# Build:  docker build --build-arg SITE_URL=https://yourdomain.com -t maiz-agents .
# Run:    docker run --env-file .env -p 8787:8787 maiz-agents

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY . .
ARG SITE_URL=http://localhost:8787
ARG GOOGLE_SITE_VERIFICATION=
ARG BING_SITE_VERIFICATION=
ARG CONTACT_EMAIL=
ENV CONTACT_EMAIL=${CONTACT_EMAIL} SITE_URL=${SITE_URL} GOOGLE_SITE_VERIFICATION=${GOOGLE_SITE_VERIFICATION} BING_SITE_VERIFICATION=${BING_SITE_VERIFICATION}
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8787
# pg_dump and pg_restore 16 for the in-app backups (docs/BACKUPS.md). Debian bookworm ships client 15, which refuses
# to dump a Postgres 16 server, so the client comes from the PostgreSQL project's own apt repository (PGDG). The
# repository key is fetched over https and pinned to that one repository; curl is removed again afterwards.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/* \
 && /usr/lib/postgresql/16/bin/pg_dump --version && /usr/lib/postgresql/16/bin/pg_restore --version
# The app runs these two programs straight from here, so it always gets version 16.
ENV PG_BIN_DIR=/usr/lib/postgresql/16/bin
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY db ./db
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server/main.ts"]
