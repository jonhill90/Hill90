output "access_token" {
  description = "Twingate Connector Access Token (for docker-compose)"
  value       = twingate_connector_tokens.hill90_tokens.access_token
  sensitive   = true
}

output "refresh_token" {
  description = "Twingate Connector Refresh Token (for docker-compose)"
  value       = twingate_connector_tokens.hill90_tokens.refresh_token
  sensitive   = true
}

output "network_name" {
  description = "Twingate Network Name"
  value       = var.twingate_network
}

output "remote_network_id" {
  description = "Twingate Remote Network ID"
  value       = twingate_remote_network.hill90_vps.id
}

output "connector_id" {
  description = "Twingate Connector ID"
  value       = twingate_connector.hill90_connector.id
}
