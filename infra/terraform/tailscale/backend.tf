# Terraform Backend Configuration
# State is stored locally for now
# TODO: Consider migrating to remote backend (S3, Terraform Cloud, etc.)

terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
