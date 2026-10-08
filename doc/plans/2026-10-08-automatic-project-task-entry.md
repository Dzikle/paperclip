# Opt-in automatic project task entry

Owner-fork implementation for AI Factory's 2026-10-06 approved task-entry contract.
Paperclip remains the only task, execution, retry and approval authority.

## Entry and handoff

A board-created root `todo` issue with a project and no explicit assignee/policy
defaults to that project's lead only when the lead has `metadata.taskIntake: true`.
Starting an unassigned root backlog issue applies the same rule. Backlog creation,
explicit assignments (including explicit null), child tasks, staged tasks and
non-opted-in projects retain existing behavior. Unavailable opted-in leads fail
closed. Removing a lead removes the opt-in; this is not a separate project flag.

The Factory Orchestrator persists its classification and plan in an issue
document. Coding handoff installs native review/approval stages on that same
issue; it does not create another queue or auto-approve integration.

Conditional PATCH requests accept `expectedStatusVersion`. Status, ownership,
project and execution-policy changes invalidate prior versions. The service
checks under the issue row lock. Guarded stop actions pin the originally observed
explicit run and goal revision, then recheck ownership before acting; they never
look up a replacement run for cancellation. This protects against the tested
A-to-B-to-A race, not a claim of distributed external side-effect atomicity.

## Bounded bootstrap provider fallback

An owner may install `runtimeConfig.providerFallback` in a board-authored agent
configuration revision:

```json
{
  "adapterType": "codex_local",
  "model": "gpt-5.6-sol",
  "extraArgs": ["--sandbox", "read-only", "--add-dir", "/tmp"],
  "qualificationRunId": "<successful same-company native Codex heartbeat UUID>"
}
```

The supported switch is OpenCode to Codex. Qualification checks the successful
run's immutable claimed adapter and recorded model; a bare qualified flag is not
enough. It is prior execution evidence, not a fresh inference probe or guarantee
that authentication is still valid. A switch is allowed only for a typed
OpenCode API rejection before text, tools or completed inference steps. Other
failures and uncertain execution ownership do not authorize a second writer.

The existing bounded scheduled retry transaction checks task ownership and
execution lock, deduplicates a predecessor's successor, and stores a one-switch
receipt in `runnerProfileJson`. It records the board revision, qualification,
predecessor and configuration hash, without credentials. Promotion/claim honor
existing execution, budget, invokability, pause and dependency barriers.
Claim and execution revalidate the same receipt. Resource retries preserve the
selected provider; exhausted switching never silently returns to the primary.
The existing retry sweep recovers the failure-to-scheduling restart window.

Only the effective per-run adapter/config changes. Logical agent ID, permissions,
budgets, workspace and stages stay put; agent database settings are not rewritten.
Instructions and run-scoped env remain those of the logical agent. Provider
sessions start fresh; primary model overrides do not overwrite fallback selection.
`codex_local`/`opencode_local` remain direct native harness adapters, not
`paperclip_runner` runtime mode. Missing cost stays unknown/partial.

## Verification

Disposable Linux PostgreSQL tests exercise actual routes, locks, native retry
transactions and restart reconstruction; only the external provider adapter is
replaced for deterministic fault injection. Coverage includes original intake,
stale handoffs, replacement-run protection, qualified switching, rejected
qualification, exhaustion and scheduling crash recovery. A separate live
deployment/canary receipt is required before claiming end-to-end acceptance.

Known unrelated verification limit: the repository token gate reports 84 color
and 31 arbitrary-value violations in existing UI surfaces/tests. This change
introduces no new color/spacing literals. Do not interpret a successful focused
suite as a clean full repository suite or a live provider-loss proof.
