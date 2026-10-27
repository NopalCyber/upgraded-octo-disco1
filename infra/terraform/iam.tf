data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ecs:${local.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  description        = "ECS agent for ${local.name}: image pull, logs, secret injection"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPullThisRepository"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    sid       = "WriteAppLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }

  statement {
    sid       = "ReadRuntimeSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for s in aws_secretsmanager_secret.app : s.arn]
  }

  statement {
    sid       = "DecryptSecretsAndImage"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.app.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values = [
        "secretsmanager.${local.region}.amazonaws.com",
        "ecr.${local.region}.amazonaws.com",
      ]
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "ecs-execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  description        = "Runtime identity of ${local.name} tasks: EFS mount and ECS Exec only"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid = "MountEfsThroughAccessPoints"
    actions = [
      "elasticfilesystem:ClientMount",
      "elasticfilesystem:ClientWrite",
    ]
    resources = [aws_efs_file_system.this.arn]

    condition {
      test     = "StringEquals"
      variable = "elasticfilesystem:AccessPointArn"
      values   = [aws_efs_access_point.state.arn, aws_efs_access_point.uploads.arn]
    }
  }

  dynamic "statement" {
    for_each = var.enable_execute_command ? [1] : []
    content {
      sid = "EcsExecChannels"
      actions = [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_execute_command ? [1] : []
    content {
      sid       = "EcsExecSessionLogs"
      actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
      resources = ["${aws_cloudwatch_log_group.exec[0].arn}:*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_execute_command ? [1] : []
    content {
      sid       = "EcsExecDescribeLogGroups"
      actions   = ["logs:DescribeLogGroups"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_execute_command ? [1] : []
    content {
      sid       = "EcsExecSessionEncryption"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [aws_kms_key.app.arn]
    }
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "ecs-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}
