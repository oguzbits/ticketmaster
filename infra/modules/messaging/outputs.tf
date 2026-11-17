output "booking_events_queue_url" {
  description = "URL of the primary booking-events SQS queue."
  value       = aws_sqs_queue.booking_events.url
}

output "booking_events_queue_arn" {
  description = "ARN of the primary booking-events SQS queue."
  value       = aws_sqs_queue.booking_events.arn
}

output "booking_events_dlq_url" {
  description = "URL of the booking-events dead-letter queue."
  value       = aws_sqs_queue.booking_events_dlq.url
}

output "booking_events_dlq_arn" {
  description = "ARN of the booking-events dead-letter queue."
  value       = aws_sqs_queue.booking_events_dlq.arn
}

output "tickets_bucket_name" {
  description = "Name of the S3 bucket storing rendered ticket PDFs."
  value       = aws_s3_bucket.tickets.bucket
}

output "tickets_bucket_arn" {
  description = "ARN of the S3 bucket storing rendered ticket PDFs."
  value       = aws_s3_bucket.tickets.arn
}

output "ses_sender_identity_arn" {
  description = "ARN of the verified SESv2 sender email identity."
  value       = aws_sesv2_email_identity.sender.arn
}
