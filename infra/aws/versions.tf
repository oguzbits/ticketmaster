terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.100"
    }
  }

  # Production remote state uses S3 native locking (OpenTofu 1.10+) with KMS encryption.
  # Bootstrap the state bucket out-of-band and pass -backend-config at deploy time:
  # backend "s3" {
  #   bucket       = "ticketmaster-klon-tfstate"
  #   key          = "production/terraform.tfstate"
  #   region       = "eu-central-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}
