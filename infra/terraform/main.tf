terraform {
  required_version = ">= 1.6"

  required_providers {
    hostinger = {
      source  = "hostinger/hostinger"
      version = "~> 0.1.19"
    }
  }

  # Uncomment to use remote state (recommended for production)
  # backend "s3" {
  #   bucket = "hill90-terraform-state"
  #   key    = "vps/terraform.tfstate"
  #   region = "us-east-1"
  # }
}

# Configure the Hostinger Provider
# API token should be set via environment variable: TF_VAR_hostinger_api_token
provider "hostinger" {
  api_token = var.hostinger_api_token
}

# Data Sources - Query available options
data "hostinger_vps_data_centers" "all" {}

data "hostinger_vps_plans" "all" {}

data "hostinger_vps_templates" "all" {}

# Find AlmaLinux template
locals {
  # Find AlmaLinux 9 template ID
  almalinux_template = [
    for t in data.hostinger_vps_templates.all.templates :
    t if can(regex("(?i)alma.*9", t.name))
  ][0]

  # Select datacenter (prefer US East if available, otherwise first available)
  selected_datacenter = var.datacenter_id != 0 ? var.datacenter_id : [
    for dc in data.hostinger_vps_data_centers.all.data_centers :
    dc.id if can(regex("(?i)us.*east", dc.name))
  ][0]

  # Select VPS plan (default to KVM2 if not specified)
  selected_plan = var.vps_plan != "" ? var.vps_plan : [
    for p in data.hostinger_vps_plans.all.plans :
    p.id if can(regex("(?i)kvm2", p.id))
  ][0]
}

# Create SSH Key resource (if public key provided)
resource "hostinger_vps_ssh_key" "deploy_key" {
  count = var.ssh_public_key != "" ? 1 : 0

  name = "${var.hostname}-deploy-key"
  key  = var.ssh_public_key
}

# Create Post-Install Script (optional)
resource "hostinger_vps_post_install_script" "bootstrap" {
  count = var.create_post_install_script ? 1 : 0

  name = "${var.hostname}-bootstrap"
  content = <<-SCRIPT
    #!/bin/bash
    # Hill90 Initial Bootstrap Script
    echo "Hill90 VPS Bootstrap Started" > /root/bootstrap.log

    # Update system
    dnf update -y >> /root/bootstrap.log 2>&1

    # Install basic tools
    dnf install -y curl wget git vim >> /root/bootstrap.log 2>&1

    echo "Bootstrap Complete" >> /root/bootstrap.log
    SCRIPT
}

# Create VPS Instance
resource "hostinger_vps" "hill90" {
  plan           = local.selected_plan
  data_center_id = local.selected_datacenter
  template_id    = local.almalinux_template.id

  hostname = var.hostname
  password = var.root_password

  # Attach SSH key
  ssh_key_ids = var.ssh_public_key != "" ? [hostinger_vps_ssh_key.deploy_key[0].id] : []

  # Attach post-install script
  post_install_script_id = var.create_post_install_script ? hostinger_vps_post_install_script.bootstrap[0].id : null

  # Use default payment method
  payment_method_id = var.payment_method_id
}

# Outputs
output "vps_id" {
  description = "VPS Instance ID"
  value       = hostinger_vps.hill90.id
}

output "vps_ipv4_address" {
  description = "VPS Public IPv4 Address"
  value       = hostinger_vps.hill90.ipv4_address
}

output "vps_ipv6_address" {
  description = "VPS Public IPv6 Address"
  value       = hostinger_vps.hill90.ipv6_address
}

output "vps_status" {
  description = "VPS Provisioning Status"
  value       = hostinger_vps.hill90.status
}

output "vps_hostname" {
  description = "VPS Hostname"
  value       = hostinger_vps.hill90.hostname
}

output "next_steps" {
  description = "Next steps after VPS provisioning"
  value = <<-EOT
    ========================================
    Hill90 VPS Successfully Provisioned!
    ========================================

    VPS Details:
    - ID: ${hostinger_vps.hill90.id}
    - IPv4: ${hostinger_vps.hill90.ipv4_address}
    - IPv6: ${hostinger_vps.hill90.ipv6_address}
    - Hostname: ${hostinger_vps.hill90.hostname}
    - Status: ${hostinger_vps.hill90.status}

    Next Steps:
    1. Update infra/ansible/inventory/hosts.yml with VPS IP: ${hostinger_vps.hill90.ipv4_address}
    2. Run: make bootstrap
    3. Configure DNS records:
       - api.hill90.com → ${hostinger_vps.hill90.ipv4_address}
       - ai.hill90.com  → ${hostinger_vps.hill90.ipv4_address}
       - hill90.com     → ${hostinger_vps.hill90.ipv4_address}
    4. Run: make deploy
    5. Access your VPS: ssh root@${hostinger_vps.hill90.ipv4_address}
  EOT
}
