FROM node:20-alpine AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /build/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /build/dist ./dist
USER node
CMD ["node", "dist/index.js"]
