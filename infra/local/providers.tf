provider "aws" {
  region                      = var.aws_region
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  # Floci STS resolves 000000000000 so SESv2 ARNs remain well-formed during refresh/destroy.
  skip_requesting_account_id = false
  s3_use_path_style          = true

  endpoints {
    s3    = var.aws_endpoint_url
    sqs   = var.aws_endpoint_url
    sesv2 = var.aws_endpoint_url
    kms   = var.aws_endpoint_url
    sts   = var.aws_endpoint_url
  }
}
