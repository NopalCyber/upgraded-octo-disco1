resource "aws_lb" "this" {
  # checkov:skip=CKV2_AWS_76:The WAF web ACL is the company's choice (waf_web_acl_arn); the app is Node.js, not Java, so the Log4j rule set does not apply.
  name               = local.name
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.public_subnet_ids

  idle_timeout               = var.alb_idle_timeout
  drop_invalid_header_fields = true
  enable_deletion_protection = var.alb_deletion_protection

  dynamic "access_logs" {
    for_each = var.alb_access_logs_bucket == null ? [] : [var.alb_access_logs_bucket]
    content {
      bucket  = access_logs.value
      prefix  = var.alb_access_logs_prefix
      enabled = true
    }
  }

  lifecycle {
    precondition {
      condition     = length(local.public_subnet_ids) >= 2
      error_message = "The load balancer needs public subnets in at least two availability zones (existing_public_subnet_ids)."
    }
  }
}

resource "aws_lb_target_group" "app" {
  name_prefix = "app-"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = local.vpc_id

  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = var.health_check_path
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${local.name}-app" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  # nosemgrep: terraform.aws.security.insecure-load-balancer-tls-version.insecure-load-balancer-tls-version
  ssl_policy      = var.ssl_policy
  certificate_arn = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_wafv2_web_acl_association" "this" {
  count = var.waf_web_acl_arn == null ? 0 : 1

  resource_arn = aws_lb.this.arn
  web_acl_arn  = var.waf_web_acl_arn
}
