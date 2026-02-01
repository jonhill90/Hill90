# OpenClaw SSH Keys

## Purpose
This directory contains SSH keys that allow the OpenClaw container to SSH to the host VPS for privileged operations.

## Setup

### Automatic Setup (via Ansible)
The keys are automatically generated during VPS bootstrap:
```bash
make config-vps VPS_IP=<ip>
```

### Manual Setup
If you need to generate keys manually:

```bash
# Generate SSH key pair
ssh-keygen -t ed25519 -C "openclaw@hill90" -f ./secrets/openclaw-ssh/id_ed25519 -N ""

# Create SSH config
cat > ./secrets/openclaw-ssh/config <<EOF
Host hill90-host
    HostName ${TAILSCALE_IP}
    User deploy
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking no
EOF

# Fix permissions
chmod 600 ./secrets/openclaw-ssh/id_ed25519
chmod 644 ./secrets/openclaw-ssh/id_ed25519.pub
chmod 600 ./secrets/openclaw-ssh/config
```

### Add Public Key to Host
```bash
# Copy public key to VPS
scp ./secrets/openclaw-ssh/id_ed25519.pub deploy@<vps-ip>:~/openclaw.pub

# On VPS, add to authorized_keys
ssh deploy@<vps-ip>
cat ~/openclaw.pub >> ~/.ssh/authorized_keys
rm ~/openclaw.pub
```

## Usage from OpenClaw Container

Once deployed, OpenClaw can SSH to the host:

```bash
# Simple hostname check
ssh hill90-host "hostname"

# Manage containers
ssh hill90-host "docker ps"
ssh hill90-host "docker logs api"

# Run deployments
ssh hill90-host "cd /opt/hill90/app && make deploy"

# System operations (requires sudo password or NOPASSWD in sudoers)
ssh hill90-host "sudo systemctl restart docker"
```

## Security Notes
- Keys are mounted read-only in the container
- Keys should NOT be committed to git (already in .gitignore)
- Keys are specific to each VPS deployment
- Use SSH agent forwarding if needed for multi-hop access
