locals {
  create_vpc = var.existing_vpc_id == null

  azs       = length(var.availability_zones) > 0 ? var.availability_zones : slice(data.aws_availability_zones.available.names, 0, var.az_count)
  nat_count = local.create_vpc ? min(var.nat_gateway_count, var.az_count) : 0

  vpc_id             = local.create_vpc ? aws_vpc.this[0].id : var.existing_vpc_id
  public_subnet_ids  = local.create_vpc ? aws_subnet.public[*].id : var.existing_public_subnet_ids
  private_subnet_ids = local.create_vpc ? aws_subnet.private[*].id : var.existing_private_subnet_ids
  database_subnet_ids = local.create_vpc ? aws_subnet.database[*].id : (
    length(var.existing_database_subnet_ids) > 0 ? var.existing_database_subnet_ids : var.existing_private_subnet_ids
  )

  private_subnet_count = local.create_vpc ? var.az_count : length(var.existing_private_subnet_ids)
}

data "aws_availability_zones" "available" {
  # checkov:skip=CKV_AWS_394:Only the first az_count names are used (sorted, so a new AZ is appended, not inserted); var.availability_zones pins them explicitly.
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

resource "aws_vpc" "this" {
  count = local.create_vpc ? 1 : 0

  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_default_security_group" "this" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id
  tags   = { Name = "${local.name}-default-unused" }
}

resource "aws_internet_gateway" "this" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  count = local.create_vpc ? var.az_count : 0

  vpc_id                  = aws_vpc.this[0].id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 24 - tonumber(split("/", var.vpc_cidr)[1]), count.index)
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-public-${local.azs[count.index]}", Tier = "public" }
}

resource "aws_subnet" "private" {
  count = local.create_vpc ? var.az_count : 0

  vpc_id            = aws_vpc.this[0].id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 24 - tonumber(split("/", var.vpc_cidr)[1]), 10 + count.index)

  tags = { Name = "${local.name}-private-${local.azs[count.index]}", Tier = "private" }
}

resource "aws_subnet" "database" {
  count = local.create_vpc ? var.az_count : 0

  vpc_id            = aws_vpc.this[0].id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 24 - tonumber(split("/", var.vpc_cidr)[1]), 20 + count.index)

  tags = { Name = "${local.name}-database-${local.azs[count.index]}", Tier = "database" }
}

resource "aws_eip" "nat" {
  count = local.nat_count

  domain = "vpc"
  tags   = { Name = "${local.name}-nat-${local.azs[count.index]}" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  count = local.nat_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = { Name = "${local.name}-${local.azs[count.index]}" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id
  tags   = { Name = "${local.name}-public" }
}

resource "aws_route" "public_internet" {
  count = local.create_vpc ? 1 : 0

  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this[0].id
}

resource "aws_route_table_association" "public" {
  count = local.create_vpc ? var.az_count : 0

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table" "private" {
  count = local.create_vpc ? var.az_count : 0

  vpc_id = aws_vpc.this[0].id
  tags   = { Name = "${local.name}-private-${local.azs[count.index]}" }
}

resource "aws_route" "private_nat" {
  count = local.create_vpc ? var.az_count : 0

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[count.index % local.nat_count].id
}

resource "aws_route_table_association" "private" {
  count = local.create_vpc ? var.az_count : 0

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

resource "aws_route_table" "database" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id
  tags   = { Name = "${local.name}-database" }
}

resource "aws_route_table_association" "database" {
  count = local.create_vpc ? var.az_count : 0

  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database[0].id
}

resource "aws_vpc_endpoint" "s3" {
  count = local.create_vpc ? 1 : 0

  vpc_id            = aws_vpc.this[0].id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = { Name = "${local.name}-s3" }
}

locals {
  interface_endpoint_services = local.create_vpc && var.enable_interface_endpoints ? toset(concat(
    ["ecr.api", "ecr.dkr", "logs", "secretsmanager"],
    var.enable_execute_command ? ["ssmmessages"] : [],
  )) : toset([])
}

resource "aws_security_group" "endpoints" {
  # checkov:skip=CKV2_AWS_5:Attached to aws_vpc_endpoint.interface (for_each), which the scanner does not follow.
  count = length(local.interface_endpoint_services) > 0 ? 1 : 0

  name        = "${local.name}-endpoints"
  description = "Interface VPC endpoints: HTTPS from the app and ops tasks"
  vpc_id      = local.vpc_id

  tags = { Name = "${local.name}-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_tasks" {
  count = length(local.interface_endpoint_services) > 0 ? 1 : 0

  security_group_id            = aws_security_group.endpoints[0].id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from app tasks"
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_ops" {
  count = length(local.interface_endpoint_services) > 0 && var.enable_data_import ? 1 : 0

  security_group_id            = aws_security_group.endpoints[0].id
  referenced_security_group_id = aws_security_group.ops[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the data import task"
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoint_services

  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${local.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.private_subnet_ids
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true

  tags = { Name = "${local.name}-${each.key}" }
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  count = local.create_vpc && var.enable_vpc_flow_logs ? 1 : 0

  name              = "/vpc/${local.name}/flow-logs"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.app.arn
}

data "aws_iam_policy_document" "flow_logs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "flow_logs" {
  count = local.create_vpc && var.enable_vpc_flow_logs ? 1 : 0

  name               = "${local.name}-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_assume.json
}

data "aws_iam_policy_document" "flow_logs" {
  count = local.create_vpc && var.enable_vpc_flow_logs ? 1 : 0

  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["${aws_cloudwatch_log_group.flow_logs[0].arn}:*"]
  }

  statement {
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "flow_logs" {
  count = local.create_vpc && var.enable_vpc_flow_logs ? 1 : 0

  name   = "write-flow-logs"
  role   = aws_iam_role.flow_logs[0].id
  policy = data.aws_iam_policy_document.flow_logs[0].json
}

resource "aws_flow_log" "this" {
  count = local.create_vpc && var.enable_vpc_flow_logs ? 1 : 0

  vpc_id                   = aws_vpc.this[0].id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow_logs[0].arn
  iam_role_arn             = aws_iam_role.flow_logs[0].arn
  max_aggregation_interval = 600
}
