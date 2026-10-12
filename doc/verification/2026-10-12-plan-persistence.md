# Literal issue document bodies — 2026-10-12

Source-only repair against `2d924f711cc2ecbe09dc5dace857862f7329a298`.
Source commit: `884ca5586c4a15da5f0d76ee2cf9409d1e941f82`.

Issue document body strings now survive validation exactly. The Markdown
document endpoint may carry JSON or code; interpreting literal backslash-n,
backslash-r or backslash-r-n sequences corrupts that content. Callers must send
actual line breaks when formatting is intended. String validation and the
524,288-character limit remain. Comments, task descriptions and thread summaries
retain their existing normalization. No storage schema, permissions, revision
history, document format, runtime or provider change was made.

Focused baseline: 30/30. Regression RED: two preservation failures, 31 passes.
Final focused GREEN: 33/33, exit 0. Shared package typecheck and real build exit 0.
An actual-validator round trip through the Factory Orchestrator verifies
multiline strings, literal paths, Unicode, analysis completion and zero-write
replay. A network-disabled disposable Linux test with this validator mounted
read-only also preserves exact JSON body text. No live container mounts or
credentials were used by that test.

The complete Windows shared suite is not green: 764 passed, nine failed, one
unhandled error, 77 files, exit 1, 40.16 seconds. Failures are in unchanged
`frontmatter-runner-contract.test.ts` (stale generated contract),
`worktree-seed-source.test.ts` (three symlink EPERMs and an ENOTDIR expectation),
and `worktree-port-registry.test.ts` (one timeout and three rename EPERMs, plus
an unhandled rename rejection). No unrelated failures were repaired or suppressed.

One read-only source review found no Critical, Important or Minor defects in
this fix and its Factory companion. Factory source
`67aa4ab2ad44003514a38396d045147950605b9d` separately reads the stored plan before
task transitions. Its pinned complete check ran 376 tests, two skips, no failures.
That source review is not a full-repository, database, UI/editor, release, merge
or deployment verdict. Readback and issue transition are separate requests, not
an added atomic document-revision condition.

The live controller remains `3f1194c`; no image build, deployment, record repair,
push or merge occurred. Historical malformed plans remain preserved and fail
closed. The companion report in the Factory repository is
`docs/implementation/PLAN_PERSISTENCE_REPAIR_2026-10-12.md`.

Fresh root `pnpm test:run` passed workspace-link preflight and started real Vitest,
but reached the 180-second task budget without a final summary or aggregate
assertion count. Only its own process tree was stopped. No new FAIL/case-summary
lines were captured; this is incomplete, not passing, verification. The earlier
192-assertion partial run is not claimed resolved. A subsequent dashboard health
request returned `ok`. Global typecheck/build were not repeated here; their
last known Cargo and capability-inventory blockers remain unverified gates.
The ignored `.superpowers/sdd/2026-10-12-plan-persistence/` area retains task logs.
