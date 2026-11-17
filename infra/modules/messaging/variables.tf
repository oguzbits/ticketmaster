variable "booking_events_queue_name" {
  description = "Main SQS queue name matching QUEUE_NAME.BOOKING_EVENTS in packages/shared."
  type        = string
  default     = "booking-events"
}

variable "booking_events_dlq_name" {
  description = "Dead-letter SQS queue name matching QUEUE_NAME.BOOKING_EVENTS_DLQ in packages/shared."
  type        = string
  default     = "booking-events-dlq"
}

variable "visibility_timeout_seconds" {
  description = "SQS visibility timeout matching QUEUE_POLICY.VISIBILITY_TIMEOUT_SECONDS in packages/shared."
  type        = number
  default     = 120
}

variable "message_retention_seconds" {
  description = "SQS message retention matching QUEUE_POLICY.MESSAGE_RETENTION_SECONDS in packages/shared (4 days)."
  type        = number
  default     = 345600
}

variable "max_receive_count" {
  description = "Maximum receive count before redrive to DLQ matching QUEUE_POLICY.MAX_RECEIVE_COUNT in packages/shared."
  type        = number
  default     = 5
}

variable "tickets_bucket_name" {
  description = "S3 bucket name for rendered ticket PDFs matching BUCKET_NAME.TICKETS in packages/shared."
  type        = string
  default     = "tickets"
}

variable "ses_sender_email" {
  description = "Verified SESv2 sender email identity matching SES_IDENTITY.TICKETS_FROM in packages/shared."
  type        = string
  default     = "tickets@ticketmaster-klon.invalid"
}

variable "kms_key_arn" {
  description = "KMS key ARN for SQS and S3 SSE-KMS encryption."
  type        = string
}

variable "enable_s3_prod_hardening" {
  description = "Enable S3 public access block, versioning, SSE-KMS, lifecycle, and SQS redrive allow policy."
  type        = bool
  default     = true
}

variable "enforce_tls_bucket_policy" {
  description = "Deny non-HTTPS S3 transport via bucket policy (disable only for local plain-HTTP emulator)."
  type        = bool
  default     = true
}
