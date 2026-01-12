# VPS Bootstrap Runbook

Guide for bootstrapping a fresh Hill90 VPS.

## Prerequisites

- Terraform installed
- Ansible installed
- SOPS and age installed
- Hostinger API token
- SSH key pair

## Steps

### 1. Provision VPS

```bash
cd infra/terraform
terraform init
terraform apply
```

### 2. Initialize Secrets

```bash
make secrets-init
```

### 3. Configure Secrets

```bash
make secrets-edit ENV=prod
# Fill in all required values
```

### 4. Bootstrap VPS

```bash
VPS_IP=<your_vps_ip> make bootstrap
```

### 5. Configure DNS

Point these domains to your VPS IP:
- api.hill90.com
- ai.hill90.com
- hill90.com

### 6. Deploy Services

```bash
make deploy
```

### 7. Verify

```bash
make health
```

## Troubleshooting

See [Troubleshooting Guide](./troubleshooting.md)
