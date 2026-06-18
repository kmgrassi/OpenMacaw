variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "platform_state_bucket" {
  description = "S3 bucket containing shared platform Terraform state."
  type        = string
}

variable "platform_state_key" {
  description = "S3 key containing shared platform Terraform state."
  type        = string
}

variable "platform_state_region" {
  description = "Region for shared platform Terraform state bucket."
  type        = string
  default     = "us-east-1"
}

variable "frontend_domain" {
  description = "Frontend domain name."
  type        = string
}

variable "api_domain" {
  description = "API domain name."
  type        = string
}

variable "frontend_route53_zone_name" {
  description = "Hosted zone name for the frontend domain."
  type        = string
}

variable "frontend_route53_zone_id" {
  description = "Hosted zone ID for the frontend domain. Preferred when known."
  type        = string
  default     = null
}

variable "api_route53_zone_name" {
  description = "Hosted zone name for the API domain."
  type        = string
}

variable "api_route53_zone_id" {
  description = "Hosted zone ID for the API domain. Preferred when known."
  type        = string
  default     = null
}

variable "frontend_bucket_name" {
  description = "Optional S3 bucket name for static frontend hosting."
  type        = string
  default     = null
}

variable "broker_target_group_name" {
  description = "Target group name for the broker API service."
  type        = string
  default     = "openclaw-broker"
}

variable "broker_target_group_port" {
  description = "Broker API port behind the ALB target group."
  type        = number
  default     = 3000
}

variable "broker_target_type" {
  description = "ALB target group target type for broker service."
  type        = string
  default     = "ip"
}

variable "broker_health_check_path" {
  description = "Health check path for the broker API target group."
  type        = string
  default     = "/health"
}

variable "relay_target_group_name" {
  description = "Target group name for the local-relay WebSocket service. Empty disables relay edge routing."
  type        = string
  default     = ""
}

variable "relay_socket_port" {
  description = "Runtime orchestrator relay socket port behind the relay target group."
  type        = number
  default     = 4310
}

variable "relay_health_check_path" {
  description = "Health check path for the relay target group."
  type        = string
  default     = "/api/v1/health"
}

variable "relay_deregistration_delay_seconds" {
  description = "Seconds the relay target group keeps draining deregistered targets. Keep short so local helpers reconnect promptly during rolling deploys."
  type        = number
  default     = 5
}

variable "relay_stickiness_enabled" {
  description = "Whether the local-relay target group should use ALB cookie stickiness for initial WebSocket routing."
  type        = bool
  default     = true
}

variable "relay_stickiness_duration_seconds" {
  description = "ALB stickiness cookie duration for local-relay routing."
  type        = number
  default     = 300
}

variable "api_listener_rule_priority" {
  description = "ALB listener rule priority for API host/path routing."
  type        = number
  default     = 210
}

variable "relay_listener_rule_priority" {
  description = "ALB listener rule priority for API /local-relay/* routing. Must be lower than api_listener_rule_priority so it matches first."
  type        = number
  default     = 200
}

variable "ecs_cluster" {
  description = "Shared ECS cluster ARN or name. Used if not found in remote state."
  type        = string
  default     = null
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks. Used if not found in remote state."
  type        = list(string)
  default     = []
}

variable "alb_security_group_id" {
  description = "ALB security group ID. Used if not found in remote state."
  type        = string
  default     = null
}

variable "gateway_image" {
  description = "OpenClaw gateway container image."
  type        = string
}

variable "deploy_run_id" {
  description = "CI run ID associated with this apply."
  type        = string
  default     = ""
}

variable "openclaw_model" {
  description = "Default model for OpenClaw gateway."
  type        = string
  default     = "openai/gpt-4.1-mini"
}

variable "openclaw_gateway_protocol" {
  description = "Negotiated OpenClaw broker/gateway wire protocol version."
  type        = string
  default     = "3"
}

variable "openclaw_supabase_url" {
  description = "Supabase project URL for broker auth/session and DB API routes."
  type        = string
}

variable "openclaw_supabase_anon_key" {
  description = "Supabase anon key used by broker fallback user validation."
  type        = string
  sensitive   = true
}

variable "openclaw_credentials_table" {
  description = "Supabase table name for credential metadata."
  type        = string
  default     = "credential"
}

variable "openclaw_control_ui_allowed_origins" {
  description = "Comma-separated origins allowed by OpenClaw Control UI websocket checks."
  type        = string
}

variable "openclaw_gateway_password_secret_arn" {
  description = "Secrets Manager secret ARN that stores OPENCLAW_GATEWAY_PASSWORD."
  type        = string
}

variable "openclaw_supabase_service_role_secret_arn" {
  description = "Secrets Manager secret ARN that stores SUPABASE_SERVICE_ROLE_KEY."
  type        = string
  default     = null
}

variable "openclaw_broker_base_url" {
  description = "Base URL used by gateway runtime to call broker state endpoints."
  type        = string
}

variable "openclaw_gateway_ws_origin" {
  description = "Origin header sent by broker/server when opening websocket connections to gateway."
  type        = string
}

variable "openclaw_broker_bearer_secret_arn" {
  description = "Secrets Manager secret ARN that stores OPENCLAW_BROKER_BEARER."
  type        = string
  default     = null
}

variable "anthropic_api_key_secret_arn" {
  description = "Secrets Manager secret ARN for ANTHROPIC_API_KEY."
  type        = string
  default     = null
}

variable "openai_api_key_secret_arn" {
  description = "Secrets Manager secret ARN for OPENAI_API_KEY."
  type        = string
  default     = null
}

variable "broker_image" {
  description = "Broker container image."
  type        = string
}

variable "broker_mode" {
  description = "Broker execution mode: inline or queue."
  type        = string
  default     = "inline"
}

variable "broker_command" {
  description = "Optional command override for broker container image."
  type        = list(string)
  default     = []
}

variable "ecs_task_cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 1024
}

variable "ecs_task_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 2048
}

variable "ecs_service_desired_count" {
  description = "Desired task count for the runtime service."
  type        = number
  default     = 1
}

variable "broker_service_desired_count" {
  description = "Desired task count for the standalone broker ECS service."
  type        = number
  default     = 1
}

variable "gateway_service_desired_count" {
  description = "Desired task count for the standalone gateway ECS service."
  type        = number
  default     = 1
}

variable "artifacts_bucket_name" {
  description = "Optional S3 bucket name for OpenClaw runtime artifacts."
  type        = string
  default     = null
}

variable "artifacts_expiration_days" {
  description = "Lifecycle expiration in days for artifacts bucket objects."
  type        = number
  default     = 30
}

variable "runs_table_name" {
  description = "DynamoDB table name for OpenClaw runs."
  type        = string
  default     = "openclaw_runs"
}

variable "tasks_table_name" {
  description = "DynamoDB table name for OpenClaw tasks."
  type        = string
  default     = "openclaw_tasks"
}

variable "terraform_lock_table_name" {
  description = "DynamoDB table name used for Terraform state and CI deploy serialization locks."
  type        = string
}

variable "queue_default_name" {
  description = "SQS queue for default worker tasks."
  type        = string
  default     = "openclaw-tasks-default"
}

variable "queue_browser_name" {
  description = "SQS queue for browser headless worker tasks."
  type        = string
  default     = "openclaw-tasks-browser-headless"
}

variable "queue_local_name" {
  description = "Optional SQS queue for local interactive worker tasks."
  type        = string
  default     = "openclaw-tasks-local-interactive"
}

variable "queue_visibility_timeout_seconds" {
  description = "Visibility timeout for worker queues."
  type        = number
  default     = 600
}

variable "queue_max_receive_count" {
  description = "Max receive count before moving to DLQ."
  type        = number
  default     = 5
}

variable "worker_default_image" {
  description = "Container image for the default worker service."
  type        = string
  default     = "node:20-alpine"
}

variable "worker_default_command" {
  description = "Optional command override for default worker container."
  type        = list(string)
  default = [
    "sh",
    "-lc",
    "echo worker-default placeholder started; while true; do sleep 30; done"
  ]
}

variable "worker_default_task_cpu" {
  description = "CPU units for default worker task definition."
  type        = number
  default     = 1024
}

variable "worker_default_task_memory" {
  description = "Memory in MiB for default worker task definition."
  type        = number
  default     = 2048
}

variable "worker_default_desired_count" {
  description = "Desired count for default worker ECS service."
  type        = number
  default     = 0
}

variable "worker_default_min_count" {
  description = "Autoscaling minimum for default worker ECS service."
  type        = number
  default     = 0
}

variable "worker_default_max_count" {
  description = "Autoscaling maximum for default worker ECS service."
  type        = number
  default     = 10
}

variable "worker_default_scale_out_messages" {
  description = "Scale out threshold for visible messages on default queue."
  type        = number
  default     = 5
}

variable "worker_default_scale_in_messages" {
  description = "Scale in threshold for visible messages on default queue."
  type        = number
  default     = 0
}

variable "gateway_discovery_namespace_name" {
  description = "Cloud Map private DNS namespace for the OpenClaw gateway."
  type        = string
  default     = "openclaw-dev.local"
}

variable "gateway_discovery_namespace_description" {
  description = "Cloud Map private DNS namespace description."
  type        = string
  default     = "Private DNS namespace for OpenClaw services (dev)"
}

variable "gateway_discovery_service_name" {
  description = "Cloud Map service name for the OpenClaw gateway."
  type        = string
  default     = "openclaw-gateway"
}

variable "broker_log_group_name" {
  description = "CloudWatch log group name for the OpenClaw broker."
  type        = string
  default     = "/ecs/openclaw-broker-dev"
}

variable "gateway_log_group_name" {
  description = "CloudWatch log group name for the colocated legacy gateway container."
  type        = string
  default     = "/ecs/openclaw-gateway-dev"
}

variable "gateway_standalone_log_group_name" {
  description = "CloudWatch log group name for the standalone gateway ECS service."
  type        = string
  default     = "/ecs/openclaw-gateway-standalone-dev"
}

variable "broker_security_group_name" {
  description = "Security group name for the broker ECS service."
  type        = string
  default     = "openclaw-broker-service-dev"
}

variable "gateway_security_group_name" {
  description = "Security group name for the gateway ECS service."
  type        = string
  default     = "openclaw-gateway-service-dev"
}

variable "state_efs_creation_token" {
  description = "Creation token for the OpenClaw state EFS file system."
  type        = string
  default     = "openclaw-state-dev"
}

variable "state_efs_security_group_name" {
  description = "Security group name for the OpenClaw state EFS mount targets."
  type        = string
  default     = "openclaw-state-efs-dev"
}

variable "broker_task_execution_role_name" {
  description = "IAM role name for broker/gateway ECS task execution."
  type        = string
  default     = "openclaw-ecs-task-execution-dev"
}

variable "broker_task_execution_secrets_policy_name" {
  description = "IAM policy name for broker/gateway task execution secret reads."
  type        = string
  default     = "openclaw-ecs-task-execution-secrets-dev"
}

variable "broker_task_role_name" {
  description = "IAM task role name for the broker/gateway ECS tasks."
  type        = string
  default     = "openclaw-ecs-task-dev"
}

variable "broker_task_queue_policy_name" {
  description = "IAM policy name for broker queue/artifact access."
  type        = string
  default     = "openclaw-ecs-task-broker-queue-mode-dev"
}

variable "broker_task_family" {
  description = "ECS task definition family for the OpenClaw broker."
  type        = string
  default     = "openclaw-broker-dev"
}

variable "broker_service_name" {
  description = "ECS service name for the OpenClaw broker."
  type        = string
  default     = "openclaw-broker-dev"
}

variable "gateway_task_family" {
  description = "ECS task definition family for the standalone OpenClaw gateway."
  type        = string
  default     = "openclaw-gateway-dev"
}

variable "gateway_service_name" {
  description = "ECS service name for the standalone OpenClaw gateway."
  type        = string
  default     = "openclaw-gateway-dev"
}

variable "worker_log_group_name" {
  description = "CloudWatch log group name for the default OpenClaw worker."
  type        = string
  default     = "/ecs/openclaw-worker-default-dev"
}

variable "worker_gateway_log_group_name" {
  description = "CloudWatch log group name for the gateway sidecar in the default worker task."
  type        = string
  default     = "/ecs/openclaw-gateway-worker-default-dev"
}

variable "worker_security_group_name" {
  description = "Security group name for the default OpenClaw worker ECS service."
  type        = string
  default     = "openclaw-worker-default-service-dev"
}

variable "worker_task_execution_role_name" {
  description = "IAM execution role name for the default OpenClaw worker task."
  type        = string
  default     = "openclaw-ecs-task-execution-worker-default-dev"
}

variable "worker_task_execution_secrets_policy_name" {
  description = "IAM policy name for default worker execution secret reads."
  type        = string
  default     = "openclaw-ecs-task-execution-worker-default-secrets-dev"
}

variable "worker_task_role_name" {
  description = "IAM task role name for the default OpenClaw worker."
  type        = string
  default     = "openclaw-ecs-task-worker-default-dev"
}

variable "worker_task_policy_name" {
  description = "IAM policy name for default worker queue/artifact access."
  type        = string
  default     = "openclaw-ecs-task-worker-default-dev"
}

variable "worker_task_family" {
  description = "ECS task definition family for the default OpenClaw worker."
  type        = string
  default     = "openclaw-worker-default-dev"
}

variable "worker_service_name" {
  description = "ECS service name for the default OpenClaw worker."
  type        = string
  default     = "openclaw-worker-default-dev"
}

variable "worker_scale_out_policy_name" {
  description = "Application Autoscaling scale-out policy name for the default OpenClaw worker."
  type        = string
  default     = "openclaw-worker-default-scale-out-dev"
}

variable "worker_scale_in_policy_name" {
  description = "Application Autoscaling scale-in policy name for the default OpenClaw worker."
  type        = string
  default     = "openclaw-worker-default-scale-in-dev"
}

variable "worker_queue_scale_out_alarm_name" {
  description = "CloudWatch alarm name for worker queue scale-out."
  type        = string
  default     = "openclaw-worker-default-queue-scale-out-dev"
}

variable "worker_queue_scale_in_alarm_name" {
  description = "CloudWatch alarm name for worker queue scale-in."
  type        = string
  default     = "openclaw-worker-default-queue-scale-in-dev"
}

variable "frontend_oac_name" {
  description = "CloudFront origin access control name for the OpenClaw frontend."
  type        = string
  default     = "openclaw-frontend-oac-dev"
}

variable "artifacts_lifecycle_rule_id" {
  description = "S3 lifecycle rule ID for expiring OpenClaw artifacts."
  type        = string
  default     = "expire-dev-artifacts"
}
