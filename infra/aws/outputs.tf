output "vpc_id" {
  description = "VPC identifier."
  value       = aws_vpc.main.id
}

output "alb_dns_name" {
  description = "DNS name of the internal HTTPS ALB."
  value       = aws_lb.api.dns_name
}

output "rds_proxy_endpoint" {
  description = "RDS Proxy connection endpoint for API and Worker."
  value       = aws_db_proxy.main.endpoint
}

output "redis_primary_endpoint" {
  description = "Primary TLS endpoint for ElastiCache Redis."
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID."
  value       = aws_cognito_user_pool.main.id
}

output "booking_events_queue_url" {
  description = "SQS queue URL for booking-events."
  value       = module.messaging.booking_events_queue_url
}

output "tickets_bucket_arn" {
  description = "S3 bucket ARN for ticket PDFs."
  value       = module.messaging.tickets_bucket_arn
}
