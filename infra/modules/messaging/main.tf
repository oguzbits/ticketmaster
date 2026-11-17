resource "aws_sqs_queue" "booking_events_dlq" {
  name                      = var.booking_events_dlq_name
  message_retention_seconds = var.message_retention_seconds
  kms_master_key_id         = var.kms_key_arn
}

resource "aws_sqs_queue" "booking_events" {
  name                       = var.booking_events_queue_name
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = var.message_retention_seconds
  kms_master_key_id          = var.kms_key_arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.booking_events_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "booking_events_dlq" {
  count     = var.enable_s3_prod_hardening ? 1 : 0
  queue_url = aws_sqs_queue.booking_events_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.booking_events.arn]
  })
}

resource "aws_s3_bucket" "tickets" {
  bucket = var.tickets_bucket_name
}

resource "aws_s3_bucket_public_access_block" "tickets" {
  count  = var.enable_s3_prod_hardening ? 1 : 0
  bucket = aws_s3_bucket.tickets.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "tickets" {
  count  = var.enable_s3_prod_hardening ? 1 : 0
  bucket = aws_s3_bucket.tickets.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tickets" {
  count  = var.enable_s3_prod_hardening ? 1 : 0
  bucket = aws_s3_bucket.tickets.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "tickets" {
  count  = var.enable_s3_prod_hardening ? 1 : 0
  bucket = aws_s3_bucket.tickets.id

  rule {
    id     = "cleanup-multipart-and-old-versions"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

data "aws_iam_policy_document" "tickets_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    resources = [
      aws_s3_bucket.tickets.arn,
      "${aws_s3_bucket.tickets.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "tickets_tls_only" {
  count  = var.enforce_tls_bucket_policy ? 1 : 0
  bucket = aws_s3_bucket.tickets.id
  policy = data.aws_iam_policy_document.tickets_tls_only.json

  depends_on = [aws_s3_bucket_public_access_block.tickets]
}

resource "aws_sesv2_email_identity" "sender" {
  email_identity = var.ses_sender_email
}
