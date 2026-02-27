# Hill90 AKM Service Dockerfile (Python/FastAPI + Go CLI)
# Multi-stage build: Go CLI builder → Python service with akm binary

# Stage 1: Build Go CLI
FROM golang:1.23-alpine AS go-builder

WORKDIR /build
COPY cli/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o akm .

# Stage 2: Build Python dependencies
FROM python:3.12-slim AS py-builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml poetry.lock ./

RUN pip install --no-cache-dir poetry==1.8.5 && \
    poetry config virtualenvs.create false && \
    poetry install --only main --no-interaction --no-ansi

# Stage 3: Production image
FROM python:3.12-slim

WORKDIR /app

# Copy Python packages from builder
COPY --from=py-builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=py-builder /usr/local/bin /usr/local/bin

# Copy Go CLI binary
COPY --from=go-builder /build/akm /usr/local/bin/akm

# Copy application code
COPY app ./app

# Create non-root user and data directory
RUN useradd -m -u 1000 appuser && \
    mkdir -p /data/knowledge /etc/akm && \
    chown -R appuser:appuser /app /data/knowledge

USER appuser

EXPOSE 8002

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8002/health')"

CMD ["opentelemetry-instrument", "uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8002"]
