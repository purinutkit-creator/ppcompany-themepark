# Print Agent (Linux / Raspberry Pi). Thai + CJK fonts are installed as rendering fallbacks.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-thai-tlwg fonts-noto-cjk fonts-noto-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
COPY print-agent/package.json print-agent/
RUN npm ci -w print-agent --include-workspace-root=false --no-audit --no-fund
COPY packages ./packages
COPY print-agent ./print-agent
RUN npm run build -w print-agent
WORKDIR /app/print-agent
ENV CACHE_DIR=/data/cache
VOLUME ["/data"]
CMD ["node", "dist/index.js"]
