# Runbook: Autonomous PR-Manager on a Local Model

Goal: a **manager agent**, running on a **local (Ollama) model**, that
autonomously watches open PRs in your active repos and moves them through
review → address → merge — triggering Codex reviews by commenting `@codex`,
and merging when a PR is ready.

This is mostly **configuration, not new code** — the manager agent, its
autonomous scheduler, the `git.run` tool (full `git`/`gh` CLI), and a PR-
shepherding prompt already exist. This runbook wires them together.

> **Read the caveats first** ([§8](#8-caveats--known-limitations)). The two that
> bite: (a) local small models are unreliable at tool-calling, and (b) the
> current prompt dispatches an internal coding runner to *address* reviews
> rather than asking `@codex` — changing that is a prompt edit
> ([§6](#6-tune-the-manager-prompt-to-your-exact-flow)).

---

## Success case (definition of done)

The goal, stated as one observable production scenario:

> **In production, the hosted manager agent resolves its model to a
> developer's locally running Ollama model over the outbound relay. On its
> own cadence — no human in the loop — it queries GitHub for the open PRs
> across a configured set of repos, reads each PR's review and check state,
> and takes the correct next action: comment `@codex review` when a PR is
> unreviewed, comment `@codex address that feedback` when Codex requested
> changes, and squash-merge when the review has been addressed and checks are
> green.**

Acceptance criteria — the goal is met when all of these are observably true:

- [ ] A `type: "manager"` agent in a **production** workspace resolves its
      execution profile to `provider: openai_compatible` + a local model, and
      the local helper shows **online** (diagnostic endpoint confirms it).
- [ ] The manager's scheduler ticks **autonomously** (triggered by schedule /
      work items, not a human chat), and the local model returns **valid tool
      calls** that the runtime executes end-to-end.
- [ ] The model can **query GitHub** across a *set* of repos — i.e. it runs
      `gh pr list/view/checks --repo <owner/repo>` for each configured repo and
      reads back PR/review/check state.
- [ ] **Unreviewed PR** → a `@codex review` comment is posted by the manager.
- [ ] **Codex requested changes** → a `@codex address that feedback` comment is
      posted (requires the prompt tweak in [§6](#6-tune-the-manager-prompt-to-your-exact-flow)).
- [ ] **Approved + green + addressed** → the manager squash-merges the PR.
- [ ] When something is stuck/ambiguous, it **escalates to a human** instead of
      looping.

If you can watch one full cycle hit all seven against real PRs in your repos
with the model running locally, the success case is met.

## Are we moving toward the goal? (readiness)

Short answer: **yes — architecturally we're most of the way there.** The
manager agent, its autonomous scheduler, the local-model relay path, the
`git.run` GitHub tool, and a PR-shepherding prompt all already exist and are
wired. What's left is mostly **configuration, one prompt tweak, and proving it
end-to-end with a local model** — not new subsystems.

| Capability the success case needs | Status | Where / what's left |
|---|---|---|
| Autonomous manager agent on a cadence | ✅ Built | `manager/scheduler.ex` ticks ~60s |
| Hosted manager → local model over relay | ✅ Built | `llm_tool_runner.ex:366` (provider→`LocalRelay`); helper advertises `runtime_managed_tools` |
| Runtime-managed tool loop for local model | ✅ Built | helper parses OpenAI tool calls → runtime executes |
| GitHub read/act (`gh pr list/view/comment/merge`) | ✅ Built | `tools/git_run.ex` |
| PR-shepherding decision logic | 🟡 Mostly | prompt matches review-trigger + merge; **address-via-`@codex` is a 1-line edit** ([§6](#6-tune-the-manager-prompt-to-your-exact-flow)) |
| Watch a *set* of repos | 🟡 Config | one scheduled task / work item per repo; one workspace root hosts `gh --repo <owner/repo>` calls |
| Binding the manager → local model | ✅ Built | runtime-profile editor / `PUT …/runtime-profile` rewrites the rule ([§3](#3-point-the-managers-model-at-the-local-runner), [§9](#9-do-routing-rules-update-when-i-change-an-agents-provider)) |
| Repo-root + `manager_runner_id` wiring | 🟡 Friction | may still need a direct row in some builds ([§8](#8-caveats--known-limitations) #4) |
| Local model emits **reliable** tool calls | 🔴 Unproven | the real risk — depends on the model; capability handshake passes regardless ([§8](#8-caveats--known-limitations) #1) |
| Event-driven PR state tracking | 🔴 Not built | today state is re-derived by polling `gh` each tick (design open question) |
| Proven in production with a local model | 🔴 Not yet | this runbook is the path to the first end-to-end run |

**Verdict:** the blockers are not "build a new system" — they're (1) prove a
local model can drive the tool loop reliably, (2) make the one prompt edit, and
(3) smooth the DB-only wiring. The biggest unknown is local-model tool-call
quality; everything else is plumbing that exists. Re-run the
[checklist](#quick-checklist) and the acceptance criteria above to measure
progress objectively.

> Note on "a set of repos": `gh --repo <owner/repo>` targets any repo the
> runtime's `gh` token can access **without a local checkout**, so a single
> manager can shepherd several repos as long as each scheduled task names its
> repo and the token has access. `git.run` still needs *a* valid
> `local_workspace_root` directory to execute in ([§4](#4-give-the-runtime-github--repo-access)).

## How it works (the moving parts)

```
 scheduled_task ("watch PRs in owner/repo")  every N min
        │  delivered as a prompt
        ▼
 Manager agent (type=manager)
        │  model turn via execution profile → routing rule
        ▼
 Local model (Ollama) via local-runtime-helper (openai_compatible)
        │  emits OpenAI-style tool calls  (runtime_managed_tools: true)
        ▼
 Runtime executes the tool:  git.run → `gh pr list/view/comment/merge`
        │                    + manager tools (dispatch_runner, snooze, mark_done…)
        ▼
 GitHub  (comment "@codex review" / merge PR)
```

- Manager scheduler: `runtime/.../manager/scheduler.ex` (polls every ~60s).
- Model-client selection by `provider`: `runtime/.../runner/llm_tool_runner.ex:366`
  (`openai_compatible`/`local` → `ModelClient.LocalRelay`).
- Capability gate: `runtime/.../manager/model_client/local_relay.ex:188`
  requires `runtime_managed_tools: true`; the helper advertises it at
  `local-runtime-helper/internal/relay/client.go:128`.
- The PR playbook: `runtime/.../prompts/manager-system-v1.md:41-99`.
- `git.run` policy: `runtime/.../tools/git_run.ex` (full `git`/`gh`
  read/write; the only restriction is the executable boundary — the
  command must be `git` or `gh`, no hardcoded subcommand denylist).

---

## Prerequisites

- The OpenMacaw stack running (`./openmacaw run`) with a workspace you own.
- Ollama installed with a **tool-calling-capable** model pulled, e.g.:
  ```sh
  ollama pull qwen2.5-coder:latest
  ```
- The `local-runtime-helper` binary available (see [§2](#2-connect-a-local-ollama-model)).
- `gh` CLI installed on whatever machine runs the **runtime orchestrator**.

Throughout, substitute:
- `WORKSPACE_ID` — your workspace UUID
- `TOKEN` — a Supabase access token for a workspace member
- `owner/repo` — a repo you want watched
- `API` — `http://127.0.0.1:3100` locally

---

## 1. Create the manager agent

`POST /api/stored-agents` with `type: "manager"`
(`platform/apps/api/src/routes/stored-agents.ts`).

```sh
curl -sS -X POST "$API/api/stored-agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Local PR Manager",
    "workspaceId": "'"$WORKSPACE_ID"'",
    "type": "manager"
  }'
```

Save the returned `id` as `MANAGER_AGENT_ID`. Creating a manager agent also
seeds a default execution-profile routing rule — you'll repoint it at the
local model in the next step.

---

## 2. Connect a local Ollama model

Use **Settings → Local runtimes** (the `LocalModelRegistrationCard` flow) to
register a local model. It generates a copy-paste install + start command for
the helper and writes the right `[runner.openai_compatible]` TOML.

The helper config ends up looking like:

```toml
[runner.openai_compatible]
endpoint = "http://127.0.0.1:11434/v1"
model    = "qwen2.5-coder:latest"
```

Start the helper; it opens an **outbound** WSS to the orchestrator and
advertises `runner_kind: openai_compatible` with `runtime_managed_tools: true`.
Confirm it shows up online in Settings (and via the diagnostic endpoint:
`GET $API/api/diagnostic/agents/$MANAGER_AGENT_ID?workspaceId=$WORKSPACE_ID`).

> If you registered the model through the UI, the helper install command is
> generated for you. The manual path is documented in
> `local-runtime-helper/README.md`.

---

## 3. Point the manager's model at the local runner

Do this through the **runtime-profile editor** — no SQL needed. In
**Settings → the manager agent → Runtime**, set:

| Field | Value | Why |
|---|---|---|
| Provider | **Local** (`local`) | `provider = local` selects `ModelClient.LocalRelay`, which dispatches over the relay to the online helper (`runtime/.../runner/llm_tool_runner.ex:366`). |
| Model | `qwen2.5-coder:latest` | your Ollama model |
| Credential | none | local needs no API key |

> **Pick `local`, not `openai_compatible`.** Both are "local-ish", but in the
> manager's model-client selection `local` → `LocalRelay` (relay to the helper,
> outbound-only — what you want), while `openai_compatible` →
> `OpenAICompatibleChat` (a *direct* HTTP call to an endpoint, bypassing the
> relay).

Under the hood this calls `PUT /api/stored-agents/:id/runtime-profile`
(`updateAgentRuntimeProfile`), which **rewrites the agent's routing rule**
(runner kind, provider, model, credential) in one upsert — so switching
providers later updates the rule automatically (see
[§9](#9-do-routing-rules-update-when-i-change-an-agents-provider)). The editor
will confirm the local helper is registered once it's online (fixed for
managers in the PR that ships this runbook — previously it falsely warned
"no helper").

cURL equivalent if you'd rather script it:

```sh
curl -sS -X PUT "$API/api/stored-agents/$MANAGER_AGENT_ID/runtime-profile" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "workspaceId": "'"$WORKSPACE_ID"'", "provider": "local", "model": "qwen2.5-coder:latest" }'
```

Verify resolution with the diagnostic endpoint above — it shows the resolved
execution profile (runner kind, provider, model) and any blockers.

---

## 4. Give the runtime GitHub + repo access

`git.run` shells out to `git`/`gh` **on the machine running the orchestrator**,
using that box's `gh` session — *not* an env token.

1. **Authenticate `gh`** on the runtime host with an account/token that can
   comment on and merge PRs in your repos:
   ```sh
   gh auth login        # or: export GH_TOKEN=<token with repo scope>
   gh auth status       # confirm it's logged in
   ```
2. **Register the workspace's local repo root** so `git.run` knows where to
   run. This is stored in `routing_rule_match` (no REST endpoint today — UI if
   exposed, else direct insert):
   ```sql
   INSERT INTO routing_rule_match (workspace_id, kind, key, value, rule_id)
   VALUES ('<WORKSPACE_ID>', 'local_workspace_root', 'path',
           '/abs/path/to/owner-repo-checkout', NULL);
   ```
   The path must be inside a git checkout of the repo, or `git.run` errors with
   "not inside a Git repository" (`runtime/.../tools/git_run.ex`).

> Optional: set `GITHUB_REPO_WORKSPACE_MAP` (JSON `{"owner/repo":"<workspace>"}`)
> on the API so inbound PR webhooks create `work_items`. Not required for the
> manager to *act* on PRs — it queries GitHub live via `gh` — but useful for
> tracking. Requires an API restart.

---

## 5. Seed the "watch this repo" task

Two options. **A recurring scheduled task is the cleaner path** — it delivers a
prompt straight to the named manager agent on a cadence, and needs no
`manager_runner_id` plumbing.

`POST /api/workspaces/:workspaceId/scheduled-tasks`
(`platform/apps/api/src/routes/scheduled-tasks.ts`):

```sh
curl -sS -X POST "$API/api/workspaces/$WORKSPACE_ID/scheduled-tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "'"$MANAGER_AGENT_ID"'",
    "title": "Watch PRs in owner/repo",
    "instructions": "Watch open PRs in owner/repo and move them through review and merge. If a PR has no review and has been open >10 min, comment \"@codex review\". If Codex requested changes, comment \"@codex address that feedback\". When a PR is approved with all checks green and the review has been addressed, merge it with squash.",
    "enabled": true,
    "schedule": { "kind": "every", "interval": 5, "unit": "minute" },
    "timezone": "Etc/UTC"
  }'
```

The scheduled-task scheduler polls due tasks (~60s) and delivers `instructions`
to the manager as a new session via `ChatGateway`
(`runtime/.../scheduled_task/delivery.ex`).

**Alternative — a work item** (`POST /api/work-items`): set `state: "running"`
and put the watch instructions in `description`/`metadata`. Any manager in the
workspace picks up items where `manager_runner_id IS NULL`
(`runtime/.../manager/work_items/database.ex:87`). Note: the create API can't
set `manager_runner_id`, and only `running`/`awaiting_review` items with
`next_poll_at <= now` are considered due — so the scheduled-task path is
simpler for a recurring watch.

---

## 6. Tune the manager prompt to your exact flow

The shipped playbook (`runtime/.../prompts/manager-system-v1.md:41-99`) already
does:

- **No review, open ≥10 min** → `gh pr comment <n> --body "@codex review"` ✅
- **All green + approved + no unresolved comments** → `gh pr merge --squash` ✅

It differs from your spec in one place: when Codex requests changes, it
**dispatches an internal coding runner** (`dispatch_runner` / `address_review`)
to make the edits, rather than asking Codex. If you want the "ask `@codex` to
address it" behavior, change that branch to:

```
gh pr comment <num> --repo <owner/repo> --body "@codex address that feedback"
```

and tighten the merge gate to require that the review was addressed by **new
commits since the last review**. These are prompt edits — no infra change. (If
you change the shared prompt, it affects every manager agent; consider a
dedicated prompt/agent if you want this behavior isolated.)

---

## 7. End-to-end smoke harness

The manual gold standard above now has a scriptable harness:

```bash
pnpm -C runtime run smoke:manager-github-pr -- \
  --workspace-id "$WORKSPACE_ID" \
  --agent-id "$MANAGER_AGENT_ID" \
  --repo owner/repo \
  --pr owner/repo#123
```

By default this is read-only. It preflights `gh auth`, verifies the target
repo/PR, checks that the local relay has an online Qwen-capable helper, waits
for the manager to be ready, seeds disposable due work items, forces a manager
tick, then asserts persisted `git.run` calls for:

- `gh pr list --repo owner/repo ...`
- `gh pr view <num> --repo owner/repo ...`
- `gh pr checks <num> --repo owner/repo`

It fails if a read-only run observes write commands such as `gh pr comment`,
`gh pr review`, `gh pr merge`, or `git push`.

Real GitHub writes are deliberately gated:

```bash
pnpm -C runtime run smoke:manager-github-pr -- \
  --workspace-id "$WORKSPACE_ID" \
  --agent-id "$MANAGER_AGENT_ID" \
  --repo owner/repo \
  --pr owner/repo#123 \
  --action review-comment \
  --allow-github-writes \
  --confirm-github-writes owner/repo#123
```

Supported write actions are `review-comment` (`@codex review`),
`address-comment` (`@codex address that feedback`), and `merge`
(`gh pr merge --squash --delete-branch`). Keep the read-only run passing
before trying write modes against production repos.

---

## 8. Caveats & known limitations

1. **Local-model tool-calling reliability — the #1 risk.** The capability
   handshake passes *unconditionally* (the helper hardcodes
   `runtime_managed_tools: true`), but that does not mean a given Ollama model
   emits well-formed tool calls. Small models are inconsistent. Use a
   tool-calling-capable model and expect to babysit early. The runtime has a
   repeated-call detector and a ~10-iteration cap as guardrails.
2. **`gh` identity = whoever runs the orchestrator.** Merges/comments are
   attributed to that account. Scope its token to exactly the repos you want
   touched. `git.run` has no `gh` subcommand denylist — it allows the full
   `git`/`gh` surface (force-push, merge, `gh api`, `gh secret/variable`,
   `gh auth`, `gh repo delete`) for any agent granted the tool, so treat the
   runtime host and its `gh` token as privileged.
3. **State is re-derived each tick via `gh` polling**, not events. There's no
   landed event-log/poll-cadence infra yet (it's a design open question), so
   the manager runs `gh pr list/view/checks` each pass and `snooze`s when
   nothing's actionable. Functional, but chatty against the GitHub API.
4. **Some wiring is still DB-only.** The model binding itself is *not* — it's
   the runtime-profile editor ([§3](#3-point-the-managers-model-at-the-local-runner)).
   But the `local_workspace_root` registration ([§4](#4-give-the-runtime-github--repo-access))
   and `manager_runner_id` have no REST/UI surface in every build, so those may
   still need a direct row. Verify what your Settings UI exposes first.
5. **`@codex` is an external bot.** OpenMacaw only *posts the comment*; the
   Codex GitHub app does the review. If that app isn't installed on the repo,
   `@codex` comments do nothing.
6. **Scheduler bootstrap.** A newly created manager agent's scheduler is
   started by the bootstrapper's periodic sweep
   (`runtime/.../manager/bootstrapper.ex`); if it doesn't pick up immediately,
   restart the orchestrator.

---

## 9. Do routing rules update when I change an agent's provider?

**Yes.** The `routing_rule` is the canonical record the runtime resolves
against (preferred over the legacy `gateway_config` fallback), and it is
rewritten automatically whenever you change an agent's provider, model, or
credential — you don't hand-edit it. The write paths:

| You do this | What updates the rule |
|---|---|
| Change provider/model in the **runtime-profile editor** | `updateAgentRuntimeProfile` upserts runner kind + provider + model + credential in one shot (`services/agent-runtime-profile.ts`) |
| Save / swap a **credential** | `syncCredentialIntoRoutingRuleForAgent` (`services/stored-agent-routing.ts`) |
| Change the agent's **model** field | `syncModelIntoRoutingRuleForAgent` (re-derives provider, rewrites the rule) |

So moving an agent **from a hosted ChatGPT/OpenAI provider to a local model**
via the runtime-profile editor rewrites the rule end-to-end: runner kind
(e.g. `codex` → `local_model_coding` for coding agents; managers stay
`llm_tool_runner`), `provider` → `local`, the new `model`, and it **drops the
credential** (local needs none). No stale OpenAI rule is left behind.

**The one seam worth knowing:** "provider" is an explicit choice, not always
inferable from the model string. `deriveProviderFromModel` just reads the part
before the first `/` (`openai/gpt-5.2` → `openai`). A local Ollama id like
`qwen2.5-coder:latest` has no provider prefix, so a **model-string-only edit
can't infer `local`**. That's why switching to local goes through the
runtime-profile editor (which takes the provider explicitly), not a bare model
rename. The editor is the canonical surface; the other sync paths exist to keep
the rule aligned when you touch credentials or a same-family model.

> If a provider switch ever *looks* like it didn't take, check the resolved
> profile via the diagnostic endpoint rather than the editor's old helper
> warning — that warning was the bug fixed alongside this runbook.

---

## Quick checklist

- [ ] Manager agent created (`type: "manager"`) → `MANAGER_AGENT_ID`
- [ ] Ollama model pulled; helper registered + online (`openai_compatible`)
- [ ] Routing rule: `local_relay` / `openai_compatible` / `<model>`, bound to the agent
- [ ] `gh auth` done on the runtime host; `local_workspace_root` registered
- [ ] Scheduled task ("watch PRs in owner/repo") created against the manager
- [ ] (Optional) prompt edited for the `@codex address` + merge-after-addressed flow
- [ ] Watched a few ticks via the diagnostic endpoint + `gh pr` activity
