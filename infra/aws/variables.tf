variable "project_name" {
  description = "Project prefix applied to AWS resources and tags."
  type        = string
  default     = "ticketmaster-klon"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "production"
}

variable "aws_region" {
  description = "Target AWS region."
  type        = string
  default     = "eu-central-1"
}

variable "vpc_cidr" {
  description = "CIDR block for the application VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "domain_name" {
  description = "Public domain name served by the HTTPS listener and Cognito callback URLs."
  type        = string
  default     = "tickets.example.invalid"
}

variable "acm_certificate_arn" {
  description = "ARN of the ACM TLS certificate attached to the ALB HTTPS listener."
  type        = string
  default     = "arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
}

variable "tickets_bucket_name" {
  description = "Globally unique S3 bucket name for rendered ticket PDFs in AWS."
  type        = string
  default     = "ticketmaster-klon-production-tickets"
}

variable "ses_sender_email" {
  description = "Verified SESv2 sender email identity."
  type        = string
  default     = "tickets@ticketmaster-klon.invalid"
}

variable "api_image" {
  description = "Digest-pinned container image URI for the NestJS API."
  type        = string
  default     = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/ticketmaster-api:latest"
}

variable "worker_image" {
  description = "Digest-pinned container image URI for the NestJS Worker."
  type        = string
  default     = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/ticketmaster-worker:latest"
}

variable "db_instance_class" {
  description = "RDS PostgreSQL instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type."
  type        = string
  default     = "cache.t4g.small"
}
