# Multi-stage production build for CloudCast Live Broadcast Platform
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy application source code
COPY . .

# Build Vite frontend and esbuild bundle
RUN npm run build

# Production runtime stage
FROM node:22-bookworm-slim AS runner

# Install native FFmpeg and FFprobe binaries
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy package manifests and production dependencies only
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy built frontend dist and server bundle from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.js ./server.js

# Copy metadata and default template configuration
COPY --from=builder /app/data ./data
COPY --from=builder /app/metadata.json ./metadata.json

# Create uploads directory and set permissions
RUN mkdir -p /app/uploads/.chunks /app/data && \
    chown -R node:node /app

# Switch to standard non-root user
USER node

# Expose production port
EXPOSE 3000

# Health check verifying API responsiveness
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/api/health || exit 1

# Start CloudCast server with signal handling
CMD ["node", "server.js"]
