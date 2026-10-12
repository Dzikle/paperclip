# PRP checkout and test setup repair — 2026-10-12

## Outcome and approved boundary

The three approved source repairs are implemented locally. This does not establish
whole-repository, provider, release, deployment or merge readiness.

Baseline: `4f103334a49efacdd1277cabd320a903fd0f13ba`.
Source commit: `9436600ba5218d69dc70cd2d8e9cd548225aa036`.

1. Scoped [Git attributes](../../.gitattributes) enforce LF checkout bytes for
   protocol JSON, generated schema TypeScript and both generated ACPX contracts.
   The [checkout regression](../../scripts/__tests__/prp-checkout-bytes.test.mjs)
   uses real Git index/checkout conversion with `core.autocrlf=true`, known LF
   fixture bytes at eight representative paths, and the repository's attributes.
   Its disposable repository avoids access to the caller's Git metadata. It is
   included in the existing trusted PR regression step; no workflow was dispatched.
2. One [native assertion](../../server/src/services/native-runtime/native-session-executor.test.ts)
   now constructs the expected ACPX runtime suffix with host `join()`, retaining
   its leading separator and exact path components. The executor is unchanged.
3. Only the [chat suite's DB startup hook](../../server/src/__tests__/chat-channels.integration.test.ts)
   uses the existing `EMBEDDED_POSTGRES_TEST_TIMEOUT_MS` value of 90,000 ms through
   its test helper. Cleanup, case, global and production deadlines are unchanged.

Five CRLF working artifacts were mechanically converted to LF only after each
normalized buffer matched its HEAD Git blob. No artifact-content diff was staged.
Hashes, generators, schemas and manifests were not modified or regenerated.
No dependency, lockfile, pin, provider gate or runtime behavior changed. Command
Code remains unsupported by owner decision; Cline and managed Claude stay blocked.
No install, login, inference, Docker startup, live DB/controller action, deployment,
board mutation, push or merge was performed.

## Verification evidence

| Check | Result and coverage |
| --- | --- |
| Real Git checkout regression | RED: byte identity changed under autocrlf. GREEN with scoped attributes. |
| Three unchanged raw PRP generators with `--check` | Exit 0: schema modules, ACPX sidecar contract and protocol manifest match sources. |
| Windows checkout/launcher/assets/temp-root/shard regressions | Final rerun: 34/34, zero skips/failures, exit 0; 12.228 seconds. |
| Selected native ACPX path case | RED: one failed. GREEN: one passed, exit 0; 388 other cases deselected; 9.21 seconds. |
| Selected real chat registration case | RED: startup hook timed out at 30,000 ms before the case ran. GREEN: one passed, exit 0; 1,019 other cases deselected; 69.43 seconds overall. |
| Linux checkout regression | Did not execute: Docker's Linux engine pipe was unavailable. No service was started. |
| Fresh root `pnpm typecheck` | Exit 1 at Rust checking: Cargo is not installed. PRP checks and runner TypeScript checking progressed past their former stale-byte gate. |
| Fresh root `pnpm build` | Exit 1 at capability-inventory parsing: `Unexpected token '#'`, generated YAML header parsed as JSON. PRP checks and runner TypeScript build progressed past the former manifest gate. |
| Diff and staged whitespace checks | Exit 0. No PRP artifact-content diff. |

The isolated cold embedded-Postgres startup/migration probe measured 77,419 ms,
exit 0, with cleanup completed. The chat RED run took 182.62 seconds including
150.44 seconds of imports/support probing. The GREEN run spent 29.82 seconds in
its tests/fixture and 39.30 seconds importing. These differing timings justify
using the existing cost-class budget, not a speedup or universal startup guarantee.
The selected chat run unset only its child-process external test DB environment
and used an isolated temporary database, not the live DB.

Commands for the focused Windows checks:

```powershell
node --test scripts/__tests__/prp-checkout-bytes.test.mjs scripts/__tests__/portable-vitest-launch.test.mjs scripts/__tests__/portable-build-assets.test.mjs scripts/__tests__/portable-temp-root.test.mjs scripts/__tests__/run-vitest-stable-shard.test.mjs
node packages/paperclip-runner/scripts/generate-protocol-schema-module.mjs --check
node packages/paperclip-runner/scripts/generate-acpx-sidecar-contract.mjs --check
node packages/paperclip-runner/scripts/generate-protocol-manifest.mjs --check
node node_modules/vitest/vitest.mjs run server/src/services/native-runtime/native-session-executor.test.ts -t 'passes the isolated ACPX runtime directory to the native backend factory' --maxWorkers=1
node node_modules/vitest/vitest.mjs run server/src/__tests__/chat-channels.integration.test.ts -t 'uses the manifest state parameter and rejects expired, reused, and wrong-origin registrations' --maxWorkers=1
```

Vitest labels unselected cases as skipped; those counts are deselection, not
execution coverage. Set `PAPERCLIP_HOME` and `PAPERCLIP_CONFIG` to isolated task
paths and unset `PAPERCLIP_TEST_DATABASE_URL` for the temporary chat DB run.
Root checks used `CARGO_NET_OFFLINE=true`; no dependencies were installed.
The broad build incidentally regenerated the teams catalogue. Only that
task-owned regeneration was restored to its verified clean-start content.
Ignored task logs remain in `.superpowers/sdd/2026-10-12-prp-repair-batch/`.

## Independent review and remaining limits

One read-only `prp_repair_review` examined the exact six-file source batch against
the baseline and found no Critical, Important or Minor findings and no scope drift.
It independently checked representative real artifact byte identity, attributes,
syntax and source scope. Selected RED/GREEN execution evidence was supplied, not
independently rerun by the reviewer.

The review does not establish full chat/native suite correctness, Linux execution,
universal startup timing, provider behavior, release or merge readiness. The
[previous broad run](2026-10-12-portable-entrypoints.md) was interrupted after
recording 192 failing assertion lines without a final result. It was not repeated
in this batch; these repairs do not prove those failures resolved or imply a new
remaining-failure count. Cargo availability and capability-inventory parsing are
recorded next gates, not repaired here. Managed Claude feasibility remains future
work; this batch neither begins it nor grants live qualification authority.
