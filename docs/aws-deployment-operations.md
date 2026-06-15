# AWS Deployment Operations

This document describes how to use OpenMacaw as the deploy source for an AWS
environment. It covers both existing AWS environments and new self-hosted
deployments.

The goal is:

- OpenMacaw source changes are selected for deployment.
- GitHub Actions builds the selected service image.
- GitHub Actions assumes a deploy role through OIDC.
- The workflow reads private environment config from AWS SSM.
- Terraform applies only the OpenMacaw service stack.
- Shared AWS infrastructure remains owned by an existing platform stack or by a
  private environment stack.

## Deployment Model

OpenMacaw should be the application deployment source of truth, not the place
where private AWS account configuration is committed.

The repository owns:

- Dockerfiles and service build contexts.
- Terraform modules/stacks for OpenMacaw services.
- GitHub Actions deploy workflows.
- Public example SSM config shapes.
- Manual/reusable service deploy workflows.

The AWS account owns:

- concrete account IDs;
- Terraform state bucket and lock table;
- VPC, subnet, ALB, Route53, ECS cluster, and shared platform values;
- private domains;
- Supabase keys and other secrets;
- SSM parameter values used by deploy workflows.

A private deployment repository can own:

- scripts that generate real SSM deploy config from private values;
- scripts that upload config to SSM;
- autonomous environment-specific workflows;
- post-deploy health checks and notifications;
- rollback or promotion policy.

That split lets OpenMacaw stay reusable while keeping operational details out
of a public repository.

## Service Deploy Workflows

There are currently two service deploy workflows:

- `.github/workflows/deploy-platform-api.yml`
- `.github/workflows/deploy-runtime-orchestrator.yml`

Both workflows can be run manually through `workflow_dispatch` or called by
another workflow through `workflow_call`. The public OpenMacaw repository does
not include environment-specific autonomous production deployment; keep that in
a private deployment repository.

Manual runs can deploy `development`, `staging`, or `production`; production
should be run with `deploy_environment=production` and `environment_slug=prod`.
If `environment_slug=prod` or `deploy_config_param` contains `/prod/`, the
workflow forces the GitHub Environment to `production` so production approvals
and credentials are always used.

Each workflow:

1. checks out OpenMacaw;
2. assumes `AWS_DEPLOY_ROLE_ARN` through GitHub OIDC;
3. reads deploy config JSON from SSM;
4. writes temporary Terraform backend and tfvars files on the runner;
5. builds and pushes an image tagged with the commit SHA and `main`;
6. runs `terraform init`;
7. runs `terraform apply`;
8. writes the deployed image URI back to SSM.

For autonomous deployment, create a private workflow that either calls these
workflows with `workflow_call` or checks out OpenMacaw and reproduces the same
service deployment steps with private environment values. The private workflow
should define its own path filters, service order, health checks, and failure
notifications.

## Self-Hosted AWS Setup Checklist

For a new AWS deployment, create these pieces before running the OpenMacaw
service workflows:

1. Terraform backend:

```text
S3 bucket:      <your-terraform-state-bucket>
DynamoDB table: <your-terraform-lock-table>
Region:         us-east-1 or your selected AWS region
```

2. Network and compute baseline:

```text
VPC
Private subnets for ECS tasks
Public subnets if you manage an ALB
ECS cluster
Cloud Map namespace for runtime discovery
Security groups
Optional EFS file system/access point for runtime workspaces
Optional ALB/listener/target groups for public API traffic
Optional Route53/ACM/CloudFront/S3 for public domains and web assets
```

3. GitHub configuration:

```text
GitHub Environment: development, staging, or production
Secret: AWS_DEPLOY_ROLE_ARN
```

4. AWS private configuration:

```text
/openmacaw/<env>/platform-api/deploy/config
/openmacaw/<env>/runtime-orchestrator/deploy/config
```

5. Runtime secrets:

```text
Supabase URL and SSM/Secrets Manager ARNs
Model provider keys as SSM/Secrets Manager ARNs
Any integration credentials as SSM/Secrets Manager ARNs
```

Do not commit real Terraform backend files, `tfvars` files, AWS account IDs,
domain names, or secret values to a public repository.

## Existing Infrastructure Contract

Before OpenMacaw can deploy into an existing AWS environment, that environment
must provide one of the following:

- shared platform Terraform state containing VPC, subnet, ALB, and ECS cluster
  outputs; or
- explicit VPC, subnet, ALB, listener, security group, and ECS cluster values in
  the service deploy config.

The existing infrastructure should keep owning:

- public edge routing and ALB listener policy, unless the OpenMacaw stack is
  explicitly configured to manage its own public edge;
- shared VPC/subnets;
- shared ECS cluster;
- shared Terraform backend bucket and lock table;
- DNS zones and private hosted zones;
- AWS account-wide IAM baseline.

OpenMacaw service stacks should own:

- service-specific ECR repositories/images;
- service-specific ECS task definitions and services;
- service-specific CloudWatch log groups/alarms;
- service-specific IAM task roles where not supplied;
- service-specific security groups;
- service-specific Cloud Map registration for internal runtime discovery.

## Private Deployment Repository Pattern

For production, prefer a private repository that contains no plaintext secrets
but does contain environment-specific deployment automation.

Recommended contents:

```text
README.md
scripts/
  build-deploy-configs.mjs
  put-deploy-configs.sh
.github/workflows/
  deploy-production.yml
```

The private repo workflow can:

1. resolve the OpenMacaw commit to deploy;
2. skip deployment when the deployed SSM image pointers already match;
3. deploy the runtime orchestrator first;
4. wait for runtime ECS stability;
5. deploy the platform API;
6. wait for platform ECS stability;
7. check the public API health endpoint;
8. notify or open an issue on failure.

A minimal private orchestrator can call OpenMacaw's reusable workflows:

```yaml
name: Deploy Production

on:
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  deploy-runtime:
    uses: YOUR_ORG/OpenMacaw/.github/workflows/deploy-runtime-orchestrator.yml@main
    with:
      deploy_environment: production
      environment_slug: prod
      deploy_config_param: /openmacaw/prod/runtime-orchestrator/deploy/config
      image_uri_param: /openmacaw/prod/runtime-orchestrator/deploy/image-uri
    secrets: inherit

  deploy-platform:
    needs: deploy-runtime
    uses: YOUR_ORG/OpenMacaw/.github/workflows/deploy-platform-api.yml@main
    with:
      deploy_environment: production
      environment_slug: prod
      deploy_config_param: /openmacaw/prod/platform-api/deploy/config
      image_uri_param: /openmacaw/prod/platform-api/deploy/image-uri
    secrets: inherit
```

If the private repo is not in the same organization or cannot use
`secrets: inherit`, pass named secrets explicitly according to GitHub's reusable
workflow rules.

The deploy role trust should target the private repo and environment, for
example:

```json
{
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_DEPLOY_REPO:environment:production"
  }
}
```

If you deploy directly from a private fork of OpenMacaw instead, scope the trust
policy to that fork and production environment.

## Required GitHub Configuration

Create a GitHub Environment for each deploy environment, such as
`development`, `staging`, and `production`.

For each environment, set:

```text
AWS_DEPLOY_ROLE_ARN=arn:aws:iam::<account-id>:role/<github-oidc-deploy-role>
```

The deploy role should trust this repository through GitHub OIDC and should be
scoped to:

- read SSM deploy config parameters;
- read/write the Terraform backend and lock table;
- manage OpenMacaw ECR repositories and images;
- apply the specific OpenMacaw Terraform stacks;
- write deployed image URI SSM pointer parameters;
- read secret parameters referenced by ECS task definitions where needed.

For public repositories, avoid allowing broad role assumption from all branches.
Prefer one of these trust subjects:

```text
repo:YOUR_ORG/YOUR_PRIVATE_DEPLOY_REPO:environment:production
repo:YOUR_ORG/YOUR_PRIVATE_OPENMACAW_FORK:environment:production
```

Avoid this for production unless the repository is private and branch controls
are strict:

```text
repo:YOUR_ORG/YOUR_REPO:*
```

## Required AWS SSM Parameters

The current workflow defaults use:

```text
/openmacaw/dev/platform-api/deploy/config
/openmacaw/dev/platform-api/deploy/image-uri
/openmacaw/dev/runtime-orchestrator/deploy/config
/openmacaw/dev/runtime-orchestrator/deploy/image-uri
```

For production, the manual workflow defaults resolve to:

```text
/openmacaw/prod/platform-api/deploy/config
/openmacaw/prod/platform-api/deploy/image-uri
/openmacaw/prod/runtime-orchestrator/deploy/config
/openmacaw/prod/runtime-orchestrator/deploy/image-uri
```

For staging, use the same shape under `/openmacaw/staging/...`. If an existing
AWS account uses a different naming scheme, set the manual workflow
`deploy_config_param` and `image_uri_param` inputs to the full SSM paths.

Use `SecureString` for deploy config parameters when the JSON contains any
sensitive Terraform values. Prefer SSM or Secrets Manager ARNs for runtime
secrets so ECS injects them into the task at startup instead of storing
plaintext secret values in Terraform state.

The deploy config parameter contains:

```json
{
  "terraform_backend": {
    "bucket": "YOUR_TERRAFORM_STATE_BUCKET",
    "key": "openmacaw/dev/platform-api/terraform.tfstate",
    "region": "us-east-1",
    "dynamodb_table": "YOUR_TERRAFORM_LOCK_TABLE",
    "encrypt": true
  },
  "terraform_vars": {
    "project_name": "openmacaw",
    "environment": "dev"
  }
}
```

Use the example files in `infra/terraform/envs/example/` as the source shape.
The real SSM JSON should include all required stack variables for the target
environment.

Production examples are provided as sanitized templates:

- `infra/terraform/envs/example/platform-api/deploy-config.production.ssm.example.json`
- `infra/terraform/envs/example/runtime-orchestrator/deploy-config.production.ssm.example.json`

## Platform API Deploy Contract

The platform API workflow deploys `platform/apps/api` into the
`infra/terraform/stacks/platform-api` stack.

The deploy config must provide:

- Terraform backend config;
- `project_name`;
- `environment`;
- AWS region;
- runtime/orchestrator URL;
- launcher URL;
- CORS origins for the web client;
- Supabase URL;
- service-role-key SSM ARN when server-side Supabase access is required;
- for production learning-sidecar distillation:
  `openai_api_key_ssm_arn`, `learning_distillation_model`, and a stable
  `learning_embedding_model`;
- either shared platform state pointers or explicit VPC/subnet/ALB/ECS values.

For existing infrastructure, prefer:

```json
{
  "shared_platform_state_enabled": true,
  "shared_platform_state_bucket": "YOUR_SHARED_PLATFORM_STATE_BUCKET",
  "shared_platform_state_key": "openmacaw/shared/terraform.tfstate",
  "shared_platform_state_region": "us-east-1",
  "manage_public_edge": false
}
```

That lets the existing shared platform own public edge infrastructure while
OpenMacaw owns the platform API service deployment.

Reflection and distillation use different credential paths. Reflection reads
the target workspace's stored provider credential from the database; setting
platform task env vars alone does not make reflection work for a workspace with
no stored credential. Distillation is platform-side and requires the API task to
receive `OPENAI_API_KEY` from `openai_api_key_ssm_arn` plus
`LEARNING_DISTILLATION_MODEL` from `learning_distillation_model`.

Keep `learning_embedding_model` stable after enabling learning in production.
Changing it later leaves old and new `memory_items.embedding` vectors in
different embedding spaces, degrading cosine similarity.

## Runtime Orchestrator Deploy Contract

The runtime workflow deploys `runtime/apps/orchestrator` into the
`infra/terraform/stacks/runtime-orchestrator` stack.

The deploy config must provide:

- Terraform backend config;
- `project_name`;
- `environment_name`;
- service name;
- ECR repository name/URI;
- image tag, supplied by the workflow;
- shared platform state pointers or explicit VPC/subnet/ECS values;
- Supabase URL and SSM-backed Supabase anon key, JWT secret, and
  service-role-key values as needed;
- for production learning-sidecar jobs:
  `container_environment.PLATFORM_LEARNING_HANDLER_ENDPOINT` pointing at the
  platform API base URL reachable from the runtime, and
  `container_secrets.PLATFORM_LEARNING_HANDLER_API_KEY` using the same SSM
  parameter ARN as `supabase_service_role_key_ssm_arn`;
- Cloud Map service discovery values for VPC-internal API-to-launcher routing;
- EFS workspace mount values when persistent runtime workspaces are enabled.

For existing infrastructure, prefer:

```json
{
  "shared_platform_state_enabled": true,
  "create_ecs_cluster": false,
  "existing_ecs_cluster_name": "openmacaw-dev",
  "service_discovery_namespace": "openmacaw-dev.local",
  "service_discovery_service_name": "openmacaw-launcher-dev"
}
```

The platform API should then point at the runtime through the private DNS name,
for example:

```text
http://openmacaw-launcher-dev.openmacaw-dev.local:4100
```

The learning handler API key must resolve to the exact same value as the
platform API's `SUPABASE_SERVICE_ROLE_KEY`; the platform uses an exact bearer
token comparison for `requireServiceRoleBearer`. The production reusable deploy
workflow enforces the same SSM parameter ARN to avoid silent 403s at job time.

## Recommended Rollout Flow

1. Select the OpenMacaw commit to deploy.
2. Update or confirm SSM deploy config for the target environment.
3. Run the runtime orchestrator deploy.
4. Wait for runtime ECS stability.
5. Run the platform API deploy.
6. Wait for platform ECS stability.
7. Check CloudWatch logs for service startup.
8. Check API health:

```sh
curl https://<api-domain>/livez
```

9. Check runtime/launcher health from inside the VPC or through the platform API
   path that proxies runtime health.
10. Confirm the SSM image URI pointer was updated to the commit SHA image.

## Manual Deploy Flow

Use manual dispatch when:

- replaying a failed deploy;
- deploying after SSM config changes;
- deploying Terraform-only changes;
- deploying an environment not tied directly to `main`.

From GitHub Actions, run:

- `Deploy Platform API`
- `Deploy Runtime Orchestrator`

For production, choose:

```text
deploy_environment=production
environment_slug=prod
```

The workflow uses the commit selected by the manual run and the configured SSM
deploy config path. Leave `deploy_config_param` and `image_uri_param` empty to
use the `/openmacaw/prod/...` defaults, or set them to full SSM paths for a
private naming convention.

## Migration From Existing Infrastructure

For an existing AWS environment:

1. Keep the existing Terraform backend/state bucket and lock table private.
2. Keep existing VPC, ECS cluster, ALB, DNS, and private service-discovery
   details in shared Terraform state or SSM deploy config.
3. Point OpenMacaw workflows at those values through SSM.
4. Decide which resources OpenMacaw should adopt and which should remain owned
   by the existing shared stack.
5. If adopting an existing AWS resource into an OpenMacaw Terraform stack,
   import it or use Terraform moved/removed blocks intentionally. Do not let a
   first OpenMacaw apply recreate shared production resources.
6. Deploy development first, then staging/production.

During cutover from an older deployment source, keep the old automatic deploy
workflows enabled until OpenMacaw has successfully deployed the matching service
once. After the OpenMacaw production deploy is confirmed, disable or make the
old workflow manual-only so future merges there cannot overwrite
OpenMacaw-managed ECS task definitions.

## What Still Needs To Be Added

- A separate public web client deploy workflow, if the web client is deployed
  outside the platform API.
- A one-time checklist for importing/adopting existing AWS resources into the
  OpenMacaw Terraform stacks.
- Post-deploy smoke checks that run automatically after Terraform apply.
- A rollback playbook that pins ECS services back to a previous image URI.
