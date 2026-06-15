# ── CloudWatch Log Group ─────────────────────────────────────

resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/ecs/${local.name_prefix}/platform-api"
  retention_in_days = var.log_retention_days
}

# ── ECS Task Definition ─────────────────────────────────────

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.name_prefix}-server"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "${local.name_prefix}-server"
      image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
      essential = true

      portMappings = [{
        containerPort = var.app_port
        protocol      = "tcp"
      }]

      environment = concat([
        { name = "PORT", value = tostring(var.app_port) },
        { name = "ORCHESTRATOR_BASE_URL", value = var.orchestrator_base_url },
        { name = "LAUNCHER_BASE_URL", value = var.launcher_base_url },
        { name = "ORCHESTRATOR_REQUEST_TIMEOUT_MS", value = var.orchestrator_request_timeout_ms },
        { name = "LAUNCHER_REQUEST_TIMEOUT_MS", value = var.launcher_request_timeout_ms },
        { name = "CORS_ORIGINS", value = var.cors_origins },
        { name = "SUPABASE_URL", value = var.supabase_url },
        { name = "NODE_ENV", value = "production" },
        { name = "APP_ENV", value = var.environment },
        { name = "SERVICE_NAME", value = "${local.name_prefix}-platform-api" },
        { name = "DEPLOY_RUN_ID", value = var.deploy_run_id },
        { name = "LEARNING_EMBEDDING_MODEL", value = var.learning_embedding_model },
        ], var.local_relay_ws_url != "" ? [
        { name = "LOCAL_RELAY_WS_URL", value = var.local_relay_ws_url }
        ] : [], var.learning_distillation_model != "" ? [
        { name = "LEARNING_DISTILLATION_MODEL", value = var.learning_distillation_model }
      ] : [])

      secrets = concat(var.supabase_service_role_key_ssm_arn != "" ? [
        {
          name      = "SUPABASE_SERVICE_ROLE_KEY"
          valueFrom = var.supabase_service_role_key_ssm_arn
        }
        ] : [], var.openai_api_key_ssm_arn != "" ? [
        {
          name      = "OPENAI_API_KEY"
          valueFrom = var.openai_api_key_ssm_arn
        }
      ] : [])

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "platform-api"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://localhost:${var.app_port}/livez || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }
    }
  ])
}

# ── ECS Service ──────────────────────────────────────────────

resource "aws_ecs_service" "app" {
  name            = "${local.name_prefix}-server"
  cluster         = local.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "${local.name_prefix}-server"
    container_port   = var.app_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}
