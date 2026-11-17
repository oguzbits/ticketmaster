resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/aws/ecs/${var.project_name}-${var.environment}"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.main.arn
}

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_lb" "api" {
  name                       = "${var.project_name}-${var.environment}-alb"
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.private_app[*].id
  drop_invalid_header_fields = true
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "api" {
  name                 = "${var.project_name}-${var.environment}-api-tg"
  port                 = 3000
  protocol             = "HTTP"
  vpc_id               = aws_vpc.main.id
  target_type          = "ip"
  deregistration_delay = 30

  health_check {
    path                = "/health/ready"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_wafv2_web_acl" "alb" {
  name  = "${var.project_name}-${var.environment}-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-managed-common"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-managed-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 20

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-per-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project_name}-${var.environment}-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.api.arn
  web_acl_arn  = aws_wafv2_web_acl.alb.arn
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project_name}-${var.environment}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  container_definitions = jsonencode([
    {
      name                   = "api"
      image                  = var.api_image
      essential              = true
      readonlyRootFilesystem = true
      user                   = "1000:1000"
      linuxParameters = {
        capabilities = {
          drop = ["ALL"]
        }
      }
      portMappings = [
        {
          containerPort = 3000
          protocol      = "tcp"
        }
      ]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3000" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "DEMO_LOGIN_ENABLED", value = "false" },
        { name = "UNSAFE_STRATEGIES_ENABLED", value = "false" },
        { name = "MAIL_PROVIDER", value = "ses" },
        { name = "MAIL_FROM", value = var.ses_sender_email },
        { name = "KEYCLOAK_URL", value = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.main.id}" },
      ]
      secrets = [
        { name = "WAITING_ROOM_SIGNING_SECRET", valueFrom = aws_secretsmanager_secret.waiting_room_signing.arn },
        { name = "KEYCLOAK_DEMO_CLIENT_SECRET", valueFrom = aws_secretsmanager_secret.cognito_client.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.ecs.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "api"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "api" {
  name            = "${var.project_name}-${var.environment}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private_app[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_appautoscaling_target" "api" {
  max_capacity       = 20
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.project_name}-${var.environment}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 65.0
    scale_in_cooldown  = 120
    scale_out_cooldown = 30
  }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.project_name}-${var.environment}-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  container_definitions = jsonencode([
    {
      name                   = "worker"
      image                  = var.worker_image
      essential              = true
      readonlyRootFilesystem = true
      user                   = "1000:1000"
      linuxParameters = {
        capabilities = {
          drop = ["ALL"]
        }
      }
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "UNSAFE_STRATEGIES_ENABLED", value = "false" },
        { name = "MAIL_PROVIDER", value = "ses" },
        { name = "MAIL_FROM", value = var.ses_sender_email },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.ecs.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "worker"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "worker" {
  name            = "${var.project_name}-${var.environment}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private_app[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }
}
