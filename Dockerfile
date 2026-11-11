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
ENV SITE_URL=${SITE_URL}
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8787
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
