output "booking_events_queue_url" {
  description = "Local Floci SQS URL for booking-events."
  value       = module.messaging.booking_events_queue_url
}

output "booking_events_dlq_url" {
  description = "Local Floci SQS URL for booking-events-dlq."
  value       = module.messaging.booking_events_dlq_url
}

output "tickets_bucket_name" {
  description = "Local Floci S3 bucket for ticket PDFs."
  value       = module.messaging.tickets_bucket_name
}

output "ses_sender_identity_arn" {
  description = "Local Floci SESv2 verified sender identity ARN."
  value       = module.messaging.ses_sender_identity_arn
}
