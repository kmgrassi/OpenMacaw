# Fleet Sampling Observer Scope

A lightweight, always-on learning loop. On a slow tick (hourly / every
few hours) it **samples one running agent**, rotating across the fleet
over time, reads a **small slice** of that agent's most recent run
(~10 messages, not the full transcript), and emits an **advisory
recommendation** that the planning / manager agent can act on.

This is deliberately *not* the heavily-scoped routing-decision engine.
It does not write `routing_rule` rows, does not need a model-pricing
table, and does not require a cost-audit schema. It gathers signal,
reasons in prose, and hands curated observations to other agents. The
value is in **continuous, cheap, bounded** observation — a sample that
rotates — rather than a complete dump.

Companions it builds on (do not re-invent these):

- **[learning-agent-redesign-scope.md](./learning-agent-redesign-scope.md)** —
  the learning meta-agent pattern (an agent reads another agent's
  transcript and acts through normal tools), the `memory_items` store,
  the `memory.search` tool, and server-side transcript sampling.
- **[../../parallel-agent-runtime/docs/closed-loop-agent-observability.md](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/closed-loop-agent-observability.md)**
  — the correlation chain (`trace_id` / `run_id` / `turn_id` /
  `tool_call_id` / `provider_request_id`) and the principle that
  **agents observe through curated APIs, not raw logs**.

## Why

Agents run continuously and nobody watches. An agent can spend a
frontier model on triage a local model would handle, loop on a failing
tool, or thrash against a flaky provider — and the only signal is buried
in transcripts and logs. A full, continuous audit is too expensive (in
both dollars and context tokens). A **rotating sample** gets most of the
value for a fraction of the cost: over a day, every agent in a 10-agent
fleet gets looked at, and the observer never reads more than one small
slice per tick.

## How it works

```
scheduled_task tick (hourly / configurable)
        │
        ▼
1. SELECT one agent  ──── round-robin: the least-recently-sampled
   from the active fleet  agent with a run in the last N hours
        │
        ▼
2. PULL most recent run for that agent (broker_run, newest by
   started_at) + its token usage (broker_task.input/output/total_tokens)
        │
        ▼
3. SAMPLE ~10 most recent messages of that run (message table,
   ordered created_at desc, limit configurable) — NOT the full transcript
        │
        ▼
4. INSPECT with an LLM: "given these messages + token usage + the
   model/provider used, is anything wasteful, stuck, or streamlinable?
   Output a recommendation, or 'nothing notable'."
        │
        ▼
5. EMIT advisory recommendation → memory_items (workspace-scoped,
   tagged observer=fleet_sample, source_run_id linked)
        │
        ▼
   Planning / manager agent reads it (memory.search)
   and decides what to do. The observer advises; it does not mutate.
```

### Sampling discipline (the core idea)

- **One agent per tick.** Not the fleet, not a batch. The tick picks a
  single target.
- **Rotation, not random.** Pick the agent whose last sample is oldest
  (or never sampled) among agents with recent activity. Over `K` ticks a
  `K`-agent fleet is covered once. This is the cursor; see Track A.
- **Slice, not dump.** A fixed, small window of the *most recent* run
  (default 10 messages). A 500-turn run still costs ~10 messages to
  inspect. The window size is config, not code.
- **Advisory by default.** v1 output is a recommendation written to
  `memory_items`. Acting on it is the consuming agent's job. Optional
  tool-calling actions are a later track (E), behind the same
  governance stance as the learning meta-agent (propose, don't silently
  mutate).

## Existing foundation (what we don't build)

| Need | Already exists | Verdict |
|---|---|---|
| Periodic tick | `scheduled_task` + `scheduled_task_run` with `scheduled_agent_message` delivery | PRESENT — schedule the observer/learning agent |
| Which agents are active | `broker_run` (`agent_id`, `workspace_id`, `status`, `started_at`) | PRESENT |
| Most recent run + tokens | `broker_run` newest by `started_at`; `broker_task.input_tokens/output_tokens/total_tokens` | PRESENT |
| Message slice | `message` (`model`, `provider`, `runner_kind`, `run_id`, `created_at`) | PRESENT |
| Insight store | `memory_items` (workspace/agent scope, `source_run_id`, `tags`, `importance`) | PRESENT |
| Hand-off to other agents | `memory.search` tool and planner hand-off | PRESENT / in-flight |
| Out-of-band LLM job dispatch | scheduled learning/observer agent message | in-flight via learning-agent redesign |

The only genuinely new pieces are **the rotation cursor**, **the
sampling/extraction step**, **the inspector prompt**, and (later) **a
curated log-query tool**.

## New schema (minimal — one table)

Migrations live in `harper-server`. One small table doubles as the
rotation cursor *and* the audit trail — keeping with the repo's
"explicit relational schema, not a JSONB blob" convention:

```sql
create table public.fleet_sample (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  agent_id          uuid not null references public.agent(id) on delete cascade,
  sampled_at        timestamptz not null default now(),
  run_id            text,          -- the run that was sampled
  message_count     int not null,  -- how many messages were inspected
  outcome           text not null check (outcome in ('recommendation', 'nothing_notable', 'error')),
  memory_item_id    uuid references public.memory_items(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index fleet_sample_rotation_idx on public.fleet_sample (workspace_id, agent_id, sampled_at desc);
```

Rotation query: among agents with a `broker_run` in the last N hours,
pick the one whose newest `fleet_sample.sampled_at` is oldest (or
absent). No separate cursor state needed.

## Work breakdown (parallelizable)

Tracks A–C have no ordering dependency on each other once the
`fleet_sample` migration lands; they can be built in parallel and wired
together at the end. D depends on the universal `memory.search`
surface. E is optional/later.

### Track A — Selection + rotation (platform-api)
- `harper-server` migration: `fleet_sample` table above.
- A `selectNextSampleTarget(workspaceId)` query: active agents (recent
  `broker_run`) ranked by oldest/absent last sample.
- Records a `fleet_sample` row each tick.
- **Independent.** Testable with seeded `broker_run` rows.

### Track B — Sampling extractor (platform-api)
- Given `agentId`/`workspaceId`: resolve newest `broker_run` →
  `run_id`; pull `broker_task` token totals; pull last N `message`
  rows for that run (N from config, default 10).
- Returns a compact sample payload (messages + model/provider + token
  usage), shaped for the inspector prompt.
- **Independent.** Pure read + assembly.

### Track C — Inspector / recommender
- Scheduled observer/learning-agent message for fleet sampling.
- Inspector prompt: messages + token usage + model used → recommendation
  JSON or `nothing_notable`.
- Writes the recommendation to `memory_items`
  (`tags: { observer: "fleet_sample" }`, `source_run_id`, `importance`)
  via `memory.create`.
- **Depends on:** learning-agent transcript sampling and universal memory
  tools.

### Track D — Consumption by planning / manager agent
- Ensure the planning / manager agent surfaces `observer=fleet_sample`
  recommendations through `memory.search`.
- **Depends on:** universal `memory.search`.

### Track E — Streamlining actions (optional, later)
- Let the observer (or the consuming agent) take bounded actions on a
  recommendation: open a note, flag for human review, or — once the
  intelligent-routing surfaces exist — *propose* a routing-rule change
  for human approval. Same "propose, don't silently mutate" governance
  as the learning meta-agent's draft skill flow.

## Config / flags

| Knob | Default | Where |
|---|---|---|
| Tick interval | every 1–2h | `scheduled_task.schedule` |
| Sample window (messages) | 10 | task config / `workspace_settings` |
| Activity window (agent eligibility) | last 24h of `broker_run` | task config |
| Per-tick agent count | 1 | fixed in v1; could widen later |

## Decisions

- **Sample, don't dump.** One agent, one recent run, ~10 messages per
  tick. Coverage comes from rotation over time, not from breadth per
  tick. This is what keeps both dollar and context-token cost flat.
- **Advisory, not actuating (v1).** Output is a recommendation in
  `memory_items`. No `routing_rule` writes, no config mutation. Actions
  are Track E and gated.
- **Reuse the reflection machinery.** This is a sibling reflection kind
  to the learning sidecar, not a new subsystem. Same dispatch, same
  store, same hand-off tool.
- **Curated logs, not raw.** Any future AWS/CloudWatch input (Track E /
  separate scope) goes through a scoped query tool, per the closed-loop
  observability principle — never a raw log firehose into a prompt.

## Open questions

1. **Recommendation lifecycle.** Do recommendations expire / get
   superseded, or accrete? Lean on `memory_items.supersedes_id` +
   soft-delete; eviction is out of scope (same as sidecar).
2. **Cross-workspace fleets.** v1 is per-workspace (RLS boundary). A
   single observer reasoning across workspaces is out of scope.
3. **Eligibility for "active."** Is "a `broker_run` in the last 24h" the
   right definition of the fleet to rotate over, or should it include
   queued/scheduled agents with no recent run? Start with recent-run;
   revisit once we see real fleets.
4. **Does the observer need the token-usage→model join?** `broker_task`
   holds tokens; `message` holds the model. For a single-model run the
   join is clean; multi-model runs are approximate. Acceptable for an
   advisory signal — flag, don't block on precision.

## Out of scope

- Writing `routing_rule` rows / programmatic routing changes (advisory only).
- A model-pricing / model-tier table (the LLM reasons about cost in prose).
- A routing-decision audit schema (`fleet_sample` + `memory_items` are the trail).
- Full-transcript analysis or every-run coverage (the point is sampling).
- Raw AWS-log access wired straight into prompts (curated query tool, later).
