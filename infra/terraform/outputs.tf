output "environment" {
  description = "Environment name"
  value       = var.environment
}

output "hostname" {
  description = "VPS hostname"
  value       = var.hostname
}

output "vps_plan" {
  description = "VPS plan/size"
  value       = var.vps_plan
}

output "datacenter_code" {
  description = "Datacenter location"
  value       = var.datacenter_code
}

output "configuration_summary" {
  description = "Summary of VPS configuration"
  value = {
    environment     = var.environment
    hostname        = var.hostname
    datacenter      = var.datacenter_code
    plan            = var.vps_plan
    ipv6_enabled    = var.enable_ipv6
    backups_enabled = var.enable_backups
  }
}

# Provisioning Instructions
output "provisioning_instructions" {
  description = "Instructions for provisioning the VPS"
  value = <<-EOT
    ========================================
    Hill90 VPS Provisioning Instructions
    ========================================

    Option 1: Via Hostinger hPanel (Manual)
    ----------------------------------------
    1. Login to https://hpanel.hostinger.com/
    2. Navigate to VPS section
    3. Create new VPS with:
       - OS: AlmaLinux 9
       - Datacenter: ${var.datacenter_code != "" ? var.datacenter_code : "[Select preferred location]"}
       - Plan: ${var.vps_plan}
       - Hostname: ${var.hostname}
    4. Add your SSH key
    5. Note the VPS IP address

    Option 2: Via MCP Tools (Recommended)
    --------------------------------------
    Use Claude Code with MCP tools:

    1. Purchase VPS:
       Tool: mcp__MCP_DOCKER__VPS_purchaseNewVirtualMachineV1
       Parameters:
         - item_id: [Get from billing_getCatalogItemListV1]
         - setup: [Configuration string]

    2. Setup VPS:
       Tool: mcp__MCP_DOCKER__VPS_setupPurchasedVirtualMachineV1
       Parameters:
         - virtualMachineId: [From purchase response]
         - template_id: [AlmaLinux 9 template ID]
         - data_center_id: [From hosting_listAvailableDatacentersV1]
         - enable_backups: ${var.enable_backups}
         - hostname: ${var.hostname}

    Option 3: Via Hostinger API (Advanced)
    ---------------------------------------
    Use Hostinger REST API with appropriate endpoints

    ========================================
    Next Steps After Provisioning
    ========================================
    1. Update infra/ansible/inventory/hosts.yml with VPS IP
    2. Run: make bootstrap
    3. Configure DNS records
    4. Run: make deploy
  EOT
}
