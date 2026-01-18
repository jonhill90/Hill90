variable "twingate_api_key" {
  description = "API key for Twingate provider authentication"
  type        = string
  sensitive   = true
}

variable "twingate_network" {
  description = "Twingate network name (e.g., hill90.twingate.com)"
  type        = string
}
