# ── ACM Certificate ──────────────────────────────────────────

resource "aws_acm_certificate" "app" {
  count                     = local.manage_public_edge ? 1 : 0
  domain_name               = var.certificate_domains[0]
  subject_alternative_names = slice(var.certificate_domains, 1, length(var.certificate_domains))
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# ── DNS Validation Records ──────────────────────────────────

resource "aws_route53_record" "cert_validation" {
  for_each = local.manage_public_edge ? {
    for dvo in aws_acm_certificate.app[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id = data.aws_route53_zone.public_edge[0].zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  count                   = local.manage_public_edge ? 1 : 0
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

data "aws_lb" "shared" {
  count = local.has_remote_state ? 0 : (trimspace(var.alb_arn) != "" ? 1 : 0)
  arn   = var.alb_arn
}

resource "aws_route53_record" "api" {
  count   = local.manage_public_edge ? 1 : 0
  zone_id = data.aws_route53_zone.public_edge[0].zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = local.alb_dns_name
    zone_id                = local.alb_zone_id
    evaluate_target_health = true
  }
}
