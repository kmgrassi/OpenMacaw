data "terraform_remote_state" "shared_platform" {
  backend = "s3"

  config = {
    bucket = var.platform_state_bucket
    key    = var.platform_state_key
    region = var.platform_state_region
  }
}

data "aws_route53_zone" "frontend" {
  count = var.frontend_route53_zone_id == null ? 1 : 0

  name         = var.frontend_route53_zone_name
  private_zone = false
}

data "aws_route53_zone" "api" {
  count = var.api_route53_zone_id == null ? 1 : 0

  name         = var.api_route53_zone_name
  private_zone = false
}

locals {
  platform_outputs            = data.terraform_remote_state.shared_platform.outputs
  platform_vpc_id             = lookup(local.platform_outputs, "vpc_id", null)
  platform_https_listener_arn = lookup(local.platform_outputs, "https_listener_arn", null)
  platform_alb_dns_name       = lookup(local.platform_outputs, "alb_dns_name", null)
  platform_alb_zone_id        = lookup(local.platform_outputs, "alb_zone_id", null)
  frontend_route53_zone_id    = var.frontend_route53_zone_id != null ? var.frontend_route53_zone_id : data.aws_route53_zone.frontend[0].zone_id
  api_route53_zone_id         = var.api_route53_zone_id != null ? var.api_route53_zone_id : data.aws_route53_zone.api[0].zone_id
  domain_zone_ids = {
    (var.frontend_domain) = local.frontend_route53_zone_id
    (var.api_domain)      = local.api_route53_zone_id
  }
}

resource "aws_acm_certificate" "openclaw_domains" {
  domain_name               = var.frontend_domain
  subject_alternative_names = [var.api_domain]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "openclaw_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.openclaw_domains.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  zone_id         = local.domain_zone_ids[each.key]
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
}

resource "aws_acm_certificate_validation" "openclaw_domains" {
  certificate_arn         = aws_acm_certificate.openclaw_domains.arn
  validation_record_fqdns = [for record in aws_route53_record.openclaw_cert_validation : record.fqdn]
}

resource "aws_lb_listener_certificate" "openclaw_domains" {
  listener_arn    = local.platform_https_listener_arn
  certificate_arn = aws_acm_certificate_validation.openclaw_domains.certificate_arn
}

resource "aws_lb_target_group" "broker_api" {
  name        = var.broker_target_group_name
  port        = var.broker_target_group_port
  protocol    = "HTTP"
  target_type = var.broker_target_type
  vpc_id      = local.platform_vpc_id

  health_check {
    path                = var.broker_health_check_path
    matcher             = "200-399"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }
}

resource "aws_lb_target_group" "relay" {
  count = trimspace(var.relay_target_group_name) != "" ? 1 : 0

  name                 = trimspace(var.relay_target_group_name)
  port                 = var.relay_socket_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = local.platform_vpc_id
  deregistration_delay = var.relay_deregistration_delay_seconds

  health_check {
    path                = var.relay_health_check_path
    matcher             = "200-399"
    protocol            = "HTTP"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }

  stickiness {
    type            = "lb_cookie"
    enabled         = var.relay_stickiness_enabled
    cookie_duration = var.relay_stickiness_duration_seconds
  }
}

resource "aws_lb_listener_rule" "relay" {
  count = trimspace(var.relay_target_group_name) != "" ? 1 : 0

  listener_arn = local.platform_https_listener_arn
  priority     = var.relay_listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.relay[0].arn
  }

  condition {
    host_header {
      values = [var.api_domain]
    }
  }

  condition {
    path_pattern {
      values = ["/local-relay/*"]
    }
  }
}

resource "aws_lb_listener_rule" "broker_api" {
  listener_arn = local.platform_https_listener_arn
  priority     = var.api_listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.broker_api.arn
  }

  condition {
    host_header {
      values = [var.api_domain]
    }
  }

  condition {
    path_pattern {
      values = ["/*"]
    }
  }
}

resource "aws_route53_record" "clawapi_alias" {
  zone_id = local.api_route53_zone_id
  name    = var.api_domain
  type    = "A"

  alias {
    name                   = local.platform_alb_dns_name
    zone_id                = local.platform_alb_zone_id
    evaluate_target_health = false
  }
}

output "broker_api_target_group_arn" {
  value = aws_lb_target_group.broker_api.arn
}

output "relay_target_group_arn" {
  value = try(aws_lb_target_group.relay[0].arn, null)
}

output "relay_target_group_name" {
  value = trimspace(var.relay_target_group_name) != "" ? trimspace(var.relay_target_group_name) : null
}

output "openclaw_acm_certificate_arn" {
  value = aws_acm_certificate.openclaw_domains.arn
}
