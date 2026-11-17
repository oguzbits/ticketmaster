module "messaging" {
  source = "../modules/messaging"

  tickets_bucket_name      = var.tickets_bucket_name
  ses_sender_email         = var.ses_sender_email
  kms_key_arn              = aws_kms_key.main.arn
  enable_s3_prod_hardening = true
}
