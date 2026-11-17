resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-${var.environment}-db-subnets"
  subnet_ids = aws_subnet.private_data[*].id
}

resource "aws_db_parameter_group" "postgres18" {
  name   = "${var.project_name}-${var.environment}-pg18"
  family = "postgres18"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_db_instance" "postgres" {
  identifier     = "${var.project_name}-${var.environment}-pg"
  engine         = "postgres"
  engine_version = "18"
  instance_class = var.db_instance_class

  allocated_storage     = 50
  max_allocated_storage = 250
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.main.arn

  db_name                       = "app"
  username                      = "app_owner"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.main.arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.postgres18.name
  publicly_accessible    = false
  multi_az               = true

  iam_database_authentication_enabled   = true
  backup_retention_period               = 14
  deletion_protection                   = true
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${var.project_name}-${var.environment}-pg-final"
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.main.arn
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
}

data "aws_iam_policy_document" "rds_proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_proxy" {
  name               = "${var.project_name}-${var.environment}-rds-proxy"
  assume_role_policy = data.aws_iam_policy_document.rds_proxy_assume.json
}

data "aws_iam_policy_document" "rds_proxy_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.postgres.master_user_secret[0].secret_arn]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "rds_proxy_secrets" {
  name   = "read-db-master-secret"
  role   = aws_iam_role.rds_proxy.id
  policy = data.aws_iam_policy_document.rds_proxy_secrets.json
}

# Managed equivalent of local PgBouncer in transaction-pooling mode (ADR 0005).
resource "aws_db_proxy" "main" {
  name                   = "${var.project_name}-${var.environment}-proxy"
  engine_family          = "POSTGRESQL"
  require_tls            = true
  idle_client_timeout    = 1800
  role_arn               = aws_iam_role.rds_proxy.arn
  vpc_security_group_ids = [aws_security_group.rds_proxy.id]
  vpc_subnet_ids         = aws_subnet.private_data[*].id

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "REQUIRED"
    secret_arn  = aws_db_instance.postgres.master_user_secret[0].secret_arn
  }
}

resource "aws_db_proxy_default_target_group" "main" {
  db_proxy_name = aws_db_proxy.main.name

  connection_pool_config {
    connection_borrow_timeout    = 30
    max_connections_percent      = 80
    max_idle_connections_percent = 50
    session_pinning_filters      = ["EXCLUDE_VARIABLE_SETS"]
  }
}

resource "aws_db_proxy_target" "postgres" {
  db_proxy_name          = aws_db_proxy.main.name
  target_group_name      = aws_db_proxy_default_target_group.main.name
  db_instance_identifier = aws_db_instance.postgres.identifier
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.project_name}-${var.environment}-redis-subnets"
  subnet_ids = aws_subnet.private_data[*].id
}

resource "aws_elasticache_user" "default_admin" {
  user_id              = "${var.project_name}-admin"
  user_name            = "default"
  access_string        = "on ~* +@all"
  engine               = "REDIS"
  no_password_required = true
}

resource "aws_elasticache_user_group" "main" {
  engine        = "REDIS"
  user_group_id = "${var.project_name}-${var.environment}-redis-users"
  user_ids      = [aws_elasticache_user.default_admin.user_id]
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${var.project_name}-${var.environment}-redis"
  description          = "Redis for distributed locks, waiting room, rate limits, cache, and SSE pub/sub."
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_clusters   = 2
  port                 = 6379

  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.main.arn
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  user_group_ids             = [aws_elasticache_user_group.main.user_group_id]
}
