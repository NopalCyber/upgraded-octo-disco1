variable "aws_region" {
  description = "AWS region for every resource in this stack. The ACM certificate must be in the same region."
  type        = string
}

variable "app_name" {
  description = "Short application name used in resource names."
  type        = string
  default     = "isms"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,11}$", var.app_name))
    error_message = "app_name must be 2-12 characters: lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "environment" {
  description = "Environment name (for example staging or production). One state file per environment."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,11}$", var.environment))
    error_message = "environment must be 2-12 characters: lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "tags" {
  description = "Extra tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "existing_vpc_id" {
  description = "Use an existing VPC instead of creating one. When set, the existing_*_subnet_ids variables are required."
  type        = string
  default     = null
}

variable "existing_public_subnet_ids" {
  description = "Public subnets (at least two AZs) for the load balancer when existing_vpc_id is set."
  type        = list(string)
  default     = []
}

variable "existing_private_subnet_ids" {
  description = "Private subnets with outbound internet (NAT) for the tasks and EFS mount targets when existing_vpc_id is set. At most one subnet per AZ."
  type        = list(string)
  default     = []
}

variable "existing_database_subnet_ids" {
  description = "Private subnets (at least two AZs) for RDS when existing_vpc_id is set. Defaults to existing_private_subnet_ids."
  type        = list(string)
  default     = []
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC this stack creates. Subnets are carved as /24s."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 18
    error_message = "vpc_cidr must be a valid IPv4 CIDR of /18 or larger (subnets are /24s at offsets 0, 10 and 20)."
  }
}

variable "az_count" {
  description = "Number of availability zones to spread subnets across (created VPC only)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "availability_zones" {
  description = "Pin the AZ names used by the created VPC (length az_count). Empty: the first az_count available AZs in alphabetical order."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.availability_zones) == 0 || length(var.availability_zones) == var.az_count
    error_message = "availability_zones must be empty or list exactly az_count zones."
  }
}

variable "nat_gateway_count" {
  description = "NAT gateways in the created VPC. 1 is cheapest; set it to az_count so one AZ outage cannot cut outbound traffic."
  type        = number
  default     = 1

  validation {
    condition     = var.nat_gateway_count >= 1 && var.nat_gateway_count <= 3
    error_message = "nat_gateway_count must be between 1 and 3 (it is capped at az_count)."
  }
}

variable "enable_vpc_flow_logs" {
  description = "Send VPC flow logs (created VPC only) to CloudWatch Logs."
  type        = bool
  default     = true
}

variable "enable_interface_endpoints" {
  description = "Create interface VPC endpoints for ECR, CloudWatch Logs, Secrets Manager and SSM messages (created VPC only). Reduces NAT data charges and keeps AWS API traffic private; costs about USD 7 per endpoint per AZ per month."
  type        = bool
  default     = false
}

variable "task_egress_extra_tcp_ports" {
  description = "Extra outbound TCP ports for the app tasks beyond HTTPS (443). Add 465 when Gmail SMTP (GMAIL_USER) is the email provider."
  type        = list(number)
  default     = []
}

variable "image_tag" {
  description = "Image tag Terraform writes into the task definition it owns. Deploys are done by the GitHub workflow, which registers new revisions with the commit SHA; Terraform does not roll the service back to this tag (see lifecycle.ignore_changes in ecs.tf)."
  type        = string
  default     = "bootstrap"
}

variable "app_base_url" {
  description = "Public HTTPS URL of the application, for example https://isms.example.com. Used in emailed links and required by /readyz in production."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9.-]+(:[0-9]+)?$", var.app_base_url))
    error_message = "app_base_url must be an https:// origin with no path or trailing slash."
  }
}

variable "service_enabled" {
  description = "Run the ECS service. Leave false for the first apply (no image exists and secrets are empty), then set true."
  type        = bool
  default     = true
}

variable "desired_count" {
  description = "Number of app tasks (at least 2, so a deploy or an AZ problem never leaves the service empty). Every task shares the database, sessions, the login lockout and job locks through PostgreSQL."
  type        = number
  default     = 2

  validation {
    condition     = var.desired_count >= 2 && var.desired_count <= 20
    error_message = "desired_count must be between 2 and 20."
  }
}

variable "task_cpu" {
  description = "Fargate task CPU units. Chromium (PDF export), ONNX policy retrieval and clamscan run in the same container."
  type        = number
  default     = 2048
}

variable "task_memory" {
  description = "Fargate task memory (MiB). clamscan loads the full signature database (about 1.2 GB) for each upload scan, so stay at 4096 or above."
  type        = number
  default     = 4096
}

variable "container_port" {
  description = "Port the app listens on (PORT)."
  type        = number
  default     = 3000
}

variable "health_check_path" {
  description = "Load balancer health check path. /readyz also fails when a production setting is missing (email provider, HTTPS URL, secrets, ClamAV), which keeps a misconfigured release out of service. Use /healthz to gate on liveness only."
  type        = string
  default     = "/readyz"

  validation {
    condition     = contains(["/readyz", "/healthz"], var.health_check_path)
    error_message = "health_check_path must be /readyz or /healthz."
  }
}

variable "health_check_grace_period_seconds" {
  description = "Seconds ECS ignores load balancer health after a task starts (boot runs migrations and seeds)."
  type        = number
  default     = 180
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for application, exec and import logs."
  type        = number
  default     = 365

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a value CloudWatch Logs accepts (for example 90, 365, 731)."
  }
}

variable "container_insights" {
  description = "ECS Container Insights setting: enabled, enhanced or disabled."
  type        = string
  default     = "enabled"

  validation {
    condition     = contains(["enabled", "enhanced", "disabled"], var.container_insights)
    error_message = "container_insights must be enabled, enhanced or disabled."
  }
}

variable "enable_execute_command" {
  description = "Allow ECS Exec into running tasks, for interactive diagnosis. Maintenance scripts (backup, restore check, data copy) run as one-off tasks instead and do not need it."
  type        = bool
  default     = true
}

variable "app_environment" {
  description = "Extra non-secret environment variables for the app, for example EMAIL_FROM_DEFAULT, BREVO_SENDER_EMAIL, AI_PROVIDER, OPENROUTER_MODEL, SECURITY_CONTACT_EMAIL. Settings managed by this stack cannot be overridden here."
  type        = map(string)
  default     = {}

  validation {
    condition = length(setintersection(keys(var.app_environment), [
      "NODE_ENV", "PORT", "APP_VERSION", "APP_BASE_URL", "DATABASE_URL",
      "ISMS_UPLOADS_DIR", "ISMS_BACKUP_DIR", "ISMS_KEY_FILE", "ISMS_RESTORE_DRILL_DISABLED", "SESSION_SECRET", "ISMS_MASTER_KEY",
      "UPLOAD_AV_MODE", "ISMS_PREFLIGHT", "ALLOW_INSECURE_DEFAULTS", "DISABLE_CSRF",
    ])) == 0
    error_message = "app_environment cannot set a variable this stack manages or an unsafe test switch (NODE_ENV, PORT, APP_VERSION, APP_BASE_URL, DATABASE_URL, ISMS_UPLOADS_DIR, ISMS_BACKUP_DIR, ISMS_KEY_FILE, ISMS_RESTORE_DRILL_DISABLED, SESSION_SECRET, ISMS_MASTER_KEY, UPLOAD_AV_MODE, ISMS_PREFLIGHT, ALLOW_INSECURE_DEFAULTS, DISABLE_CSRF). Put secret values in app_secret_names; use restore_drill_enabled for the restore drill."
  }
}

variable "app_secret_names" {
  description = <<-EOT
    Environment variables injected from Secrets Manager in addition to SESSION_SECRET, ISMS_MASTER_KEY and
    DATABASE_URL. One secret is created per name, empty; a task cannot start until every listed
    secret has a value. Production /readyz needs an email provider: RESEND_API_KEY, BREVO_API_KEY, or
    GMAIL_USER + GMAIL_APP_PASSWORD. Others: TPRM_MONITORING_WEBHOOK_SECRET, OPENROUTER_API_KEY,
    ANTHROPIC_API_KEY, INITIAL_ADMIN_PASSWORD (fresh installs only).
  EOT
  type        = list(string)
  default     = ["RESEND_API_KEY"]

  validation {
    condition     = alltrue([for n in var.app_secret_names : can(regex("^[A-Z][A-Z0-9_]{2,127}$", n))])
    error_message = "app_secret_names entries must be upper-case environment variable names."
  }

  validation {
    condition     = length(setintersection(var.app_secret_names, ["SESSION_SECRET", "ISMS_MASTER_KEY", "DATABASE_URL"])) == 0
    error_message = "SESSION_SECRET, ISMS_MASTER_KEY and DATABASE_URL are always managed by this stack; do not list them."
  }
}

variable "secret_recovery_window_days" {
  description = "Days a deleted secret can still be recovered. Protects ISMS_MASTER_KEY from accidental destroy."
  type        = number
  default     = 30

  validation {
    condition     = var.secret_recovery_window_days == 0 || (var.secret_recovery_window_days >= 7 && var.secret_recovery_window_days <= 30)
    error_message = "secret_recovery_window_days must be 0 or between 7 and 30."
  }
}

variable "ecr_image_retention_count" {
  description = "Number of tagged images kept in ECR. Older images are expired; keep enough for rollback."
  type        = number
  default     = 30
}

variable "certificate_arn" {
  description = "ACM certificate ARN (same region) covering the host in app_base_url."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/.+$", var.certificate_arn))
    error_message = "certificate_arn must be an ACM certificate ARN."
  }
}

variable "ssl_policy" {
  description = "TLS policy of the HTTPS listener. Only policies whose minimum is TLS 1.2 or 1.3 are accepted."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  validation {
    condition     = can(regex("^ELBSecurityPolicy-(TLS13-1-[23]-|TLS-1-2-|FS-1-2-)", var.ssl_policy))
    error_message = "ssl_policy must be an ELB policy with a TLS 1.2 or TLS 1.3 minimum (ELBSecurityPolicy-TLS13-1-2-*, -TLS13-1-3-*, -TLS-1-2-*, or -FS-1-2-*)."
  }
}

variable "alb_ingress_cidrs" {
  description = "IPv4 CIDRs allowed to reach the load balancer on 80/443."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "alb_idle_timeout" {
  description = "Load balancer idle timeout in seconds. Audit-pack, PDF and DOCX exports can take more than a minute."
  type        = number
  default     = 120
}

variable "alb_deletion_protection" {
  description = "Protect the load balancer from deletion."
  type        = bool
  default     = true
}

variable "alb_access_logs_bucket" {
  description = "Existing S3 bucket for load balancer access logs (null disables them). ALB logs record the full request URL including query strings, which the Lightsail nginx setup deliberately strips; see deploy/AWS.md before enabling."
  type        = string
  default     = null
}

variable "alb_access_logs_prefix" {
  description = "Key prefix for load balancer access logs."
  type        = string
  default     = "alb"
}

variable "waf_web_acl_arn" {
  description = "Existing regional WAFv2 web ACL ARN to associate with the load balancer (null for none)."
  type        = string
  default     = null
}

variable "efs_transition_to_ia" {
  description = "Move EFS files not read for this long to Infrequent Access (null keeps everything in Standard)."
  type        = string
  default     = "AFTER_30_DAYS"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.small"
}

variable "db_engine_version" {
  description = "PostgreSQL engine version. A major version (\"16\") lets RDS pick and auto-upgrade the minor version."
  type        = string
  default     = "16"
}

variable "db_allocated_storage" {
  description = "Initial gp3 storage in GiB."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling in GiB."
  type        = number
  default     = 100
}

variable "db_multi_az" {
  description = "Run a synchronous standby in a second AZ. Doubles the instance cost; staging can set false."
  type        = bool
  default     = true
}

variable "db_backup_retention_days" {
  description = "Automated backup (point-in-time recovery) retention in days."
  type        = number
  default     = 14

  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be between 1 and 35."
  }
}

variable "db_backup_window" {
  description = "Daily UTC window for automated backups."
  type        = string
  default     = "02:00-03:00"
}

variable "db_maintenance_window" {
  description = "Weekly UTC maintenance window."
  type        = string
  default     = "sun:04:00-sun:05:00"
}

variable "db_deletion_protection" {
  description = "Protect the database from deletion."
  type        = bool
  default     = true
}

variable "db_name" {
  description = "Name of the application database in DATABASE_URL. RDS does not create it: it must use the C collation, which RDS cannot set, so a one-off task creates it (create_database_task_overrides, deploy/AWS.md)."
  type        = string
  default     = "isms"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.db_name)) && var.db_name != "postgres"
    error_message = "db_name must be 1-63 characters: lowercase letters, digits and underscores, starting with a letter, and not \"postgres\"."
  }
}

variable "db_username" {
  description = "Master user name. The app connects with this user unless you replace DATABASE_URL with a least-privilege role (deploy/AWS.md)."
  type        = string
  default     = "isms_admin"
}

variable "db_password_version" {
  description = "Increment to rotate the database password: Terraform generates a new one and writes it to both RDS and the DATABASE_URL secret in the same apply."
  type        = number
  default     = 1
}

variable "manage_database_url_secret" {
  description = "Let Terraform write the DATABASE_URL secret value. Set false if you populate it yourself (for example with a least-privilege role)."
  type        = bool
  default     = true
}

variable "database_url_options" {
  description = "Extra query parameters appended to DATABASE_URL after the TLS settings, which are fixed (sslmode=verify-full against the RDS CA bundle in the image). Example: connect_timeout=10."
  type        = string
  default     = ""

  validation {
    condition     = !can(regex("(^|&)(sslmode|sslrootcert|sslcert|sslkey|ssl|uselibpqcompat)=", var.database_url_options)) && !startswith(var.database_url_options, "?") && !startswith(var.database_url_options, "&")
    error_message = "database_url_options holds extra parameters only, without a leading ? or &. TLS settings (sslmode, sslrootcert, ...) are fixed by this stack."
  }
}

variable "db_performance_insights_enabled" {
  description = "Enable Performance Insights (7-day retention is free)."
  type        = bool
  default     = true
}

variable "db_monitoring_interval" {
  description = "Enhanced Monitoring interval in seconds (0 disables)."
  type        = number
  default     = 60

  validation {
    condition     = contains([0, 1, 5, 10, 15, 30, 60], var.db_monitoring_interval)
    error_message = "db_monitoring_interval must be one of 0, 1, 5, 10, 15, 30, 60."
  }
}

variable "enable_aws_backup" {
  description = "Back up EFS (uploads and any app recovery generations) with an AWS Backup plan. When false, EFS automatic backups are switched on instead. The database is covered by RDS automated backups either way."
  type        = bool
  default     = true
}

variable "backup_schedule" {
  description = "AWS Backup schedule (UTC cron)."
  type        = string
  default     = "cron(0 3 * * ? *)"
}

variable "backup_retention_days" {
  description = "Days AWS Backup keeps each recovery point."
  type        = number
  default     = 35
}

variable "backup_include_rds" {
  description = "Also add the RDS instance to the AWS Backup plan (on top of RDS automated backups), for longer retention or a single restore console."
  type        = bool
  default     = false
}

variable "restore_drill_enabled" {
  description = "Run the app's monthly restore drill (lib/jobs.js). It restores the newest recovery generation from ISMS_BACKUP_DIR, so turn it on only if you schedule scripts/backup.js; otherwise it records a failure every hour. Off sets ISMS_RESTORE_DRILL_DISABLED=1."
  type        = bool
  default     = false
}

variable "enable_data_import" {
  description = "Lightsail cutover kit: a private S3 staging bucket and a one-off Fargate task that copies the SQLite file and uploads from it onto EFS, where scripts/sqlite-to-postgres.js loads the database into RDS. Turn off after cutover."
  type        = bool
  default     = false
}

variable "import_task_image" {
  description = "AWS CLI image used by the data import task, pinned by version and digest."
  type        = string
  default     = "public.ecr.aws/aws-cli/aws-cli:2.37.10@sha256:3dacc5db57c923c4223e949795f538ecf1f2212b2b7d5a028b47b97f91564c0d"
}

variable "create_github_deploy_role" {
  description = "Create the IAM role the deploy workflow assumes through GitHub OIDC."
  type        = bool
  default     = false
}

variable "create_github_oidc_provider" {
  description = "Create the account-wide GitHub OIDC identity provider. Only one may exist per account: set true in exactly one stack, false elsewhere (the existing one is looked up)."
  type        = bool
  default     = false
}

variable "github_repository" {
  description = "Repository allowed to assume the deploy role, as owner/name."
  type        = string
  default     = null

  validation {
    condition     = var.github_repository == null || can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must look like owner/name."
  }
}

variable "github_environment" {
  description = "GitHub environment whose jobs may assume the deploy role. Defaults to var.environment."
  type        = string
  default     = null
}

variable "kms_deletion_window_days" {
  description = "Waiting period before the stack's KMS key is deleted after a destroy."
  type        = number
  default     = 30
}
