resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public load balancer: HTTP/HTTPS in, app port out to tasks only"
  vpc_id      = local.vpc_id

  tags = { Name = "${local.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = toset(var.alb_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS from clients"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  # checkov:skip=CKV_AWS_260:Port 80 only answers with a 301 to HTTPS (aws_lb_listener.http_redirect); no content is served over HTTP.
  for_each = toset(var.alb_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "HTTP from clients (redirected to HTTPS)"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_task" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  description                  = "Forward requests and health checks to app tasks"
}

resource "aws_security_group" "task" {
  name        = "${local.name}-task"
  description = "App tasks: app port from the ALB only; HTTPS out, NFS to EFS, Postgres to RDS"
  vpc_id      = local.vpc_id

  tags = { Name = "${local.name}-task" }
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  description                  = "App port from the load balancer"
}

resource "aws_vpc_security_group_egress_rule" "task_https" {
  security_group_id = aws_security_group.task.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to AWS APIs and the app's email and AI providers"
}

resource "aws_vpc_security_group_egress_rule" "task_extra" {
  for_each = toset([for p in var.task_egress_extra_tcp_ports : tostring(p)])

  security_group_id = aws_security_group.task.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  description       = "Extra outbound port ${each.value} (task_egress_extra_tcp_ports)"
}

resource "aws_vpc_security_group_egress_rule" "task_to_efs" {
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = aws_security_group.efs.id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
  description                  = "NFS to EFS mount targets"
}

resource "aws_vpc_security_group_egress_rule" "task_to_rds" {
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL to RDS"
}

resource "aws_security_group" "efs" {
  name        = "${local.name}-efs"
  description = "EFS mount targets: NFS from app tasks (and the import task) only"
  vpc_id      = local.vpc_id

  tags = { Name = "${local.name}-efs" }
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_task" {
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
  description                  = "NFS from app tasks"
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_ops" {
  count = var.enable_data_import ? 1 : 0

  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = aws_security_group.ops[0].id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
  description                  = "NFS from the one-off data import task"
}

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "PostgreSQL from app tasks only"
  vpc_id      = local.vpc_id

  tags = { Name = "${local.name}-rds" }
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_task" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from app tasks"
}

moved {
  from = aws_vpc_security_group_egress_rule.task_to_rds[0]
  to   = aws_vpc_security_group_egress_rule.task_to_rds
}

moved {
  from = aws_security_group.rds[0]
  to   = aws_security_group.rds
}

moved {
  from = aws_vpc_security_group_ingress_rule.rds_from_task[0]
  to   = aws_vpc_security_group_ingress_rule.rds_from_task
}

resource "aws_security_group" "ops" {
  # checkov:skip=CKV2_AWS_5:Attached at run time by `aws ecs run-task` (output data_import_run_task_command).
  count = var.enable_data_import ? 1 : 0

  name        = "${local.name}-data-import"
  description = "One-off data import task: HTTPS out (S3, logs, image pull) and NFS to EFS"
  vpc_id      = local.vpc_id

  tags = { Name = "${local.name}-data-import" }
}

resource "aws_vpc_security_group_egress_rule" "ops_https" {
  count = var.enable_data_import ? 1 : 0

  security_group_id = aws_security_group.ops[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to S3, CloudWatch Logs and the public ECR registry"
}

resource "aws_vpc_security_group_egress_rule" "ops_to_efs" {
  count = var.enable_data_import ? 1 : 0

  security_group_id            = aws_security_group.ops[0].id
  referenced_security_group_id = aws_security_group.efs.id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
  description                  = "NFS to EFS mount targets"
}
