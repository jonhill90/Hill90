terraform {
  required_version = ">= 1.0"

  required_providers {
    twingate = {
      source  = "twingate/twingate"
      version = "~> 3.0"
    }
  }
}

provider "twingate" {
  api_token = var.twingate_api_key
  network   = var.twingate_network
}
