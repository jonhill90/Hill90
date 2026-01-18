variable "tailscale_api_key" {
  description = "Tailscale API key for managing the tailnet"
  type        = string
  sensitive   = true
}

variable "tailscale_tailnet" {
  description = "Tailscale tailnet name (e.g., example.com or example.ts.net)"
  type        = string
}

variable "vps_hostname" {
  description = "Hostname for the VPS in Tailscale network"
  type        = string
  default     = "hill90-vps"
}

variable "enable_ssh" {
  description = "Enable Tailscale SSH for the VPS"
  type        = bool
  default     = true
}

variable "enable_accept_routes" {
  description = "Accept subnet routes advertised by other nodes"
  type        = bool
  default     = true
}
