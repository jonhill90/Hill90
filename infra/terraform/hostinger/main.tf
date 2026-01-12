# SSH Key
resource "hostinger_vps_ssh_key" "bitwarden" {
  name = "Bitwarden"
  key  = var.ssh-public-key
}

# VPS
resource "hostinger_vps" "hill90" {
  plan           = var.vps_plan
  data_center_id = var.vps_data_center_id
  template_id    = var.vps_template_id
  hostname       = var.vps_hostname
  ssh_key_ids    = [hostinger_vps_ssh_key.bitwarden.id]

  depends_on = [
    hostinger_vps_ssh_key.bitwarden
  ]
}
