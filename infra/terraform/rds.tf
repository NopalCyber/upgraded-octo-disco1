ephemeral "random_password" "db" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = local.database_subnet_ids

  tags = { Name = local.name }
}

resource "aws_db_parameter_group" "this" {
  name   = "${local.name}-pg16"
  family = "postgres16"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "2000"
  }

  parameter {
    name  = "log_parameter_max_length"
    value = "0"
  }

  parameter {
    name  = "log_parameter_max_length_on_error"
    value = "0"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "rds" {
  for_each = toset(["postgresql", "upgrade"])

  name              = "/aws/rds/instance/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.app.arn
}

data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitoring" {
  count = var.db_monitoring_interval > 0 ? 1 : 0

  name               = "${local.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  count = var.db_monitoring_interval > 0 ? 1 : 0

  role       = aws_iam_role.rds_monitoring[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  username            = var.db_username
  password_wo         = ephemeral.random_password.db.result
  password_wo_version = var.db_password_version
  port                = 5432

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.app.arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az
  parameter_group_name   = aws_db_parameter_group.this.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period  = var.db_backup_retention_days
  backup_window            = var.db_backup_window
  maintenance_window       = var.db_maintenance_window
  copy_tags_to_snapshot    = true
  delete_automated_backups = false

  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = false

  iam_database_authentication_enabled = true
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]

  performance_insights_enabled          = var.db_performance_insights_enabled
  performance_insights_kms_key_id       = var.db_performance_insights_enabled ? aws_kms_key.app.arn : null
  performance_insights_retention_period = var.db_performance_insights_enabled ? 7 : null

  monitoring_interval = var.db_monitoring_interval
  monitoring_role_arn = var.db_monitoring_interval > 0 ? aws_iam_role.rds_monitoring[0].arn : null

  tags = { Name = local.name }

  depends_on = [aws_cloudwatch_log_group.rds, aws_iam_role_policy_attachment.rds_monitoring]
}

resource "aws_secretsmanager_secret_version" "database_url" {
  count = var.manage_database_url_secret ? 1 : 0

  secret_id                = aws_secretsmanager_secret.app["DATABASE_URL"].id
  secret_string_wo         = "postgresql://${var.db_username}:${ephemeral.random_password.db.result}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${var.db_name}?${local.database_url_query}"
  secret_string_wo_version = var.db_password_version
}

locals {
  database_url_query = join("&", compact([local.database_url_tls, var.database_url_options]))
}

moved {
  from = aws_db_subnet_group.this[0]
  to   = aws_db_subnet_group.this
}

moved {
  from = aws_db_parameter_group.this[0]
  to   = aws_db_parameter_group.this
}

moved {
  from = aws_db_instance.this[0]
  to   = aws_db_instance.this
}
