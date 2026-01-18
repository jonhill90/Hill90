# Tailscale Device Key (pre-authorized for VPS)
# This generates an auth key that the VPS will use to join the tailnet
resource "tailscale_tailnet_key" "vps_auth_key" {
  reusable      = false
  ephemeral     = false
  preauthorized = true
  expiry        = 7776000 # 90 days
  description   = "Hill90 VPS authentication key"

  # Tags removed - manage access via Tailscale admin console ACLs
  # To add tags, first define them in your Tailscale ACL policy
  # tags = ["tag:server", "tag:hill90"]
}

# Tailscale ACL Policy (optional - defines access rules)
# NOTE: This resource manages the entire ACL, so use with caution
# For now, we'll rely on the default ACL in the Tailscale admin console
# Uncomment and customize if you want to manage ACLs via Terraform:
#
# resource "tailscale_acl" "hill90" {
#   acl = jsonencode({
#     acls = [
#       {
#         action = "accept"
#         src    = ["autogroup:admin"]
#         dst    = ["tag:hill90:*"]
#       },
#       {
#         action = "accept"
#         src    = ["tag:hill90"]
#         dst    = ["tag:hill90:*"]
#       }
#     ]
#     tagOwners = {
#       "tag:hill90"  = ["autogroup:admin"]
#       "tag:server"  = ["autogroup:admin"]
#     }
#   })
# }
