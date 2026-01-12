terraform {
  required_version = ">= 1.9"

  required_providers {
    hostinger = {
      source  = "hostinger/hostinger"
      version = "~> 0.1.19"
    }
  }
}

provider "hostinger" {
  api_token = var.api-token
}
