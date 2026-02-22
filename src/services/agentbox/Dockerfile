# Hill90 AgentBox Service Dockerfile (Python/FastMCP)
# Multi-stage build for production

FROM python:3.12-slim AS builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY pyproject.toml poetry.lock ./

# Install Poetry and dependencies
RUN pip install --no-cache-dir poetry==1.8.5 && \
    poetry config virtualenvs.create false && \
    poetry install --only main --no-interaction --no-ansi

# Production stage
FROM python:3.12-slim

WORKDIR /app

# Install runtime tools for agents
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    git \
    curl \
    wget \
    jq \
    openssh-client \
    rsync \
    vim \
    make \
    && rm -rf /var/lib/apt/lists/*

# Copy Python packages from builder (only site-packages, not builder tools)
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages

# Create non-root user
RUN useradd -m -u 1000 agentuser

# Create required directories
RUN mkdir -p /etc/agentbox /workspace /var/log/agentbox /data && \
    chown -R agentuser:agentuser /workspace /var/log/agentbox /data

# Copy application code
COPY app ./app
COPY tools ./tools

USER agentuser

EXPOSE 8054

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:8054/health || exit 1

CMD ["python", "app/server.py"]
