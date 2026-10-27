mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["eu-west-2a", "eu-west-2b", "eu-west-2c"]
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111122223333"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  mock_data "aws_region" {
    defaults = {
      region = "eu-west-2"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:eu-west-2:111122223333:key/00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:eu-west-2:111122223333:loadbalancer/app/isms-test/0000000000000000"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:eu-west-2:111122223333:targetgroup/app-0000/0000000000000000"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/mock"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:eu-west-2:111122223333:log-group:mock"
    }
  }

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn = "arn:aws:ecr:eu-west-2:111122223333:repository/isms-test"
    }
  }

  mock_resource "aws_efs_file_system" {
    defaults = {
      arn = "arn:aws:elasticfilesystem:eu-west-2:111122223333:file-system/fs-00000000"
    }
  }

  mock_resource "aws_efs_access_point" {
    defaults = {
      arn = "arn:aws:elasticfilesystem:eu-west-2:111122223333:access-point/fsap-00000000"
    }
  }

  mock_resource "aws_secretsmanager_secret" {
    defaults = {
      arn = "arn:aws:secretsmanager:eu-west-2:111122223333:secret:mock-000000"
    }
  }

  mock_resource "aws_db_instance" {
    defaults = {
      arn = "arn:aws:rds:eu-west-2:111122223333:db:isms-test"
    }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = {
      arn = "arn:aws:ecs:eu-west-2:111122223333:cluster/isms-test"
    }
  }

  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn = "arn:aws:ecs:eu-west-2:111122223333:task-definition/isms-test-app:1"
    }
  }

  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::isms-test-import-111122223333"
    }
  }

  mock_resource "aws_backup_vault" {
    defaults = {
      arn = "arn:aws:backup:eu-west-2:111122223333:backup-vault:isms-test"
    }
  }

  mock_resource "aws_backup_plan" {
    defaults = {
      arn = "arn:aws:backup:eu-west-2:111122223333:backup-plan:00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_ecs_service" {
    defaults = {
      id = "arn:aws:ecs:eu-west-2:111122223333:service/isms-test/isms-test-app"
    }
  }
}

variables {
  aws_region      = "eu-west-2"
  environment     = "test"
  app_base_url    = "https://isms.example.com"
  certificate_arn = "arn:aws:acm:eu-west-2:111122223333:certificate/00000000-0000-0000-0000-000000000000"
}

run "default_stack_rolls_deploys_against_rds" {
  command = apply

  variables {
    desired_count = 3
  }

  assert {
    condition     = aws_ecs_service.app.desired_count == 3
    error_message = "The service must honour desired_count."
  }

  assert {
    condition     = aws_ecs_service.app.deployment_minimum_healthy_percent == 100 && aws_ecs_service.app.deployment_maximum_percent == 200
    error_message = "Deploys must roll without losing capacity."
  }

  assert {
    condition     = aws_db_instance.this.engine == "postgres" && aws_db_instance.this.storage_encrypted && !aws_db_instance.this.publicly_accessible
    error_message = "The stack must always create an encrypted, private RDS PostgreSQL instance."
  }

  assert {
    condition     = one([for p in aws_db_parameter_group.this.parameter : p.value if p.name == "rds.force_ssl"]) == "1"
    error_message = "RDS must refuse connections without TLS."
  }

  assert {
    condition     = contains(keys(aws_secretsmanager_secret.app), "DATABASE_URL") && length(aws_secretsmanager_secret_version.database_url) == 1
    error_message = "The stack must create and populate DATABASE_URL."
  }

  assert {
    condition     = output.database_url_query == "sslmode=verify-full&sslrootcert=/etc/ssl/rds/global-bundle.pem"
    error_message = "DATABASE_URL must verify the server against the RDS CA bundle baked into the image (Dockerfile)."
  }

  assert {
    condition = alltrue([
      for part in ["CREATE DATABASE isms TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'", "psql \"$DATABASE_URL\""] :
      strcontains(jsondecode(output.create_database_task_overrides).containerOverrides[0].command[2], part)
    ]) && jsondecode(output.create_database_task_overrides).containerOverrides[0].name == "app"
    error_message = "The one-off database task must create db_name with the C collation that db.js requires, then connect to it."
  }

  assert {
    condition     = strcontains(jsondecode(output.sqlite_copy_task_overrides).containerOverrides[0].command[2], "node scripts/sqlite-to-postgres.js --sqlite /app/var/iso27001.db --pg \"$DATABASE_URL\"")
    error_message = "The cutover copy must read the SQLite file the import task stages on EFS."
  }

  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment : e if e.name == "DB_PATH"]) == 0
    error_message = "No SQLite setting may reach the app."
  }

  assert {
    condition = contains(
      jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment,
      { name = "ISMS_RESTORE_DRILL_DISABLED", value = "1" }
    )
    error_message = "With no scheduled recovery generations the restore drill must be off by default."
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.task_to_rds.referenced_security_group_id == aws_security_group.rds.id && aws_vpc_security_group_ingress_rule.rds_from_task.referenced_security_group_id == aws_security_group.task.id
    error_message = "Tasks (and only tasks) must reach RDS."
  }

  assert {
    condition     = toset([for m in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].mountPoints : m.containerPath]) == toset(["/app/data", "/app/var", "/app/uploads"])
    error_message = "The container must mount /app/data (ephemeral), /app/var and /app/uploads (EFS)."
  }

  assert {
    condition = contains(
      jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment,
      { name = "ISMS_BACKUP_DIR", value = "/app/var/backups" }
    )
    error_message = "Backups must be written to EFS, outside the uploads tree."
  }

  assert {
    condition     = toset([for s in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].secrets : s.name]) == toset(["SESSION_SECRET", "ISMS_MASTER_KEY", "DATABASE_URL", "RESEND_API_KEY"])
    error_message = "Default secrets must be SESSION_SECRET, ISMS_MASTER_KEY, DATABASE_URL and RESEND_API_KEY."
  }

  assert {
    condition     = aws_lb_target_group.app.health_check[0].path == "/readyz"
    error_message = "The load balancer must gate on /readyz by default."
  }

  assert {
    condition     = length(aws_vpc.this) == 1 && length(aws_subnet.private) == 2 && length(aws_nat_gateway.this) == 1
    error_message = "The default network is a new VPC over two AZs with one NAT gateway."
  }

  assert {
    condition     = length(aws_efs_mount_target.this) == 2
    error_message = "EFS needs one mount target per private subnet."
  }
}

run "extra_database_url_options_follow_the_tls_settings" {
  command = plan

  variables {
    database_url_options = "connect_timeout=10"
  }

  assert {
    condition     = output.database_url_query == "sslmode=verify-full&sslrootcert=/etc/ssl/rds/global-bundle.pem&connect_timeout=10"
    error_message = "database_url_options must be appended after the fixed TLS settings."
  }
}

run "tls_settings_cannot_be_weakened" {
  command = plan

  variables {
    database_url_options = "sslmode=require"
  }

  expect_failures = [var.database_url_options]
}

run "load_balancer_tls_cannot_go_below_1_2" {
  command = plan

  variables {
    ssl_policy = "ELBSecurityPolicy-2016-08"
  }

  expect_failures = [var.ssl_policy]
}

run "the_maintenance_database_is_not_a_valid_db_name" {
  command = plan

  variables {
    db_name = "postgres"
  }

  expect_failures = [var.db_name]
}

run "restore_drill_can_be_turned_on" {
  command = apply

  variables {
    restore_drill_enabled = true
  }

  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment : e if e.name == "ISMS_RESTORE_DRILL_DISABLED"]) == 0
    error_message = "restore_drill_enabled must leave the drill on."
  }
}

run "first_apply_keeps_the_service_at_zero" {
  command = apply

  variables {
    service_enabled = false
  }

  assert {
    condition     = aws_ecs_service.app.desired_count == 0
    error_message = "service_enabled = false must scale the service to zero."
  }
}

run "existing_vpc_is_used_as_is" {
  command = apply

  variables {
    existing_vpc_id              = "vpc-0123456789abcdef0"
    existing_public_subnet_ids   = ["subnet-0000000000000000a", "subnet-0000000000000000b"]
    existing_private_subnet_ids  = ["subnet-0000000000000000c", "subnet-0000000000000000d", "subnet-0000000000000000e"]
    existing_database_subnet_ids = []
  }

  assert {
    condition     = length(aws_vpc.this) == 0 && length(aws_nat_gateway.this) == 0 && length(aws_vpc_endpoint.s3) == 0
    error_message = "No network resources may be created inside an existing VPC."
  }

  assert {
    condition     = length(aws_efs_mount_target.this) == 3
    error_message = "One EFS mount target per existing private subnet."
  }

  assert {
    condition     = toset(aws_db_subnet_group.this.subnet_ids) == toset(["subnet-0000000000000000c", "subnet-0000000000000000d", "subnet-0000000000000000e"])
    error_message = "RDS falls back to the private subnets when no database subnets are given."
  }
}

run "cutover_and_github_role_extras" {
  command = apply

  variables {
    enable_data_import          = true
    create_github_deploy_role   = true
    create_github_oidc_provider = true
    github_repository           = "example-org/example-repo"
    enable_execute_command      = false
  }

  assert {
    condition     = length(aws_ecs_task_definition.import) == 1 && output.data_import_run_task_command != null
    error_message = "enable_data_import must create the import task and print how to run it."
  }

  assert {
    condition     = length(aws_iam_role.github_deploy) == 1 && length(aws_iam_openid_connect_provider.github) == 1
    error_message = "The deploy role and OIDC provider must be created when requested."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.app.container_definitions)[0].linuxParameters.capabilities.drop == ["ALL"]
    error_message = "Without ECS Exec every capability must be dropped."
  }

  assert {
    condition     = !aws_ecs_service.app.enable_execute_command && length(aws_cloudwatch_log_group.exec) == 0
    error_message = "enable_execute_command = false must disable exec and its log group."
  }
}

run "exec_keeps_only_setuid_and_setgid" {
  command = apply

  assert {
    condition = alltrue([
      for c in ["SETUID", "SETGID"] : !contains(jsondecode(aws_ecs_task_definition.app.container_definitions)[0].linuxParameters.capabilities.drop, c)
    ]) && contains(jsondecode(aws_ecs_task_definition.app.container_definitions)[0].linuxParameters.capabilities.drop, "DAC_OVERRIDE")
    error_message = "With ECS Exec, only SETUID and SETGID may remain (for `su node`)."
  }
}

run "managed_settings_cannot_be_overridden" {
  command = plan

  variables {
    app_environment = {
      DATABASE_URL = "postgresql://elsewhere/isms"
    }
  }

  expect_failures = [var.app_environment]
}

run "insecure_base_url_is_rejected" {
  command = plan

  variables {
    app_base_url = "http://isms.example.com"
  }

  expect_failures = [var.app_base_url]
}
