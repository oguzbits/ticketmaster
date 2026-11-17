variable "aws_endpoint_url" {
  description = "Local AWS emulator endpoint (Floci)."
  type        = string
  default     = "http://localhost:45660"
}

variable "aws_region" {
  description = "AWS region matching AWS_REGION in local config."
  type        = string
  default     = "us-east-1"
}
