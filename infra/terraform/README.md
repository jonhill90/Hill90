# Hill90 Terraform Configuration

This directory contains Terraform configuration for provisioning the Hill90 VPS on Hostinger.

## Prerequisites

- [Terraform](https://www.terraform.io/downloads) >= 1.6
- Hostinger API token (get from [hPanel](https://hpanel.hostinger.com/profile/api))
- SSH key pair for VPS access

## Quick Start

### 1. Configure Variables

```bash
# Copy example configuration
cp terraform.tfvars.example terraform.tfvars

# Edit with your values
vim terraform.tfvars
```

### 2. Set API Token

```bash
# Set via environment variable (recommended)
export TF_VAR_hostinger_api_token="your_hostinger_api_token_here"

# Or add to terraform.tfvars (NOT recommended for security)
```

### 3. Initialize Terraform

```bash
terraform init
```

### 4. Review Plan

```bash
# See what Terraform will create
terraform plan
```

This will show:
- Available datacenters, plans, and OS templates
- The VPS configuration that will be created

### 5. Provision VPS

```bash
terraform apply
```

Review the plan and type `yes` to proceed.

### 6. Get VPS Details

```bash
terraform output
```

This will show:
- VPS ID
- IPv4 and IPv6 addresses
- Hostname
- Status
- Next steps

## Configuration Options

### Required Variables

- `hostinger_api_token` - Your Hostinger API token

### Optional Variables

- `environment` - Environment name (default: "prod")
- `hostname` - VPS hostname (default: "hill90-vps.example.com")
- `datacenter_id` - Datacenter ID (default: 0 = auto-select US East)
- `vps_plan` - Plan ID (default: "" = auto-select KVM2)
- `root_password` - Root password (default: "" = auto-generated)
- `ssh_public_key` - SSH public key (default: "" = none)
- `create_post_install_script` - Create bootstrap script (default: false)
- `payment_method_id` - Payment method (default: null = use default)

### Setting Variables

**Via terraform.tfvars:**
```hcl
hostname = "hill90-vps.yourdomain.com"
ssh_public_key = "ssh-ed25519 AAAAC3... user@host"
```

**Via Environment Variables:**
```bash
export TF_VAR_hostname="hill90-vps.yourdomain.com"
export TF_VAR_ssh_public_key="ssh-ed25519 AAAAC3... user@host"
```

**Via Command Line:**
```bash
terraform apply -var="hostname=hill90-vps.yourdomain.com"
```

## Querying Available Options

### List Available Datacenters

```bash
terraform console
> data.hostinger_vps_data_centers.all.data_centers
```

### List Available Plans

```bash
terraform console
> data.hostinger_vps_plans.all.plans
```

### List Available OS Templates

```bash
terraform console
> data.hostinger_vps_templates.all.templates
```

## Resources Created

This configuration creates:

1. **hostinger_vps.hill90** - Main VPS instance
   - OS: AlmaLinux 9
   - Plan: KVM2 (or specified)
   - Datacenter: US East (or specified)

2. **hostinger_vps_ssh_key.deploy_key** (optional) - SSH key for access
   - Created if `ssh_public_key` is provided

3. **hostinger_vps_post_install_script.bootstrap** (optional) - Bootstrap script
   - Created if `create_post_install_script` is true
   - Runs system updates and installs basic tools

## Outputs

After provisioning, Terraform outputs:

- `vps_id` - VPS instance ID
- `vps_ipv4_address` - Public IPv4 address
- `vps_ipv6_address` - Public IPv6 address
- `vps_status` - Provisioning status
- `vps_hostname` - VPS hostname
- `next_steps` - Instructions for continuing setup

## Next Steps After Provisioning

1. Update Ansible inventory with VPS IP:
   ```bash
   vim ../ansible/inventory/hosts.yml
   # Set ansible_host to the VPS IPv4 address
   ```

2. Bootstrap VPS with Ansible:
   ```bash
   cd ../..
   make bootstrap
   ```

3. Configure DNS records to point to VPS IP

4. Deploy services:
   ```bash
   make deploy
   ```

## State Management

### Local State (Development)

By default, Terraform stores state locally in `terraform.tfstate`.

**Important:** Don't commit state files to git! They're already in `.gitignore`.

### Remote State (Production - Recommended)

For production, use remote state to enable team collaboration:

1. Uncomment the backend configuration in `main.tf`:
   ```hcl
   backend "s3" {
     bucket = "hill90-terraform-state"
     key    = "vps/terraform.tfstate"
     region = "us-east-1"
   }
   ```

2. Create S3 bucket for state storage

3. Re-initialize Terraform:
   ```bash
   terraform init -migrate-state
   ```

## Troubleshooting

### "API token is invalid"

- Verify your API token is correct
- Check it's set as environment variable: `echo $TF_VAR_hostinger_api_token`
- Generate a new token at https://hpanel.hostinger.com/profile/api

### "No AlmaLinux template found"

The configuration auto-selects AlmaLinux 9. If not found:
- List available templates: `terraform console` → `data.hostinger_vps_templates.all.templates`
- Update the regex in `main.tf` or specify exact template_id

### "Invalid datacenter_id"

- List available datacenters: `terraform console` → `data.hostinger_vps_data_centers.all.data_centers`
- Set specific `datacenter_id` in terraform.tfvars

### "Invalid plan"

- List available plans: `terraform console` → `data.hostinger_vps_plans.all.plans`
- Set specific `vps_plan` in terraform.tfvars

## Destroying Resources

To destroy the VPS:

```bash
terraform destroy
```

**Warning:** This will permanently delete the VPS and all its data!

## Additional Resources

- [Hostinger Terraform Provider Documentation](https://registry.terraform.io/providers/hostinger/hostinger/latest/docs)
- [Hostinger API Documentation](https://api.hostinger.com/docs)
- [Terraform Documentation](https://www.terraform.io/docs)
