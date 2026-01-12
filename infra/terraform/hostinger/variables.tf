variable "api-token" {
  description = "Hostinger API Token"
  type        = string
}

variable "ssh-public-key" {
  description = "SSH public key for VPS access"
  type        = string
}

variable "vps_plan" {
  description = "Hostinger VPS plan ID"
  type        = string
}

variable "vps_data_center_id" {
  description = "Hostinger VPS datacenter ID"
  type        = number
}

variable "vps_template_id" {
  description = "Hostinger VPS template ID"
  type        = number
}

variable "vps_hostname" {
  description = "VPS hostname"
  type        = string
}
