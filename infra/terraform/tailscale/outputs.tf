output "vps_auth_key" {
  description = "Pre-authorized key for VPS to join Tailscale network"
  value       = tailscale_tailnet_key.vps_auth_key.key
  sensitive   = true
}

output "auth_key_id" {
  description = "ID of the generated auth key"
  value       = tailscale_tailnet_key.vps_auth_key.id
}

output "auth_key_expiry" {
  description = "Expiry timestamp of the auth key"
  value       = tailscale_tailnet_key.vps_auth_key.expiry
}
