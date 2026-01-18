FROM node:20-alpine as builder
WORKDIR /build
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY package*.json ./
RUN addgroup -S appuser && adduser -S -G appuser appuser && chown -R appuser:appuser /app
USER appuser
EXPOSE 3001
CMD ["node", "dist/index.js"]
