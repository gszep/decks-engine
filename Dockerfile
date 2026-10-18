FROM node:24.18.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-noto-cjk fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Engine only: decks/, themes/ and tools/ come from the mounted content root
# (DECKS_CONTENT_ROOT=/content), never baked into the image.
COPY engine ./engine
COPY README.md AGENTS.md ./

ENV NODE_ENV=production \
    DECKS_HOST=0.0.0.0 \
    CHROME=/usr/bin/chromium
USER node
CMD ["node", "engine/host.mjs"]
