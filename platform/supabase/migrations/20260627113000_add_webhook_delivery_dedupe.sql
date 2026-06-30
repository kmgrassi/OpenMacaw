create table if not exists public.webhook_delivery (
  created_at timestamptz default now(),
  delivery_id text not null,
  event_name text not null,
  external_id text not null,
  id uuid default gen_random_uuid(),
  source text not null check (source in ('github', 'linear')),
  workspace_id uuid not null,
  primary key (id),
  unique (source, delivery_id)
);

create index if not exists idx_webhook_delivery_workspace_created_at
  on public.webhook_delivery (workspace_id, created_at desc);

comment on table public.webhook_delivery is
  'Durable replay-protection ledger for signed inbound webhooks.';

alter table public.webhook_delivery enable row level security;

comment on table public.webhook_delivery is
  'Durable replay-protection ledger for signed inbound webhooks. Service-role writes only; no authenticated RLS policy.';
