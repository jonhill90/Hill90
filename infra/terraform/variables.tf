variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod."
  }
}

variable "datacenter_id" {
  description = "Hostinger datacenter ID (0 = auto-select, or specific datacenter ID)"
  type        = number
  default     = 0  # Will auto-select US East if available

  # Available datacenters can be fetched via Terraform data source:
  # data.hostinger_vps_data_centers.all.data_centers
}

variable "hostname" {
  description = "VPS hostname (FQDN recommended)"
  type        = string
  default     = "hill90-vps.example.com"

  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.hostname))
    error_message = "Hostname must contain only lowercase letters, numbers, dots, and hyphens."
  }
}

variable "root_password" {
  description = "Root password for VPS (leave empty for auto-generated)"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.root_password == "" || length(var.root_password) >= 8
    error_message = "Password must be at least 8 characters long."
  }
}

variable "ssh_public_key" {
  description = "SSH public key for initial VPS access (optional)"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.ssh_public_key == "" || can(regex("^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256)", var.ssh_public_key))
    error_message = "Must be a valid SSH public key or empty string."
  }
}

variable "vps_plan" {
  description = "VPS plan ID (empty = auto-select KVM2 plan)"
  type        = string
  default     = ""

  # Available plans can be fetched via Terraform data source:
  # data.hostinger_vps_plans.all.plans
  # Example: "hostingercom-vps-kvm2-usd-1m"
}

variable "create_post_install_script" {
  description = "Create and attach a post-install bootstrap script"
  type        = bool
  default     = false  # Can be enabled to run initial system updates
}

variable "payment_method_id" {
  description = "Hostinger payment method ID (null = use default)"
  type        = number
  default     = null
}

# Hostinger API Configuration
variable "hostinger_api_token" {
  description = "Hostinger API token for provisioning (if using API directly)"
  type        = string
  sensitive   = true
  default     = ""  # Set via environment variable or terraform.tfvars
}

# Tags
variable "tags" {
  description = "Additional tags for the VPS"
  type        = map(string)
  default     = {}
}
