resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}/app"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.app.arn
}

resource "aws_cloudwatch_log_group" "exec" {
  count = var.enable_execute_command ? 1 : 0

  name              = "/ecs/${local.name}/exec"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.app.arn
}

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = var.container_insights
  }

  dynamic "configuration" {
    for_each = var.enable_execute_command ? [1] : []
    content {
      execute_command_configuration {
        kms_key_id = aws_kms_key.app.arn
        logging    = "OVERRIDE"

        log_configuration {
          cloud_watch_encryption_enabled = true
          cloud_watch_log_group_name     = aws_cloudwatch_log_group.exec[0].name
        }
      }
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

locals {
  app_environment = merge(var.app_environment, {
    NODE_ENV         = "production"
    PORT             = tostring(var.container_port)
    APP_VERSION      = var.image_tag
    APP_BASE_URL     = var.app_base_url
    ISMS_UPLOADS_DIR = local.uploads_path
    ISMS_BACKUP_DIR  = local.backup_dir
    UPLOAD_AV_MODE   = "required"
    }, var.restore_drill_enabled ? {} : {
    ISMS_RESTORE_DRILL_DISABLED = "1"
  })

  default_capabilities = [
    "AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "MKNOD",
    "NET_BIND_SERVICE", "NET_RAW", "SETFCAP", "SETGID", "SETPCAP", "SETUID", "SYS_CHROOT",
  ]
  dropped_capabilities = var.enable_execute_command ? [
    for c in local.default_capabilities : c if !contains(["SETUID", "SETGID"], c)
  ] : ["ALL"]

  app_container = {
    name      = local.container_name
    image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      name          = "http"
      containerPort = var.container_port
      hostPort      = var.container_port
      protocol      = "tcp"
    }]

    environment = [for k in sort(keys(local.app_environment)) : { name = k, value = local.app_environment[k] }]
    secrets     = [for k in sort(tolist(local.secret_names)) : { name = k, valueFrom = aws_secretsmanager_secret.app[k].arn }]

    mountPoints = [
      { sourceVolume = "app-data", containerPath = local.app_data_path, readOnly = false },
      { sourceVolume = "state", containerPath = local.state_mount_path, readOnly = false },
      { sourceVolume = "uploads", containerPath = local.uploads_path, readOnly = false },
    ]

    readonlyRootFilesystem = false

    linuxParameters = {
      initProcessEnabled = true
      capabilities       = { drop = local.dropped_capabilities }
    }

    stopTimeout = 30

    healthCheck = {
      command = [
        "CMD", "node", "-e",
        "require('node:http').get('http://127.0.0.1:${var.container_port}/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))",
      ]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 120
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = local.region
        awslogs-stream-prefix = "app"
        mode                  = "non-blocking"
        max-buffer-size       = "25m"
      }
    }
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.name}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([local.app_container])

  volume {
    name = "app-data"
  }

  volume {
    name = "state"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.this.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.state.id
        iam             = "ENABLED"
      }
    }
  }

  volume {
    name = "uploads"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.this.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.uploads.id
        iam             = "ENABLED"
      }
    }
  }
}

resource "aws_ecs_service" "app" {
  name             = "${local.name}-app"
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.app.arn
  desired_count    = local.desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  enable_execute_command            = var.enable_execute_command
  health_check_grace_period_seconds = var.health_check_grace_period_seconds
  enable_ecs_managed_tags           = true
  propagate_tags                    = "SERVICE"
  wait_for_steady_state             = false

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = local.container_name
    container_port   = var.container_port
  }

  lifecycle {
    ignore_changes = [task_definition]

    precondition {
      condition     = length(local.private_subnet_ids) >= 1
      error_message = "The service needs private subnets with outbound internet access (existing_private_subnet_ids)."
    }
  }

  depends_on = [
    aws_lb_listener.https,
    aws_efs_mount_target.this,
    aws_efs_file_system_policy.this,
    aws_iam_role_policy.execution,
    aws_iam_role_policy.task,
  ]
}
