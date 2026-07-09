# Local Observer Routing Evals - Scope

## Goal

Define an observability/eval framework for answering one question:

```text
Given the context and tool surface an agent saw, did it make a good tool-use or
routing decision?
```

The acting agent should not be artificially boxed into a special routing output
format. It should receive its normal context, reason normally, and use the
normal tool-calling path. A stronger observer/evaluator agent periodically
reviews the resulting trace and records whether the weaker agent behaved well.

This is meant to support local models first because they are cheaper and more
likely to make tool-calling mistakes. The framework should apply equally to
manager, routing, coding, review, and local-model agents.

## Existing Foundation

Reuse the existing system instead of creating a parallel one:

- Tool definitions already have names, descriptions, and JSON Schema
  parameters.
- Runtime adapters already translate tool definitions for OpenAI, Anthropic,
  OpenAI-compatible, and prompt-based models.
- `agent_tool_call_event`, `broker_run`, `broker_task`, messages, work items,
  and scheduled task runs already form the durable trace of what an agent saw
  and did.
- `agent_eval_suite`, `agent_eval_case`, `agent_eval_run`,
  `agent_eval_run_case`, `agent_eval_assertion_result`, and
  `agent_eval_observation` already provide the database-backed eval catalog and
  evidence store.
- Manager and routing agents already own dispatch decisions. The observer
  framework should evaluate those decisions, not replace them.

## Design Principle

Do not hamstring the acting agent with deterministic routing enums except where
the system has a real invariant, such as malformed JSON, a missing tool, or a
tool execution failure.

The model behavior we care about is often edge-case reasoning:

- It might choose an unusual but defensible tool.
- It might escalate to a human for a reason the fixture author did not
  anticipate.
- It might skip a run because the cost is not justified.
- It might dispatch a stronger runner because the local model is not capable
  enough.

Those choices should be judged after the fact by a stronger evaluator, with the
trace available as evidence.

## Trace Contract

Each evaluated case should produce or load an `agent_trace`:

```json
{
  "traceId": "trace-123",
  "actingAgent": {
    "role": "routing",
    "provider": "local",
    "model": "small-local-model"
  },
  "task": "Decide whether this PR needs follow-up work.",
  "artifactSnapshot": {
    "kind": "pull_request",
    "provider": "github",
    "locator": {
      "repository": "owner/repo",
      "number": 123
    },
    "state": {
      "checks": [{ "name": "test", "status": "passed" }],
      "reviews": [{ "state": "commented" }]
    },
    "signals": ["review comment present", "tests passed"]
  },
  "workspacePolicy": {
    "preferCheapObservation": true
  },
  "availableTools": [
    {
      "name": "dispatch_runner",
      "description": "Dispatch a runner for follow-up work.",
      "parameters": {
        "type": "object",
        "properties": {
          "runner": { "type": "string" },
          "reason": { "type": "string" }
        }
      }
    }
  ],
  "promptSummary": "The agent saw one unresolved review comment.",
  "toolCalls": [
    {
      "name": "dispatch_runner",
      "arguments": {
        "runner": "codex",
        "reason": "Address the review comment."
      },
      "status": "completed"
    }
  ],
  "outcome": {
    "followUpRunStarted": true
  }
}
```

Provider-specific data stays under `artifactSnapshot.locator`,
`artifactSnapshot.state`, `metadata`, or `outcome`. The framework should not be
GitHub-specific.

## Evaluator Agent

The evaluator should be a stronger model than the agent being judged. Examples:

- GPT-class cloud model reviews a small local model's routing decisions.
- Claude Code reviews a Codex or local coding trace.
- Manager agent periodically reviews recent local observer decisions.

The evaluator receives:

1. the agent trace;
2. the available tool specs the acting agent saw;
3. relevant workspace policy;
4. a rubric;
5. an observer tool for recording the judgment.

The evaluator records a judgment by calling:

```text
observer_record_evaluation
```

with arguments:

```json
{
  "verdict": "correct",
  "confidence": 0.86,
  "reasoning": "The PR had an unresolved review comment and Codex was an appropriate follow-up runner.",
  "observedBehavior": "The routing agent called dispatch_runner with runner=codex.",
  "expectedBehavior": "Start a coding follow-up or escalate if the comment is ambiguous.",
  "failureModes": [],
  "strengths": ["used available review context"],
  "issues": [],
  "suggestedFollowUp": null
}
```

The observer tool is for recording evaluation evidence. It does not mutate the
work item, dispatch a runner, or change policy.

## Verdicts

- `correct` - the observed decision was reasonable for the context.
- `incorrect` - the observed decision was materially wrong.
- `partially_correct` - the decision had useful parts but missed something
  important.
- `inconclusive` - the trace does not contain enough evidence to judge.

## Failure Modes

Initial failure labels:

- `wrong_tool`
- `missing_tool_call`
- `unnecessary_tool_call`
- `bad_arguments`
- `missed_escalation`
- `premature_escalation`
- `missed_context`
- `unsafe_action`
- `wasted_tokens`
- `other`

These labels support aggregation. The evaluator's natural-language reasoning is
the source of truth for edge cases.

## API Surface In This PR

This PR adds two lightweight API helpers for eval harnesses:

- `POST /api/evals/local-observer-routing/render-evaluation-prompt`
  - Input: `trace`, evaluator identity, optional rubric, optional case prompt.
  - Output: evaluator prompt, `observer_record_evaluation` tool spec, and the
    normalized trace.
- `POST /api/evals/local-observer-routing/review-evaluation`
  - Input: trace plus evaluator judgment.
  - Output: accepted judgment plus trace-quality notices.

The second endpoint is intentionally not a deterministic pass/fail gate. It
only adds observability notices, such as "the trace contains a tool call that
was not listed in availableTools" or "an incorrect judgment has no issue
detail." The evaluator agent owns the semantic judgment.

## Eval Suite Shape

Seed a system-managed suite:

```text
agent_eval_suite.slug = local-observer-routing
suite_type = agent_observer
```

Initial tags:

- `agent_trace`
- `tool_calling`
- `routing`
- `observer`
- `local_model`

Useful fixture families:

1. No-op cases where no runner should start.
2. PR/comment cases where a coding runner should be dispatched.
3. Review cases where a second-pass reviewer should be used.
4. Ambiguous cases where manager or human escalation is reasonable.
5. Local-model failure cases where the model calls the wrong tool or passes bad
   arguments.
6. Cost-control cases where the right answer is not to spend cloud tokens.
7. Edge cases where multiple answers are defensible and the evaluator should
   judge the reasoning rather than a fixed target.

## Rollout

1. Land the trace/evaluator API contracts.
2. Add a harness that can load recent agent traces from existing run and
   tool-call tables.
3. Seed a small `local-observer-routing` eval suite from representative traces.
4. Run a stronger evaluator periodically against weak/local model traces.
5. Store judgments in the existing eval observation/result tables.
6. Aggregate failure modes by model, agent role, tool, and fixture family.

## Non-Goals

- Do not introduce a second tool-calling system.
- Do not make the framework specific to GitHub PRs.
- Do not grant observer/evaluator agents mutation tools in this workflow.
- Do not use deterministic target matching as the primary quality signal.
- Do not require every edge case to have one predeclared "correct" target.
