resource "aws_s3_bucket" "import" {
  # checkov:skip=CKV_AWS_18:Short-lived cutover staging bucket; access is via IAM only and recorded by CloudTrail.
  # checkov:skip=CKV_AWS_21:Staged copies must be deletable outright after cutover; versioning would retain them.
  # checkov:skip=CKV_AWS_144:A second-region copy of staged client data is the opposite of what is wanted.
  # checkov:skip=CKV2_AWS_62:No consumer for event notifications; the import is run by hand.
  count = var.enable_data_import ? 1 : 0

  bucket        = "${local.name}-import-${local.account_id}"
  force_destroy = false
}

resource "aws_s3_bucket_ownership_controls" "import" {
  count = var.enable_data_import ? 1 : 0

  bucket = aws_s3_bucket.import[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "import" {
  count = var.enable_data_import ? 1 : 0

  bucket                  = aws_s3_bucket.import[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "import" {
  count = var.enable_data_import ? 1 : 0

  bucket = aws_s3_bucket.import[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.app.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "import" {
  count = var.enable_data_import ? 1 : 0

  bucket = aws_s3_bucket.import[0].id

  rule {
    id     = "expire-staged-data"
    status = "Enabled"

    filter {}

    expiration {
      days = 14
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "import_bucket" {
  count = var.enable_data_import ? 1 : 0

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.import[0].arn, "${aws_s3_bucket.import[0].arn}/*"]

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

resource "aws_s3_bucket_policy" "import" {
  count = var.enable_data_import ? 1 : 0

  bucket = aws_s3_bucket.import[0].id
  policy = data.aws_iam_policy_document.import_bucket[0].json

  depends_on = [aws_s3_bucket_public_access_block.import]
}

resource "aws_cloudwatch_log_group" "import" {
  count = var.enable_data_import ? 1 : 0

  name              = "/ecs/${local.name}/data-import"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.app.arn
}

resource "aws_iam_role" "import_execution" {
  count = var.enable_data_import ? 1 : 0

  name               = "${local.name}-import-execution"
  description        = "ECS agent for the ${local.name} data import task: logs only (public image)"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "import_execution" {
  count = var.enable_data_import ? 1 : 0

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.import[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "import_execution" {
  count = var.enable_data_import ? 1 : 0

  name   = "import-execution"
  role   = aws_iam_role.import_execution[0].id
  policy = data.aws_iam_policy_document.import_execution[0].json
}

resource "aws_iam_role" "import_task" {
  count = var.enable_data_import ? 1 : 0

  name               = "${local.name}-import-task"
  description        = "Data import task for ${local.name}: read the staging bucket, write EFS"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "import_task" {
  count = var.enable_data_import ? 1 : 0

  statement {
    sid       = "ListStagingBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.import[0].arn]
  }

  statement {
    sid       = "ReadStagedObjects"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.import[0].arn}/*"]
  }

  statement {
    sid       = "DecryptStagedObjects"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.app.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }

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
}

resource "aws_iam_role_policy" "import_task" {
  count = var.enable_data_import ? 1 : 0

  name   = "import-task"
  role   = aws_iam_role.import_task[0].id
  policy = data.aws_iam_policy_document.import_task[0].json
}

locals {
  import_script = <<-EOT
    set -eu
    umask 077
    src="s3://$${IMPORT_BUCKET}/$${IMPORT_PREFIX}"
    echo "[import] source: $src"
    if [ "$${IMPORT_DATABASE}" = "1" ]; then
      db=/mnt/state/iso27001.db
      if [ -e "$db" ] && [ "$${IMPORT_OVERWRITE}" != "1" ]; then
        echo "[import] $db already exists. Stop the app service and set IMPORT_OVERWRITE=1 to replace it." >&2
        exit 1
      fi
      aws s3 cp --only-show-errors "$src/iso27001.db" "$db.importing"
      rm -f "$db-wal" "$db-shm"
      mv -f "$db.importing" "$db"
      echo "[import] database sha256: $(sha256sum "$db" | cut -d' ' -f1)"
    fi
    mkdir -p /mnt/state/backups
    aws s3 sync --only-show-errors "$src/uploads/" /mnt/uploads/
    echo "[import] upload files on EFS: $(find /mnt/uploads -type f | wc -l)"
    echo "[import] done"
  EOT
}

resource "aws_ecs_task_definition" "import" {
  count = var.enable_data_import ? 1 : 0

  family                   = "${local.name}-data-import"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.import_execution[0].arn
  task_role_arn            = aws_iam_role.import_task[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name       = "import"
    image      = var.import_task_image
    essential  = true
    entryPoint = ["/bin/sh", "-c"]
    command    = [local.import_script]

    environment = [
      { name = "IMPORT_BUCKET", value = aws_s3_bucket.import[0].bucket },
      { name = "IMPORT_PREFIX", value = "cutover" },
      { name = "IMPORT_DATABASE", value = "1" },
      { name = "IMPORT_OVERWRITE", value = "0" },
    ]

    mountPoints = [
      { sourceVolume = "state", containerPath = "/mnt/state", readOnly = false },
      { sourceVolume = "uploads", containerPath = "/mnt/uploads", readOnly = false },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.import[0].name
        awslogs-region        = local.region
        awslogs-stream-prefix = "import"
      }
    }
  }])

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
