output "app_url" {
  description = "Public URL the app is configured for (APP_BASE_URL)."
  value       = var.app_base_url
}

output "alb_dns_name" {
  description = "Load balancer DNS name. Point the app's DNS record here (CNAME, or a Route 53 alias with alb_zone_id)."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone ID of the load balancer, for a Route 53 alias record."
  value       = aws_lb.this.zone_id
}

output "ecr_repository_url" {
  description = "ECR repository for release images."
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service_name" {
  value = aws_ecs_service.app.name
}

output "ecs_task_family" {
  description = "Task definition family. The deploy workflow copies its newest revision."
  value       = aws_ecs_task_definition.app.family
}

output "desired_count" {
  description = "Tasks the service runs (0 while service_enabled is false)."
  value       = local.desired_count
}

output "app_log_group" {
  value = aws_cloudwatch_log_group.app.name
}

output "efs_file_system_id" {
  value = aws_efs_file_system.this.id
}

output "efs_access_point_ids" {
  description = "state -> /app/var (app recovery generations; the cutover SQLite file), uploads -> /app/uploads."
  value = {
    state   = aws_efs_access_point.state.id
    uploads = aws_efs_access_point.uploads.id
  }
}

output "secret_arns" {
  description = "Secrets Manager ARN for each injected environment variable. Populate every one before starting the service."
  value       = { for k, s in aws_secretsmanager_secret.app : k => s.arn }
}

output "secret_names" {
  description = "Secrets Manager names, for `aws secretsmanager put-secret-value --secret-id <name>`."
  value       = { for k, s in aws_secretsmanager_secret.app : k => s.name }
}

output "rds_endpoint" {
  description = "RDS endpoint (host:port)."
  value       = aws_db_instance.this.endpoint
}

output "rds_instance_identifier" {
  description = "RDS instance identifier."
  value       = aws_db_instance.this.identifier
}

output "database_url_query" {
  description = "Query string of DATABASE_URL: TLS with server verification against the RDS CA bundle in the image, then database_url_options. Use it when you write DATABASE_URL yourself (manage_database_url_secret = false)."
  value       = local.database_url_query
}

output "private_subnet_ids" {
  value = local.private_subnet_ids
}

output "task_security_group_id" {
  value = aws_security_group.task.id
}

output "github_deploy_role_arn" {
  description = "Role for the AWS_DEPLOY_ROLE_ARN variable of the GitHub environment."
  value       = try(aws_iam_role.github_deploy[0].arn, null)
}

output "github_environment_variables" {
  description = "Variables to set on the GitHub environment used by .github/workflows/deploy-aws.yml."
  value = {
    AWS_REGION             = local.region
    AWS_DEPLOY_ROLE_ARN    = try(aws_iam_role.github_deploy[0].arn, "<role ARN created outside this stack>")
    ECR_REPOSITORY         = aws_ecr_repository.app.name
    ECS_CLUSTER            = aws_ecs_cluster.this.name
    ECS_SERVICE            = aws_ecs_service.app.name
    ECS_TASK_FAMILY        = aws_ecs_task_definition.app.family
    CONTAINER_NAME         = local.container_name
    APP_URL                = var.app_base_url
    ALB_DNS_NAME           = aws_lb.this.dns_name
    DB_INSTANCE_IDENTIFIER = aws_db_instance.this.identifier
  }
}

output "data_import_bucket" {
  description = "Staging bucket for the Lightsail cutover (enable_data_import)."
  value       = try(aws_s3_bucket.import[0].bucket, null)
}

output "data_import_run_task_command" {
  description = "Command that runs the one-off import task (enable_data_import)."
  value = var.enable_data_import ? join(" ", [
    "aws ecs run-task",
    "--region ${local.region}",
    "--cluster ${aws_ecs_cluster.this.name}",
    "--task-definition ${aws_ecs_task_definition.import[0].family}",
    "--launch-type FARGATE --platform-version LATEST",
    "--network-configuration 'awsvpcConfiguration={subnets=[${join(",", local.private_subnet_ids)}],securityGroups=[${aws_security_group.ops[0].id}],assignPublicIp=DISABLED}'",
  ]) : null
}

output "one_off_app_task_network_configuration" {
  description = "--network-configuration value for one-off `aws ecs run-task` runs of the app task definition (database creation, the SQLite copy, backups)."
  value       = "awsvpcConfiguration={subnets=[${join(",", local.private_subnet_ids)}],securityGroups=[${aws_security_group.task.id}],assignPublicIp=DISABLED}"
}

locals {
  create_database_script = <<-EOT
    set -eu
    base="$${DATABASE_URL%%[?]*}"
    admin="$${base%/*}/postgres$${DATABASE_URL#"$base"}"
    psql "$admin" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE ${var.db_name} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "SELECT format('created %s: LC_COLLATE=%s, LC_CTYPE=%s, provider=%s (c = libc), encoding=%s', datname, datcollate, datctype, datlocprovider, pg_encoding_to_char(encoding)) FROM pg_database WHERE datname = current_database()"
  EOT

  sqlite_copy_script = <<-EOT
    set -eu
    exec node scripts/sqlite-to-postgres.js --sqlite ${local.cutover_sqlite_path} --pg "$DATABASE_URL"
  EOT
}

output "create_database_task_overrides" {
  description = "Overrides for a one-off app task that creates the C-collation application database (run once, before the service first starts)."
  value = jsonencode({
    containerOverrides = [{ name = local.container_name, command = ["sh", "-c", local.create_database_script] }]
  })
}

output "sqlite_copy_task_overrides" {
  description = "Overrides for a one-off app task that copies the staged Lightsail SQLite database into RDS (cutover only)."
  value = jsonencode({
    containerOverrides = [{ name = local.container_name, command = ["sh", "-c", local.sqlite_copy_script] }]
  })
}
