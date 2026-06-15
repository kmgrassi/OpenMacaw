# ── General ──────────────────────────────────────────────────
variable "project_name" {
  description = "Project identifier used in resource naming"
  type        = string
  default     = "openmacaw"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

# ── Application ─────────────────────────────────────────────
variable "app_port" {
  description = "Port the application listens on"
  type        = number
  default     = 3100
}

variable "image_tag" {
  description = "Docker image tag to deploy from the managed ECR repository"
  type        = string
  default     = "main"
}

variable "desired_count" {
  description = "Number of ECS tasks to run"
  type        = number
  default     = 1
}

variable "cpu" {
  description = "Fargate task CPU units"
  type        = number
  default     = 256
}

variable "memory" {
  description = "Fargate task memory (MiB)"
  type        = number
  default     = 512
}

variable "orchestrator_base_url" {
  description = "Base URL of the upstream OpenMacaw runtime orchestrator"
  type        = string
}

variable "launcher_base_url" {
  description = "Base URL of the upstream launcher service"
  type        = string
  default     = ""
}

variable "orchestrator_request_timeout_ms" {
  description = "Request timeout for orchestrator calls (ms)"
  type        = string
  default     = "15000"
}

variable "launcher_request_timeout_ms" {
  description = "Request timeout for launcher calls (ms)"
  type        = string
  default     = "15000"
}

variable "cors_origins" {
  description = "Comma-separated browser origins allowed to call the API. Must be the origin of the page making the request (i.e. the web client), NOT the API's own domain."
  type        = string
  default     = "http://localhost:5173"
}

variable "local_relay_ws_url" {
  description = "Optional WebSocket URL for the local runtime relay endpoint."
  type        = string
  default     = ""
}

variable "supabase_url" {
  description = "Supabase project URL used for server-side data reads"
  type        = string
  default     = ""
}

variable "supabase_service_role_key_ssm_arn" {
  description = "SSM parameter ARN containing the Supabase service role key"
  type        = string
  default     = ""
}

variable "openai_api_key_ssm_arn" {
  description = "SSM parameter ARN containing OPENAI_API_KEY for platform-side learning distillation jobs"
  type        = string
  default     = ""
}

variable "learning_distillation_model" {
  description = "OpenAI model used by the platform-side learning distiller"
  type        = string
  default     = ""
}

variable "learning_embedding_model" {
  description = "Embedding model used for learning reflection memory embeddings. Keep stable after production launch so vector similarity remains comparable."
  type        = string
  default     = "text-embedding-3-small"
}

# ── Networking (shared platform or explicit) ────────────────
variable "vpc_id" {
  description = "VPC ID (fallback if shared state unavailable)"
  type        = string
  default     = ""
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks"
  type        = list(string)
  default     = []
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for ALB"
  type        = list(string)
  default     = []
}

# ── ECS Cluster (shared platform or explicit) ───────────────
variable "ecs_cluster_arn" {
  description = "ARN of existing ECS cluster"
  type        = string
  default     = ""
}

# ── ALB (shared platform or explicit) ───────────────────────
variable "alb_arn" {
  description = "ARN of existing Application Load Balancer"
  type        = string
  default     = ""
}

variable "alb_listener_arn" {
  description = "ARN of the HTTPS listener on the shared ALB"
  type        = string
  default     = ""
}

variable "alb_security_group_id" {
  description = "Security group ID of the shared ALB"
  type        = string
  default     = ""
}

# ── DNS / TLS ───────────────────────────────────────────────
variable "domain_name" {
  description = "Primary domain for the API (e.g. api.example.com)"
  type        = string
  default     = "api.example.com"
}

variable "certificate_domains" {
  description = "Domains for the ACM certificate"
  type        = list(string)
  default     = ["api.example.com"]
}

variable "route53_zone_name" {
  description = "Route53 hosted zone name"
  type        = string
  default     = "example.com"
}

variable "manage_public_edge" {
  description = "Whether this stack manages public DNS, ACM, and ALB listener routing. Defaults to false when using shared remote state, true otherwise."
  type        = bool
  default     = true
}

# ── CI/CD ───────────────────────────────────────────────────
variable "github_org" {
  description = "GitHub organization or user"
  type        = string
  default     = "kmgrassi"
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "openmacaw"
}

variable "shared_platform_state_enabled" {
  description = "Read VPC, subnets, ALB, and ECS cluster outputs from an existing shared platform Terraform state."
  type        = bool
  default     = false
}

variable "shared_platform_state_bucket" {
  description = "S3 bucket containing shared platform Terraform state."
  type        = string
  default     = ""
}

variable "shared_platform_state_key" {
  description = "S3 key containing shared platform Terraform state."
  type        = string
  default     = ""
}

variable "shared_platform_state_region" {
  description = "AWS region for the shared platform Terraform state bucket."
  type        = string
  default     = "us-east-1"
}

# ── Deploy tracking ─────────────────────────────────────────
variable "deploy_run_id" {
  description = "GitHub Actions run ID that triggered this deploy"
  type        = string
  default     = ""
}

# ── Observability ────────────────────────────────────────────
variable "log_retention_days" {
  description = "CloudWatch log retention period for platform API logs"
  type        = number
  default     = 30
}

variable "alarm_actions" {
  description = "SNS topic ARNs or other CloudWatch alarm actions to invoke when observability alarms fire"
  type        = list(string)
  default     = []
}

variable "ok_actions" {
  description = "SNS topic ARNs or other CloudWatch alarm actions to invoke when observability alarms recover"
  type        = list(string)
  default     = []
}

variable "insufficient_data_actions" {
  description = "SNS topic ARNs or other CloudWatch alarm actions to invoke when observability alarms enter insufficient data"
  type        = list(string)
  default     = []
}

variable "failure_alarm_thresholds" {
  description = "Per-event failure counts over a five minute period that should trigger CloudWatch alarms"
  type        = map(number)
  default = {
    model_call_failed            = 1
    tool_call_failed             = 1
    gateway_ws_upstream_failed   = 1
    gateway_ws_abnormal_closed   = 3
    launcher_unreachable         = 1
    engine_instance_write_failed = 1
    runtime_failure              = 1
  }
}
