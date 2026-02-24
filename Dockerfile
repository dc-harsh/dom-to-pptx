# dom-to-pptx API Server
#
# Build:  docker build -t dom-to-pptx .
# Run:    docker run -p 3000:3000 dom-to-pptx
# Tune:   docker run -p 3000:3000 -e POOL_MAX=10 dom-to-pptx

# ── Stage 1: Build the dom-to-pptx browser bundle from source ────────────────
FROM node:20-slim AS builder

WORKDIR /build

COPY package.json rollup.config.js ./
COPY src/ ./src/

RUN npm install && npm run build
# Produces: dist/dom-to-pptx.bundle.js


# ── Stage 2: Production server ────────────────────────────────────────────────
# Official Playwright image — Node.js 20 + Chromium + all system deps included
FROM mcr.microsoft.com/playwright:v1.58.0-jammy

WORKDIR /app

# Install server dependencies.
# --ignore-scripts skips the postinstall hook that would re-download browsers
# (Chromium is already pre-installed in this base image at /ms-playwright).
COPY server/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

# Copy server entry point
COPY server/server.js ./server.js

# Use the freshly built bundle from Stage 1
COPY --from=builder /build/dist/dom-to-pptx.bundle.js ./dom-to-pptx.bundle.js

# Point Playwright to the pre-installed browsers in this base image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

ENV NODE_ENV=production
ENV PORT=3000
ENV POOL_MAX=5

EXPOSE 3000

# Health check using Node 20 built-in fetch
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
