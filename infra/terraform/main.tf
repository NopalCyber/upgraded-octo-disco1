data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  name       = "${var.app_name}-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region

  desired_count = var.service_enabled ? var.desired_count : 0

  container_name = "app"

  app_data_path    = "/app/data"
  state_mount_path = "/app/var"
  uploads_path     = "/app/uploads"
  backup_dir       = "${local.state_mount_path}/backups"

  cutover_sqlite_path = "${local.state_mount_path}/iso27001.db"

  rds_ca_bundle_path = "/etc/ssl/rds/global-bundle.pem"
  database_url_tls   = "sslmode=verify-full&sslrootcert=${local.rds_ca_bundle_path}"

  app_uid = 1000
  app_gid = 1000

  github_environment = coalesce(var.github_environment, var.environment)
}
