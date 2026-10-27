locals {
  github_oidc_url = "https://token.actions.githubusercontent.com"
  github_oidc_provider_arn = var.create_github_deploy_role ? (
    var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
  ) : null
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_deploy_role && var.create_github_oidc_provider ? 1 : 0

  url            = local.github_oidc_url
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_deploy_role && !var.create_github_oidc_provider ? 1 : 0

  url = local.github_oidc_url
}

data "aws_iam_policy_document" "github_assume" {
  count = var.create_github_deploy_role ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${coalesce(var.github_repository, "unset/unset")}:environment:${local.github_environment}"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  count = var.create_github_deploy_role ? 1 : 0

  name                 = "${local.name}-github-deploy"
  description          = "Assumed by GitHub Actions (${coalesce(var.github_repository, "unset")}, environment ${local.github_environment}) to deploy ${local.name}"
  assume_role_policy   = data.aws_iam_policy_document.github_assume[0].json
  max_session_duration = 3600

  lifecycle {
    precondition {
      condition     = var.github_repository != null
      error_message = "Set github_repository (owner/name) when create_github_deploy_role is true."
    }
  }
}

data "aws_iam_policy_document" "github_deploy" {
  count = var.create_github_deploy_role ? 1 : 0

  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPushThisRepository"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    sid       = "EcrKmsEncryptedLayers"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.app.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ecr.${local.region}.amazonaws.com"]
    }
  }

  statement {
    sid = "TaskDefinitions"
    actions = [
      "ecs:DescribeTaskDefinition",
      "ecs:RegisterTaskDefinition",
    ]
    resources = ["*"]
  }

  statement {
    sid = "DeployThisService"
    actions = [
      "ecs:DescribeServices",
      "ecs:UpdateService",
    ]
    resources = [aws_ecs_service.app.id]
  }

  statement {
    sid       = "DiagnoseFailedDeploys"
    actions   = ["ecs:ListTasks", "ecs:DescribeTasks"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  statement {
    sid       = "PassOnlyThisStacksTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid = "PreDeploySnapshot"
    actions = [
      "rds:AddTagsToResource",
      "rds:CreateDBSnapshot",
      "rds:DescribeDBSnapshots",
    ]
    resources = [
      aws_db_instance.this.arn,
      "arn:${local.partition}:rds:${local.region}:${local.account_id}:snapshot:${local.name}-predeploy-*",
    ]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count = var.create_github_deploy_role ? 1 : 0

  name   = "deploy"
  role   = aws_iam_role.github_deploy[0].id
  policy = data.aws_iam_policy_document.github_deploy[0].json
}
