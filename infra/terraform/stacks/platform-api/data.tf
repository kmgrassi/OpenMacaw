# ── Shared platform remote state ────────────────────────────
# Optionally reads VPC, subnets, ALB, and ECS cluster from a shared infra
# stack. Public examples keep this disabled and pass explicit variables.

data "terraform_remote_state" "platform" {
  count   = var.shared_platform_state_enabled && var.vpc_id == "" ? 1 : 0
  backend = "s3"

  config = {
    bucket = var.shared_platform_state_bucket
    key    = var.shared_platform_state_key
    region = var.shared_platform_state_region
  }
}

data "aws_route53_zone" "public_edge" {
  count        = local.manage_public_edge ? 1 : 0
  name         = var.route53_zone_name
  private_zone = false
}

data "aws_caller_identity" "current" {}

# ── Resolved locals ─────────────────────────────────────────
locals {
  name_prefix = "${var.project_name}-${var.environment}"

  # Resolve from shared state or fall back to variables
  has_remote_state = var.vpc_id == "" && length(data.terraform_remote_state.platform) > 0
  platform_outputs = local.has_remote_state ? data.terraform_remote_state.platform[0].outputs : tomap({})

  vpc_id = local.has_remote_state ? local.platform_outputs.vpc_id : var.vpc_id

  private_subnet_ids = local.has_remote_state ? local.platform_outputs.private_subnet_ids : var.private_subnet_ids

  public_subnet_ids = local.has_remote_state ? try(
    local.platform_outputs.public_subnet_ids,
    compact([
      try(local.platform_outputs.public_subnet_id, ""),
      try(local.platform_outputs.public_subnet_b_id, ""),
    ]),
  ) : var.public_subnet_ids

  ecs_cluster_arn = local.has_remote_state ? try(
    local.platform_outputs.ecs_cluster_arn,
    local.platform_outputs.ecs_cluster_name,
  ) : var.ecs_cluster_arn

  alb_listener_arn = local.has_remote_state ? try(
    local.platform_outputs.alb_listener_arn,
    local.platform_outputs.https_listener_arn,
  ) : var.alb_listener_arn

  alb_security_group_id = local.has_remote_state ? local.platform_outputs.alb_security_group_id : var.alb_security_group_id
  alb_dns_name          = local.has_remote_state ? try(local.platform_outputs.alb_dns_name, "") : try(data.aws_lb.shared[0].dns_name, "")
  alb_zone_id           = local.has_remote_state ? try(local.platform_outputs.alb_zone_id, "") : try(data.aws_lb.shared[0].zone_id, "")
  alb_arn               = local.has_remote_state ? try(local.platform_outputs.alb_arn, "") : var.alb_arn
  alb_arn_suffix = local.alb_arn != "" ? replace(local.alb_arn, "/^.*loadbalancer\\//", "") : try(
    join("/", slice(split("/", replace(local.alb_listener_arn, "/^.*listener\\//", "")), 0, 3)),
    "",
  )
  manage_public_edge = local.has_remote_state ? false : var.manage_public_edge

  account_id = data.aws_caller_identity.current.account_id
}
