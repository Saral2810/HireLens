# ==============================================================================
# HR Screening Voice Agent: production Dockerfile
# ==============================================================================

# Stage 1: Dependency Installation for Backend
FROM node:22-alpine AS dependencies

WORKDIR /app

# Install build essentials if required for native addons
RUN apk add --no-cache libc6-compat

# Copy package manifests
COPY package*.json ./

# Install only production dependencies cleanly
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ==============================================================================
# Stage 2: Modern React Client Build
# ==============================================================================
FROM node:22-alpine AS client-builder

WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ==============================================================================
# Stage 3: Production Runtime
# ==============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

# Install security utilities:
# - dumb-init: ensures POSIX signals (SIGTERM/SIGINT) are forwarded to Node.js
# - curl: used by container healthchecks
RUN apk add --no-cache dumb-init curl

# Default environment configuration
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Copy installed production dependencies from builder stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application source code
COPY package.json ./
COPY backend ./backend
COPY --from=client-builder /app/client/dist ./client/dist
COPY database ./database

# Run as the unprivileged node user
RUN chown -R node:node /app

USER node

# Expose standard application port
EXPOSE 3000

# Container Health Check (polls /health endpoint every 30s)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

# Launch via dumb-init for clean PID 1 signal forwarding
CMD ["dumb-init", "node", "backend/src/server.js"]
