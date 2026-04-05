# Hill90 AgentBox Service Dockerfile (Python/Starlette)
# Multi-stage build for production
# NOTE: akm CLI binary is copied from the hill90/knowledge image.
# Build knowledge image first: docker compose -f deploy/compose/prod/docker-compose.knowledge.yml build

FROM hill90/knowledge:latest AS akm-source

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
    zsh \
    tmux \
    git \
    curl \
    wget \
    jq \
    openssh-client \
    rsync \
    vim \
    make \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Copy Python packages from builder (only site-packages, not builder tools)
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages

# Copy AKM CLI binary from knowledge service image
COPY --from=akm-source /usr/local/bin/akm /usr/local/bin/akm

# Create non-root user with zsh as default shell
RUN useradd -m -u 1000 -s /usr/bin/zsh agentuser

# Install oh-my-zsh for agentuser (non-interactive)
RUN su - agentuser -c 'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended' && \
    sed -i 's/ZSH_THEME="robbyrussell"/ZSH_THEME="agnoster"/' /home/agentuser/.zshrc

# Install Claude Code CLI (native binary) for agentuser
# Installs to ~/.local/bin/claude with auto-updates disabled (container is ephemeral)
RUN su - agentuser -c 'curl -fsSL https://claude.ai/install.sh | bash' && \
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/agentuser/.zshrc && \
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/agentuser/.bashrc

# Create required directories
RUN mkdir -p /etc/agentbox /workspace /var/log/agentbox /data && \
    chown -R agentuser:agentuser /workspace /var/log/agentbox /data

# Copy application code
COPY app ./app

USER agentuser

EXPOSE 8054

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:8054/health || exit 1

CMD ["python", "-m", "app.server"]
