# Copy to <environment>.tfvars (ignored by Git) and replace every placeholder.
# All values below are examples: no real account, domain or secret.
#
#   terraform plan  -var-file=production.tfvars -out=production.tfplan
#   terraform apply production.tfplan

aws_region  = "eu-west-2"
app_name    = "isms"
environment = "production"

tags = {
  Owner      = "platform-team"
  CostCentre = "example"
}

# Public URL and its ACM certificate (same region as aws_region).
app_base_url    = "https://isms.example.com"
certificate_arn = "arn:aws:acm:eu-west-2:111122223333:certificate/00000000-0000-0000-0000-000000000000"

# First apply: false (no image, empty secrets). Then true. See deploy/AWS.md.
service_enabled = false

# App tasks (at least 2). They share everything through PostgreSQL and EFS.
desired_count = 2

# Sizing: Chromium, ONNX policy retrieval and clamscan share the task.
task_cpu    = 2048
task_memory = 4096

# Network: let the stack create a VPC ...
vpc_cidr          = "10.40.0.0/16"
az_count          = 2
nat_gateway_count = 1 # set to az_count for NAT redundancy

# ... or use an existing one (all four lists must then be filled in).
# existing_vpc_id              = "vpc-0123456789abcdef0"
# existing_public_subnet_ids   = ["subnet-0aaa...", "subnet-0bbb..."]
# existing_private_subnet_ids  = ["subnet-0ccc...", "subnet-0ddd..."]
# existing_database_subnet_ids = ["subnet-0eee...", "subnet-0fff..."]

# Uncomment if Gmail SMTP (GMAIL_USER / GMAIL_APP_PASSWORD) sends the email.
# task_egress_extra_tcp_ports = [465]

# Secrets injected besides SESSION_SECRET, ISMS_MASTER_KEY and DATABASE_URL.
# Every secret listed must have a value before tasks can start.
app_secret_names = [
  "RESEND_API_KEY",
  # "TPRM_MONITORING_WEBHOOK_SECRET",
  # "OPENROUTER_API_KEY",
  # "INITIAL_ADMIN_PASSWORD",   # fresh installs only; remove after first login
]

# Non-secret settings (see .env.example for the full list).
app_environment = {
  EMAIL_FROM_DEFAULT = "ISMS <noreply@example.com>"
  # SECURITY_CONTACT_EMAIL = "security@example.com"
  # AI_PROVIDER            = "openrouter"
  # INITIAL_ADMIN_EMAIL    = "admin@example.com"   # fresh installs only
  # INITIAL_ADMIN_NAME     = "Admin"
}

# Load balancer extras.
# waf_web_acl_arn        = "arn:aws:wafv2:eu-west-2:111122223333:regional/webacl/example/00000000-0000-0000-0000-000000000000"
# alb_access_logs_bucket = "example-alb-logs"   # read the query-string note in deploy/AWS.md first

# RDS PostgreSQL 16. db_name is created with the C collation by a one-off
# task (create_database_task_overrides), not by RDS; see deploy/AWS.md.
db_instance_class        = "db.t4g.small"
db_multi_az              = true
db_backup_retention_days = 14
# db_name                = "isms"
# database_url_options   = "connect_timeout=10"   # extras only; TLS is fixed

# Backups: RDS automated backups and AWS Backup (EFS) are the primary copies.
enable_aws_backup     = true
backup_retention_days = 35
# Turn on only if you schedule scripts/backup.js generations (deploy/AWS.md).
# restore_drill_enabled = true

# Cutover from a Lightsail (SQLite) install: true while importing, then false.
enable_data_import = false

# GitHub Actions deploy role. Set create_github_oidc_provider = true in exactly
# one stack per AWS account (the provider is account-wide).
create_github_deploy_role   = true
create_github_oidc_provider = true
github_repository           = "example-org/example-repo"
# github_environment        = "production"   # defaults to var.environment
