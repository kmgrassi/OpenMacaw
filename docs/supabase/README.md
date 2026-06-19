# OpenMacaw Supabase Setup

This directory contains the SQL needed to bootstrap a dedicated OpenMacaw
Supabase project.

- [`openmacaw-schema.sql`](openmacaw-schema.sql) is the source SQL for the
  initial OpenMacaw schema.
- [`openmacaw-data-model-inventory.md`](openmacaw-data-model-inventory.md)
  explains which tables were included and which tables from the predecessor
  internal schema were intentionally excluded.

OpenMacaw now owns its own database model. Current OpenMacaw schema changes
must be authored as migrations in `platform/supabase/migrations/` and reflected
in `docs/supabase/openmacaw-schema.sql` when they change the bootstrap schema.
Do not add new OpenMacaw migrations to the historical `harper-server` repo.

## Local Development Quick Start

For local development you do not need a hosted Supabase project. `./openmacaw
run` can start the app stack without Supabase and will print a setup note when
the env files are missing, but login and database-backed agent workflows need
Supabase.

Install [Docker](https://docs.docker.com/get-docker/) and the
[Supabase CLI](https://supabase.com/docs/guides/local-development), then from
`platform/`:

```sh
supabase start          # starts local Postgres, auth, and Studio
supabase migration up --local
supabase status -o env  # prints the local URL and keys
```

Copy the values into the **Required** section of `platform/.env`:

- API URL → `SUPABASE_URL` and `VITE_SUPABASE_DEV_URL`
  (typically `http://127.0.0.1:54321`)
- `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`
- `anon` key → `VITE_SUPABASE_DEV_ANON_KEY`

Copy the same API URL and service role key into `runtime/.env`.

You can also opt into all-in-one local setup from the repository root:

```sh
OPENMACAW_AUTO_SUPABASE=1 ./openmacaw run
```

That starts local Supabase when needed, applies pending migrations from
`platform/supabase/migrations/`, creates `platform/.env` and `runtime/.env`
from their example files when needed, and fills in the local Supabase URL/keys.

Create a login user in Supabase Studio (`http://127.0.0.1:54323`) under
**Authentication → Users → Add user**.

The rest of this document covers creating and maintaining a **hosted**
Supabase project and the reviewed migration workflow.

## Create A New Supabase Project

1. Create a new project in the Supabase Dashboard.
2. Save the project reference from the dashboard URL:
   `https://supabase.com/dashboard/project/<project-ref>`.
3. Save the generated database password somewhere secure for break-glass
   operational access.
4. In the project dashboard, collect the values OpenMacaw will need later:
   `SUPABASE_URL`, anon key, and service role key.

Do not create OpenMacaw tables directly in the remote Dashboard once migration
tracking starts. Supabase's migration guidance is to make schema changes through
migration files and deploy them with `supabase db push`; direct remote schema
edits can put migration history out of sync.

## Initialize Local Supabase Config

From the platform package:

```sh
cd platform
supabase init
```

This creates the `platform/supabase/` directory if it does not exist. If the CLI
reports that Supabase is already initialized, keep the existing config and
continue.

For local testing, start the local Supabase stack:

```sh
supabase start
```

The local stack requires Docker or another compatible container runtime.

## Create The Initial Migration

The initial migration is already checked in at:

```text
platform/supabase/migrations/20260604133000_openmacaw_initial_schema.sql
```

For future schema changes, generate a migration file from `platform/`:

```sh
supabase migration new openmacaw_schema
```

The CLI creates a timestamped file under `platform/supabase/migrations/`, for example:

```text
platform/supabase/migrations/20260603120000_openmacaw_schema.sql
```

For the initial migration only, the migration file should match the reference SQL:

```sh
cp ../docs/supabase/openmacaw-schema.sql supabase/migrations/20260604133000_openmacaw_initial_schema.sql
```

Commit both the migration file and the source SQL. The source SQL remains a
stable reference; the migration file is what Supabase applies.

## Test The Migration Locally

Reset the local database from migrations:

```sh
supabase db reset
```

This recreates the local database and applies all files in
`platform/supabase/migrations/` in timestamp order.

For a quicker local-only apply after the database is already running, use:

```sh
supabase migration up --local
```

## Link And Push To The New Project

Use this section only for non-production hosted projects or first-time project
bootstrap. Production migrations should normally run from the private
deployment workflow described below.

Log in to the Supabase CLI:

```sh
supabase login
```

Link the repo to the new Supabase project:

```sh
supabase link --project-ref <project-ref>
```

Preview the remote migration push:

```sh
supabase db push --dry-run
```

Apply the migration to the linked remote project:

```sh
supabase db push
```

Supabase records applied migrations in
`supabase_migrations.schema_migrations`, so later pushes only apply migrations
that have not already been applied.

## GitHub Migration Validation

The root workflow `.github/workflows/validate-supabase-migrations.yml` validates
OpenMacaw migrations against a fresh local Supabase stack.

It runs automatically on pull requests and pushes to `main` when Supabase
migration files, local Supabase config, or the reference schema changes. The
workflow starts local Supabase, resets the local database from migrations, and
prints local migration status.

This public repository workflow does not require hosted Supabase credentials and
does not deploy to a production database.

## Production Migration Deploys

Production migration deploys should live in a private deployment repository for
the target environment. For KG production, the private deployment repo checks
out `kmgrassi/OpenMacaw` at the selected ref and applies these migrations to the
KG Supabase project using that private repo's protected GitHub environment
secrets.

Do not run `supabase db push` or `supabase migration repair` against a
production Supabase project from a feature branch, agent worktree, or dirty
checkout. That can record a remote migration version before the matching file is
merged to `main`, causing later production deploys to fail with
`Remote migration versions not found in local migrations directory`.

If a manual production migration command is unavoidable, run it through the
guard from the repository root:

```sh
platform/scripts/guard-supabase-prod-migration.sh \
  --project-ref "$SUPABASE_PROJECT_ID" \
  -- supabase db push
```

The guard refuses production project refs unless the checkout is a clean `main`
branch exactly matching `origin/main`. It also refuses common agent worktree
paths. Configure additional guarded production refs with
`OPENMACAW_PROD_SUPABASE_PROJECT_REFS`, comma-separated.

To check whether the current checkout is safe without running a Supabase command:

```sh
pnpm -C platform run db:prod:guard
```

## Regenerate OpenMacaw Schema Artifacts

After the new project has the schema, point local environment variables at the
new Supabase project:

```sh
export SUPABASE_PROJECT_ID=<project-ref>
export SUPABASE_URL=<project-url>
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

Then regenerate checked-in schema artifacts:

```sh
pnpm -C platform run db:schema:sync
pnpm -C runtime run supabase:schema:sync
```

Review the generated diffs before committing. The generated platform and
runtime schema files should match the OpenMacaw project you just linked, not
any previously linked project.

## References

- Supabase local development and CLI quickstart:
  <https://supabase.com/docs/guides/local-development>
- Supabase local development with schema migrations:
  <https://supabase.com/docs/guides/cli/local-development>
- Supabase database migrations:
  <https://supabase.com/docs/guides/deployment/database-migrations>
- Supabase CLI reference:
  <https://supabase.com/docs/reference/cli/overview>
