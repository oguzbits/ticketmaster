resource "aws_kms_key" "local" {
  description         = "Local Floci KMS key for messaging and ticket SSE-KMS parity."
  enable_key_rotation = true
}

module "messaging" {
  source = "../modules/messaging"

  kms_key_arn               = aws_kms_key.local.arn
  enable_s3_prod_hardening  = true
  enforce_tls_bucket_policy = false
}
