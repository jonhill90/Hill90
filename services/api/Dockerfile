# Hill90 API Service Dockerfile (TypeScript/Express)
# Multi-stage build for production

FROM node:20-alpine as builder

WORKDIR /build

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (including devDependencies for build)
RUN npm ci && \
    npm cache clean --force

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy dependencies and built code from builder
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY package*.json ./

# Create agentbox config directory and set ownership to node user (uid 1000)
# node:20-alpine provides node:node (1000:1000) — matches deploy.sh chown 1000:1000
RUN mkdir -p /data/agentbox && \
    chown -R node:node /app /data/agentbox

USER node

EXPOSE 3000

ENV NODE_OPTIONS="--require ./dist/tracing.js"

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "dist/index.js"]
