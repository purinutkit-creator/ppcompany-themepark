# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
COPY print-agent/package.json print-agent/
RUN npm ci --no-audit --no-fund
COPY packages ./packages
COPY server ./server
COPY web ./web
RUN npm run build -w server && npm run build -w web

# ---------- runtime ----------
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4000 WEB_DIST=/app/web/dist UPLOAD_DIR=/data/uploads
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
COPY print-agent/package.json print-agent/
RUN npm ci --omit=dev -w server --include-workspace-root=false --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY packages/shared ./packages/shared
# Runs as root so a platform-mounted persistent disk at /data (e.g. Render disks) is writable.
RUN mkdir -p /data/uploads
WORKDIR /app/server
# Compatibility shim: a hosted service saved its start command as one quoted word
# ("node dist/seed.js && node dist/index.js"), which sh resolves as a relative file path.
# Provide that path so the saved command still runs the normal start. Safe to delete once
# the service's custom Docker Command is cleared.
RUN mkdir -p "node dist/seed.js && node dist" \
 && printf '#!/bin/sh\nnode dist/seed.js && exec node dist/index.js\n' > "node dist/seed.js && node dist/index.js" \
 && chmod +x "node dist/seed.js && node dist/index.js"
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations + base data (demo data only on an empty database), then the server. Both are idempotent.
CMD ["sh", "-c", "node dist/seed.js && exec node dist/index.js"]
