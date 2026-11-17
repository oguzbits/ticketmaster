data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

data "aws_iam_policy_document" "kms_key" {
  statement {
    sid       = "AllowAccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid = "AllowCloudWatchLogsEncryption"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

resource "aws_kms_key" "main" {
  description             = "Customer-managed KMS key for ${var.project_name} (${var.environment})."
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms_key.json
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.project_name}-${var.environment}"
  target_key_id = aws_kms_key.main.key_id
}

resource "aws_secretsmanager_secret" "waiting_room_signing" {
  name                    = "${var.project_name}/${var.environment}/waiting-room-signing-secret"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret" "redis_auth" {
  name                    = "${var.project_name}/${var.environment}/redis-auth-token"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret" "cognito_client" {
  name                    = "${var.project_name}/${var.environment}/cognito-client-secret"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 30
}

# Security groups: strict tier isolation without wide ingress/egress CIDRs.
resource "aws_security_group" "alb" {
  name        = "${var.project_name}-${var.environment}-alb-sg"
  description = "HTTPS ingress from CloudFront origin-facing IPs to ECS API tasks."
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.api.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "api" {
  name        = "${var.project_name}-${var.environment}-api-sg"
  description = "ECS API tasks."
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "api_to_rds_proxy" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.rds_proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "api_to_redis" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.redis.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "api_to_vpc_endpoints" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.vpc_endpoints.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "worker" {
  name        = "${var.project_name}-${var.environment}-worker-sg"
  description = "ECS Worker tasks."
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_egress_rule" "worker_to_rds_proxy" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.rds_proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "worker_to_redis" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.redis.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "worker_to_vpc_endpoints" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.vpc_endpoints.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "vpc_endpoints" {
  name        = "${var.project_name}-${var.environment}-vpce-sg"
  description = "Private interface endpoints for AWS services."
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "vpce_from_api" {
  security_group_id            = aws_security_group.vpc_endpoints.id
  referenced_security_group_id = aws_security_group.api.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "vpce_from_worker" {
  security_group_id            = aws_security_group.vpc_endpoints.id
  referenced_security_group_id = aws_security_group.worker.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "rds_proxy" {
  name        = "${var.project_name}-${var.environment}-rds-proxy-sg"
  description = "RDS Proxy connection pooler."
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "rds_proxy_from_api" {
  security_group_id            = aws_security_group.rds_proxy.id
  referenced_security_group_id = aws_security_group.api.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "rds_proxy_from_worker" {
  security_group_id            = aws_security_group.rds_proxy.id
  referenced_security_group_id = aws_security_group.worker.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "rds_proxy_to_rds" {
  security_group_id            = aws_security_group.rds_proxy.id
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "rds" {
  name        = "${var.project_name}-${var.environment}-rds-sg"
  description = "PostgreSQL primary database."
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_proxy" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.rds_proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "redis" {
  name        = "${var.project_name}-${var.environment}-redis-sg"
  description = "ElastiCache Redis replication group."
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_api" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.api.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_worker" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.worker.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

# IAM roles for ECS task execution, API, and Worker (least privilege).
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${var.project_name}-${var.environment}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.waiting_room_signing.arn,
      aws_secretsmanager_secret.redis_auth.arn,
      aws_secretsmanager_secret.cognito_client.arn,
      aws_db_instance.postgres.master_user_secret[0].secret_arn,
    ]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name   = "read-runtime-secrets"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_execution_secrets.json
}

resource "aws_iam_role" "api_task" {
  name               = "${var.project_name}-${var.environment}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "api_task" {
  statement {
    sid       = "ReadAndPresignTickets"
    actions   = ["s3:GetObject"]
    resources = ["${module.messaging.tickets_bucket_arn}/*"]
  }

  statement {
    sid       = "DecryptTicketObjects"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "api_task" {
  name   = "api-least-privilege"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json
}

resource "aws_iam_role" "worker_task" {
  name               = "${var.project_name}-${var.environment}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "worker_task" {
  statement {
    sid = "ConsumeAndReplayBookingEvents"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
    ]
    resources = [
      module.messaging.booking_events_queue_arn,
      module.messaging.booking_events_dlq_arn,
    ]
  }

  statement {
    sid = "StoreAndCleanupTickets"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${module.messaging.tickets_bucket_arn}/*"]
  }

  statement {
    sid = "SendTicketEmails"
    actions = [
      "ses:SendEmail",
      "ses:SendRawEmail",
    ]
    resources = [module.messaging.ses_sender_identity_arn]
  }

  statement {
    sid = "UseCustomerManagedKey"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "worker_task" {
  name   = "worker-least-privilege"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.worker_task.json
}
