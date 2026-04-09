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
    fontconfig \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Copy Python packages from builder (only site-packages, not builder tools)
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages

# Copy AKM CLI binary from knowledge service image
COPY --from=akm-source /usr/local/bin/akm /usr/local/bin/akm

# Install Playwright chromium + system deps (AI-177: browser observation)
# Install system deps manually (--with-deps fails on ttf-ubuntu-font-family)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 libxshmfence1 fonts-liberation fonts-noto-color-emoji && \
    pip install --no-cache-dir playwright==1.51.0 && \
    playwright install chromium && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user with zsh as default shell
RUN useradd -m -u 1000 -s /usr/bin/zsh agentuser

# Install Powerlevel10k (system-wide, no git clone per user)
RUN git clone --depth=1 https://github.com/romkatv/powerlevel10k.git /usr/share/powerlevel10k

# Install FiraCode Nerd Font (for terminal rendering in xterm.js)
RUN mkdir -p /usr/share/fonts/nerd-fonts && \
    curl -fsSL -o /tmp/firacode.tar.xz https://github.com/ryanoasis/nerd-fonts/releases/download/v3.3.0/FiraCode.tar.xz && \
    tar -xf /tmp/firacode.tar.xz -C /usr/share/fonts/nerd-fonts && \
    rm /tmp/firacode.tar.xz && \
    fc-cache -f 2>/dev/null || true

# Install oh-my-zsh for agentuser
RUN su - agentuser -c 'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended'

# Install TPM (tmux plugin manager) and Tokyo Night theme (pinned to same version as Jon's Mac)
RUN su - agentuser -c 'git clone --depth=1 https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm' && \
    su - agentuser -c 'git clone https://github.com/fabioluciano/tmux-tokyo-night ~/.tmux/plugins/tmux-tokyo-night && cd ~/.tmux/plugins/tmux-tokyo-night && git checkout fcfde9a'

# Copy theme config files (Tokyo Night tmux + Powerlevel10k zsh)
COPY theme/tmux.conf /home/agentuser/.tmux.conf
COPY theme/zshrc /home/agentuser/.zshrc
COPY theme/p10k.zsh /home/agentuser/.p10k.zsh
RUN chown agentuser:agentuser /home/agentuser/.tmux.conf /home/agentuser/.zshrc /home/agentuser/.p10k.zsh

# Pre-initialize TPM plugins so they're ready at container start
RUN su - agentuser -c 'tmux start-server && tmux new-session -d -s init && ~/.tmux/plugins/tpm/bin/install_plugins && tmux kill-server' 2>/dev/null || true

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
