# Local Observer Routing Evals — Scope

## Goal

Define an eval framework for using local models as **observers** that recommend
where an input artifact should go next, without granting them mutation tools or
making the framework specific to GitHub.

The first concrete fixture family can be pull-request snapshots because PRs are
a high-value source of coordination work. The framework itself is broader:

```text
artifact snapshot + workspace policy + available runner capabilities
→ local observer model
→ structured routing recommendation
→ deterministic eval assertions
```

The output is advisory. The manager/orchestrator remains the actuator.

## Existing Foundation

Do not create a new eval subsystem for this. Reuse the existing pieces:

- `agent_eval_suite`, `agent_eval_case`, `agent_eval_case_assertion`,
  `agent_eval_run`, `agent_eval_run_case`, `agent_eval_assertion_result`, and
  `agent_eval_observation` already model database-backed eval catalogs,
  results, and evidence.
- `local-tool-calling` already demonstrates a seeded eval suite and runner
  workflow for local models.
- `local_relay` is already the right runner shape for observation: local,
  credentialless, no workspace write, no tool calls.
- `scheduled_task` and `scheduled_task_run` already deliver scheduled agent
  messages, and can deliver curated observation prompts.
- `work_items`, `broker_run`, `broker_task`, messages, and
  `agent_tool_call_event` already form the durable input/output trail for the
  manager and orchestrator.

This scope adds a new eval suite and output contract. It does not replace the
manager scheduler, work-item queue, or execution-profile routing.

## Problem

Local models frequently fail at tool calling and should not be trusted with
mutation by default. They can still be useful if their job is narrower:

- read a bounded snapshot;
- classify the next step;
- explain the evidence;
- recommend a runner or abstain.

That gives OpenMacaw a cheap preflight layer before spending Codex/Claude Code
tokens. The risk is that a weak local model confidently routes work to the wrong
place. We need evals that measure whether local models can make this routing
recommendation reliably before the manager relies on them.

## Non-Goals

- No GitHub-specific product model. Pull requests are fixtures, not the
  abstraction.
- No local-model mutation tools in this eval. The observer should not call
  `git.run`, `shell.exec`, `apply_patch`, or database write tools.
- No automatic `routing_rule` mutation. The local model emits a recommendation;
  the manager/router decides whether to act.
- No LLM judge required for v1 pass/fail. Use deterministic assertions over the
  structured output first.
- No full transcript or full diff dumps by default. Inputs must be bounded and
  redacted.

## Input Contract

Each eval case provides a normalized `artifact_snapshot` in
`agent_eval_case.metadata`. The runner renders it into the observer prompt.

```json
{
  "artifact_snapshot": {
    "kind": "pull_request",
    "provider": "github",
    "locator": {
      "repository": "owner/repo",
      "number": 123
    },
    "version": "head-sha-or-content-version",
    "title": "Add scheduled task delivery",
    "summary": "Short neutral summary of the change.",
    "state": {
      "status": "open",
      "checks": [
        { "name": "test", "status": "failed", "summary": "1 failing test" }
      ],
      "reviews": [
        { "author_kind": "human", "state": "changes_requested" }
      ]
    },
    "signals": [
      "Touches runtime scheduler",
      "Has failing test output",
      "Contains database migration"
    ],
    "diff_summary": {
      "files_changed": 4,
      "additions": 210,
      "deletions": 32,
      "paths": [
        "runtime/apps/orchestrator/lib/symphony_elixir/scheduled_task/scheduler.ex"
      ]
    },
    "constraints": {
      "token_budget": "cheap",
      "local_model_allowed_actions": ["observe", "recommend"],
      "cloud_runners": ["codex", "claude_code"],
      "local_runners": ["local_relay"]
    }
  }
}
```

Other fixture kinds should use the same shape:

- `work_item`
- `plan`
- `document`
- `ci_failure`
- `repository_state`
- `pull_request`
- `scheduled_task_run`

Provider-specific fields stay inside `locator`, `state`, or `metadata`; the
top-level assertion contract remains provider-neutral.

## Observer Prompt Contract

The observer receives:

1. the artifact snapshot;
2. available runner classes and their intended use;
3. workspace policy hints;
4. a strict JSON output schema;
5. an instruction to abstain when evidence is insufficient.

The prompt should emphasize:

- local observation is advisory;
- do not request tools;
- do not invent unavailable state;
- prefer `none` when no work is needed;
- prefer `human` when policy or ambiguity requires a person;
- route based on capability, risk, and current artifact state.

## Output Contract

The local observer must emit exactly one structured recommendation:

```json
{
  "recommended_target": "none",
  "intent": "no_action",
  "confidence": 0.86,
  "reason": "The artifact is already approved and checks passed.",
  "evidence": [
    "checks all passed",
    "latest review approved"
  ],
  "risk_flags": [],
  "follow_up": null
}
```

Allowed `recommended_target` values:

- `none` — no model run should start.
- `manager` — manager should reconcile or create/update work items.
- `codex` — coding/editing run, usually implementation or fix work.
- `claude_code` — cross-model code review, critique, or second-pass fix.
- `local_relay` — local observation/summarization only.
- `local_model_coding` — local coding/editing only when capability gates allow
  it.
- `human` — policy, ambiguity, or external decision needed.

Allowed `intent` values:

- `no_action`
- `triage`
- `review`
- `fix`
- `summarize`
- `route_to_manager`
- `ask_human`
- `run_eval`

`confidence` is a number from 0 to 1. Cases can assert minimum or maximum
confidence depending on ambiguity.

## Eval Suite

Seed a new system-managed eval suite:

```text
agent_eval_suite.slug = local-observer-routing
suite_type = routing_observer
```

Initial tags:

- `local`
- `observer`
- `routing`
- `read_only`
- `artifact_snapshot`

All v1 cases should be side-effect level `read_only`.

### Fixture Families

1. **No-op artifacts**
   - Already reviewed, checks green, no open comments.
   - Expected: `recommended_target = none`, `intent = no_action`.

2. **Needs code fix**
   - Failing checks or clear implementation defect.
   - Expected: `recommended_target in [codex, local_model_coding]`, with
     `local_model_coding` allowed only in fixtures marked locally safe.

3. **Needs review**
   - New artifact version, no review signal.
   - Expected: `recommended_target in [claude_code, manager]`,
     `intent = review`.

4. **Needs manager reconciliation**
   - Multiple stale signals, missing work item, or ambiguous state that should
     be coordinated before a runner starts.
   - Expected: `recommended_target = manager`.

5. **Needs human**
   - Policy-sensitive, destructive, missing required context, or conflicting
     human decisions.
   - Expected: `recommended_target = human`.

6. **Insufficient evidence**
   - Snapshot omits checks/reviews/version data.
   - Expected: `recommended_target in [manager, human]`, low confidence, and an
     evidence note that data is missing.

7. **Local observation only**
   - Needs cheap summary or classification, no mutation.
   - Expected: `recommended_target = local_relay`.

## Assertion Types

Use the existing `agent_eval_case_assertion` table. Add assertion handlers to
the eval runner rather than adding tables.

First-cut deterministic assertions:

- `observer_output_json_schema`
  - final output parses and matches the routing recommendation schema.
- `recommended_target_in`
  - target is in an allowed set.
- `recommended_target_not_in`
  - target avoids unsafe choices, for example no local coding on high-risk
    fixture.
- `intent_equals`
  - intent matches the fixture expectation.
- `confidence_between`
  - confidence lies inside a range.
- `evidence_contains`
  - evidence mentions required fixture signals.
- `abstain_when_insufficient`
  - ambiguous fixtures route to `manager` or `human`, not a coding runner.
- `no_tool_call`
  - observer did not call tools.

Later assertions:

- `router_policy_respected`
- `cost_classification_matches`
- `runner_capability_matches`
- `human_gate_respected`
- `manager_action_matches_recommendation`

## Runner Flow

The eval runner should follow the same general shape as local tool-calling
evals, but target a local observer agent:

1. Load `local-observer-routing` suite from `agent_eval_*`.
2. Resolve the target local observer agent and workspace.
3. For each case, render an observation prompt from
   `agent_eval_case.prompt + metadata.artifact_snapshot`.
4. Send the prompt through the normal agent message path when possible.
5. Persist `agent_eval_run_case`, assertion results, and observations.
6. Write sanitized artifacts under:

```text
platform/.run-artifacts/local-observer-routing/
```

For v1, the observer should run with `runner_kind = local_relay` or another
local no-tools profile. Running with `local_model_coding` should be a separate
mutation-capability suite, not this observer suite.

## API Surface

First-cut API routes are pure contract helpers. They do not run a model and do
not write eval rows:

- `POST /api/evals/local-observer-routing/render-prompt`
  - Body: `artifactSnapshot`, optional `workspacePolicy`, optional
    `availableTargets`, optional `casePrompt`.
  - Returns: rendered observer prompt, output JSON schema, normalized artifact
    snapshot, and available targets.
- `POST /api/evals/local-observer-routing/validate-recommendation`
  - Body: observer recommendation plus deterministic expectations.
  - Returns: normalized recommendation, `valid`, and assertion failures.

These routes give the eval runner and manager preflight a stable boundary before
live local-model execution is wired in.

## How This Feeds Routing

The eval does not route production work directly. It produces model capability
evidence:

```text
local model X can classify artifact snapshots for routing with score S
```

Once a local model passes this suite, the manager/router can use it as a cheap
preflight:

1. A source adapter materializes or refreshes a generic `work_item`.
2. Before starting a cloud runner, the manager asks the local observer to
   classify the work item/artifact snapshot.
3. If the observer says `none`, the manager can mark/snooze without a cloud
   run, subject to policy.
4. If the observer says `codex` or `claude_code`, the manager dispatches the
   appropriate runner.
5. If the observer says `manager` or `human`, the manager keeps coordination
   local or escalates.

The manager remains the source of action. The local observer is a routing
signal.

## Capability Gate

Add a derived capability record later, not in the first eval PR:

```text
local_model_capability
  workspace_id
  local_runtime_machine_id
  provider
  model
  capability_kind = observer_routing
  eval_suite_id
  latest_eval_run_id
  score
  status = candidate | allowed | blocked
  last_verified_at
```

Until that exists, the runner can read the latest
`agent_eval_run.score/status` for the suite and model as the gate.

Suggested thresholds:

- `allowed`: score >= 0.85 and no hard-fail assertions.
- `candidate`: score >= 0.70 but at least one non-critical failure.
- `blocked`: score < 0.70 or schema/tool-call hard failure.

Hard failures:

- invalid JSON output;
- recommends mutation on a no-op fixture;
- recommends local coding on a high-risk fixture;
- calls a tool in observer mode.

## PR Slices

1. **Contracts + fixtures**
   - Add routing recommendation output schema.
   - Add fixture renderer for `artifact_snapshot`.
   - Seed a small `local-observer-routing` eval catalog.

2. **Assertion handlers**
   - Implement deterministic assertions listed above.
   - Persist final output and assertion results through existing
     `agent_eval_*` rows.

3. **Runner command**
   - Add `pnpm run eval:local-observer-routing`.
   - Support dry-run fixture preview and live local-model run.

4. **Capability reporting**
   - Surface latest score per local model in diagnostics/local model settings.
   - No routing mutation yet.

5. **Manager integration**
   - Add an optional manager preflight step that calls an allowed local observer
     only when the model has passed the suite.
   - Treat the recommendation as advisory and record it in work-item metadata or
     run metadata.

## Open Questions

- Should the v1 live runner call the normal chat path, or should it call a
  minimal local relay inference path to avoid needing a full observer agent?
  Prefer normal chat path if feasible, because production will use agents.
- Should capability status be stored in a new table immediately, or derived
  from the latest eval run until the routing integration needs faster lookup?
- How much artifact data is safe to pass to local models by default? Start with
  redacted summaries and bounded path/check/review metadata, not full diffs.
- Should `recommended_target` use runner kinds directly or higher-level roles?
  This scope uses runner-ish targets for deterministic assertions, but manager
  integration may map from roles to execution profiles.
