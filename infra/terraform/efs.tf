resource "aws_efs_file_system" "this" {
  creation_token   = local.name
  encrypted        = true
  kms_key_id       = aws_kms_key.app.arn
  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"

  dynamic "lifecycle_policy" {
    for_each = var.efs_transition_to_ia == null ? [] : [var.efs_transition_to_ia]
    content {
      transition_to_ia = lifecycle_policy.value
    }
  }

  dynamic "lifecycle_policy" {
    for_each = var.efs_transition_to_ia == null ? [] : [1]
    content {
      transition_to_primary_storage_class = "AFTER_1_ACCESS"
    }
  }

  tags = { Name = local.name }
}

resource "aws_efs_backup_policy" "this" {
  file_system_id = aws_efs_file_system.this.id

  backup_policy {
    status = var.enable_aws_backup ? "DISABLED" : "ENABLED"
  }
}

resource "aws_efs_mount_target" "this" {
  count = local.private_subnet_count

  file_system_id  = aws_efs_file_system.this.id
  subnet_id       = local.private_subnet_ids[count.index]
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "state" {
  file_system_id = aws_efs_file_system.this.id

  posix_user {
    uid = local.app_uid
    gid = local.app_gid
  }

  root_directory {
    path = "/isms-state"

    creation_info {
      owner_uid   = local.app_uid
      owner_gid   = local.app_gid
      permissions = "0700"
    }
  }

  tags = { Name = "${local.name}-state" }
}

resource "aws_efs_access_point" "uploads" {
  file_system_id = aws_efs_file_system.this.id

  posix_user {
    uid = local.app_uid
    gid = local.app_gid
  }

  root_directory {
    path = "/isms-uploads"

    creation_info {
      owner_uid   = local.app_uid
      owner_gid   = local.app_gid
      permissions = "0700"
    }
  }

  tags = { Name = "${local.name}-uploads" }
}

data "aws_iam_policy_document" "efs" {
  statement {
    sid    = "AppTasksThroughAccessPoints"
    effect = "Allow"
    actions = [
      "elasticfilesystem:ClientMount",
      "elasticfilesystem:ClientWrite",
    ]
    resources = [aws_efs_file_system.this.arn]

    principals {
      type = "AWS"
      identifiers = concat(
        [aws_iam_role.task.arn],
        var.enable_data_import ? [aws_iam_role.import_task[0].arn] : [],
      )
    }

    condition {
      test     = "StringEquals"
      variable = "elasticfilesystem:AccessPointArn"
      values   = [aws_efs_access_point.state.arn, aws_efs_access_point.uploads.arn]
    }
  }

  statement {
    sid       = "DenyUnencryptedTransport"
    effect    = "Deny"
    actions   = ["*"]
    resources = [aws_efs_file_system.this.arn]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_efs_file_system_policy" "this" {
  file_system_id = aws_efs_file_system.this.id
  policy         = data.aws_iam_policy_document.efs.json
}
