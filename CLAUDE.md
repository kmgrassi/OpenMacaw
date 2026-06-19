# OpenMacaw — Agent Guide

Repo-level orientation for agents. Each subsystem has its own guide
(`platform/`, `runtime/`, `local-runtime-helper/` — see
[Subsystem guides](#subsystem-guides)); repo-wide docs live under `docs/`.

> `AGENTS.md` and `CLAUDE.md` at this level are kept in sync — edit both.

## Repository layout

- `platform/` — web app + API gateway + shared contracts (TypeScript)
- `runtime/` — Elixir orchestrator + launcher
- `local-runtime-helper/` — Go daemon for local model / tool relay
- `docs/` — cross-subsystem planning and reference material

## Local development

From the repo root: `./openmacaw run` starts the platform API (3100), web
(5173), runtime orchestrator (4000), and launcher (4100). It warns and
continues when Supabase is not configured; use
`OPENMACAW_AUTO_SUPABASE=1 ./openmacaw run` for opt-in local Supabase setup.
Also `./openmacaw doctor | status | stop`. See `README.md`.

## Pull requests

Do not create any draft PRs. Always create open PRs so they can get reviewed.
Any work that's done should have an open PR created with the work.

## Production deployment (a reusable two-repo pattern)

OpenMacaw separates **application code** from **deployment infrastructure** so
the code repo can stay public while credentials and environment-specific
config stay private. The pattern is generic — fork it for your own project by
substituting your own repos, IAM role, and resource names.

- **Application repo (this one)** — the code; contributors merge to `main`. It
  also ships reusable deploy workflows under `.github/workflows/deploy-*.yml`
  as building blocks.
- **Private infrastructure repo** — owns the actual deploy. It holds the IaC
  (Terraform), the GitHub Environments + secrets, and a production deploy
  workflow that drives the application repo's code.

### How the deploy works

1. The infra repo's production deploy workflow runs on a **schedule (e.g.
   every 15 minutes)**, plus manual dispatch with a `ref` input (default
   `main`).
2. It resolves the target commit from the application repo's `main` and **only
   deploys when relevant paths changed** (`platform/**`, `runtime/**`, the
   Supabase schema, the Terraform stacks, the deploy workflows).
3. It builds and pushes the platform-api and runtime-orchestrator images
   **tagged with the application commit SHA**, runs Supabase migrations, and
   updates the ECS services.
4. It authenticates to AWS via **GitHub OIDC**, assuming a deploy IAM role
   whose trust policy is scoped to the **infra repo's** `production`
   environment (`repo:<your-org>/<infra-repo>:environment:production`).

### What this means for contributors

- **Merging to `main` is enough to ship to prod.** The scheduled deploy picks
  it up automatically — typically live within one cron interval. No manual
  deploy step.
- **Don't run this repo's `deploy-*.yml` workflows directly.** They assume an
  OIDC role that trusts the *infra* repo, not this one — a direct
  `workflow_dispatch` from here fails at the AWS-credentials step ("Could not
  load credentials from any providers"). They're reusable building blocks the
  infra repo drives; the real entry point is the production deploy workflow in
  the infra repo.
- **To check what's live**, compare the deployed image SHA to
  `git rev-parse origin/main` — the running ECS task's image tag is the
  deployed application commit SHA.

### Setting up your own deployment

1. Create a private infra repo with your IaC and a production deploy workflow
   (start from this repo's `deploy-*.yml` as reusable workflows).
2. Create a GitHub OIDC provider + deploy IAM role in your AWS account; scope
   the role's trust to `repo:<your-org>/<your-infra-repo>:environment:production`.
3. Set `AWS_DEPLOY_ROLE_ARN` (and your other deploy secrets) on the infra
   repo's `production` GitHub Environment.
4. Point the deploy workflow at your application repo's `main`.

> Keep account IDs, role/secret ARNs, internal hostnames, and SSM parameter
> paths in your **private** infra repo — never in the public code repo (see
> [`docs/open-source-readiness-scope.md`](docs/open-source-readiness-scope.md)).

## Subsystem guides

- Platform (TypeScript): [`platform/AGENTS.md`](platform/AGENTS.md) /
  [`platform/CLAUDE.md`](platform/CLAUDE.md)
- Runtime (Elixir): [`runtime/AGENTS.md`](runtime/AGENTS.md) /
  [`runtime/CLAUDE.md`](runtime/CLAUDE.md)
- Local helper (Go): [`local-runtime-helper/AGENTS.md`](local-runtime-helper/AGENTS.md) /
  [`local-runtime-helper/CLAUDE.md`](local-runtime-helper/CLAUDE.md)
