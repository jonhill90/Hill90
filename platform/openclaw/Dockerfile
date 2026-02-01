FROM node:22-bookworm

# Install system packages
RUN apt-get update && apt-get install -y \
    # Core utilities
    git curl wget jq vim tree htop ncdu rsync \
    # SSH client
    openssh-client \
    # Python ecosystem
    python3 python3-pip python3-venv \
    # Dependencies for Docker official repo
    ca-certificates gnupg lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Install official Docker CLI
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

# Install Python packages for AI/automation
RUN pip3 install --break-system-packages \
    ansible \
    openai \
    anthropic \
    requests \
    beautifulsoup4 \
    pyyaml

# Install OpenClaw globally
RUN npm install -g openclaw

# Create OpenClaw workspace and config directories
RUN mkdir -p /home/node/.openclaw/workspace && \
    chown -R node:node /home/node/.openclaw

# Setup SSH directory for node user
RUN mkdir -p /home/node/.ssh && \
    chown -R node:node /home/node/.ssh && \
    chmod 700 /home/node/.ssh

# Switch to node user
USER node
WORKDIR /home/node/.openclaw

# Expose gateway port
EXPOSE 18789

# Start OpenClaw gateway
CMD ["openclaw", "gateway", "--bind", "lan", "--port", "18789"]
