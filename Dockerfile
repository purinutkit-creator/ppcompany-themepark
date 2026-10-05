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
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
WORKDIR /app/server
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
