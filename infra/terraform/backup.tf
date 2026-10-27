resource "aws_backup_vault" "this" {
  count = var.enable_aws_backup ? 1 : 0

  name        = local.name
  kms_key_arn = aws_kms_key.app.arn
}

resource "aws_backup_plan" "this" {
  count = var.enable_aws_backup ? 1 : 0

  name = local.name

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.this[0].name
    schedule          = var.backup_schedule
    start_window      = 60
    completion_window = 360

    lifecycle {
      delete_after = var.backup_retention_days
    }

    recovery_point_tags = {
      Application = var.app_name
      Environment = var.environment
    }
  }
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  count = var.enable_aws_backup ? 1 : 0

  name               = "${local.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  for_each = var.enable_aws_backup ? toset([
    "arn:${local.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
    "arn:${local.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores",
  ]) : toset([])

  role       = aws_iam_role.backup[0].name
  policy_arn = each.value
}

resource "aws_backup_selection" "this" {
  count = var.enable_aws_backup ? 1 : 0

  name         = "${local.name}-data"
  plan_id      = aws_backup_plan.this[0].id
  iam_role_arn = aws_iam_role.backup[0].arn

  resources = concat(
    [aws_efs_file_system.this.arn],
    var.backup_include_rds ? [aws_db_instance.this.arn] : [],
  )
}
