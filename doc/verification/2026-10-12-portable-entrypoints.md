# Portable verification entry points — 2026-10-12

## Outcome and scope

The owner-approved bounded fix is implemented locally. Windows no longer needs
to spawn a `pnpm` shell shim to start Vitest, and shared/DB post-build asset copies
no longer require Unix `mkdir`, `cp` or `rm` commands. This is not a clean-repo,
merge-ready, deployment or provider-qualification result.

Baseline: `6b7749429b16ca7c72b43f9177fce44d52cd8d9d`.
Source and regression commit: `854ac0e9d674b20ca58fbe17910eddbe43cc56a9`.

- The [stable runner](../../scripts/run-vitest-stable.mjs) resolves the installed
  Vitest package's JavaScript bin and launches it with `process.execPath`.
  List/run arguments, exact chat-case collection guards, project/shard selection,
  test environment, inherited stdio and nonzero failure propagation are retained.
  No shell fallback or dropped suite makes a failed run appear successful.
- [Shared asset copying](../../packages/shared/scripts/copy-build-assets.mjs)
  preflights both notice files and copies exact bytes.
- [DB asset copying](../../packages/db/scripts/copy-build-assets.mjs) preflights
  SQL and journal inputs, rejects linked output parents, and refreshes only
  generated `dist/migrations`. DB source checks and compilation retain their
  order. No live DB migration is applied; generated copies are reproducible from
  the unchanged source assets.
- New Node regressions are included in the existing trusted PR shard-test step.
  Workflow permissions are unchanged. No hosted workflow was dispatched.

No dependency versions, lockfile, provider gate, runtime pin, controller
configuration or live credentials changed. No login, inference qualification,
image build/deployment, push or merge was performed. Command Code stays
unsupported as the owner decided; Cline and managed Claude remain blocked.

## Test evidence

Windows RED: six failures and two passes. The failures reproduced shared shell
syntax, DB `rm` absence, and four launcher paths failing with `pnpm ENOENT`.
Initial GREEN: 32/32, including eight new cases and 24 existing shard cases.

Independent source review found no Critical or Important production issue, but
reported a Minor fixture failure under a Windows temporary-directory junction.
The implementer reproduced four asset-case failures there. Linux's equivalent
symlink also reproduced the asset containment and actual working-directory
mismatch. Both fixture roots now use canonical paths. The dedicated alias
regression failed before that fix and passes afterward on both platforms.

The nested regression explicitly removes the parent Node test-worker transport
marker and requires real child test execution: an initial probe that skipped its
child tests was corrected and is not counted as passing evidence.

Final verification:

| Check | Result and scope |
| --- | --- |
| Windows launcher/assets/temp-alias/shard regressions | 33/33, exit 0; 13.500 seconds. |
| Linux launcher/assets/temp-alias regressions | 9/9, exit 0; existing image `b1ed65f02e37`, disposable `--rm --network none` container and 12 read-only source-file mounts; no controller volumes or credentials. |
| Real shared package build | Exit 0, including compilation and copied notices. |
| Real DB package build | Exit 0, including migration source checks, compilation and generated asset refresh. |
| Exact real output comparison | Two notice files, 282 SQL files and the migration journal match source bytes; SQL filename sets match. |
| Diff whitespace validation | Exit 0. |

Reproduction commands and portability limits are in
[Developing](../DEVELOPING.md#portable-verification-entry-points). The ignored
`.superpowers/sdd/2026-10-12-portable-verification/` workspace retains this task's
logs and the explicit Linux mount helper. No older task's workspace was changed.

## Broader verification remains failed or incomplete

`pnpm -r typecheck` exits 1 after getting past the former shared-build failure:
Paperclip Runner reports **generated PRP schema modules are stale**.
`pnpm build` exits 1 on **generated PRP contract manifest is stale**. No unrelated
contract regeneration was performed. Both also retain the host pnpm warning
about ignored legacy patch/override metadata; dependencies were not re-resolved.

`pnpm test:run` now starts real Vitest instead of failing at its launcher. The
run was interrupted before a final summary/confirmed exit code. Recovery found
no matching stable-runner process. Its retained partial log records 192 failing
assertion lines and these error/failure/skip headers—not an aggregate whole-suite
result or passing proof:

| Server suite | Observed header |
| --- | --- |
| `chat-channels.integration.test.ts` | 1020 tests, 1020 skipped |
| `native-runtime/native-session-executor.test.ts` | 389 tests, 97 failed |
| `workspace-runtime.test.ts` | 161 tests, 38 failed, 20 skipped |
| `environment-runtime.test.ts` | 93 tests, 1 failed |
| `tool-gateway.test.ts` | 66 tests, 66 skipped |
| `execution-workspaces-service.test.ts` | 66 tests, 58 skipped |
| `secrets-service.test.ts` | 91 tests, 91 skipped |
| `native-runtime/external-chat-wait.integration.test.ts` | 142 tests, 142 skipped |
| `company-skills-service.test.ts` | 74 tests, 4 failed |
| `native-status-arbiter-corpus.test.ts` | 31 tests, 31 skipped |
| `routines-service.test.ts` | 64 tests, 64 skipped |
| `attention-service.test.ts` | 26 tests, 26 skipped |
| `file-resources.test.ts` | 35 tests, 5 failed |
| `heartbeat-pending-cleanup-sweep.test.ts` | 37 tests, 37 skipped |
| `claude-local-execute.test.ts` | 28 tests, 26 failed |
| `codex-local-execute.test.ts` | 21 tests, 21 failed |
| `environment-custom-images-service.test.ts` | 31 tests, 15 skipped |

The full suite was not automatically restarted after recovery. These failures
were not suppressed, skipped by new configuration, or repaired by expanding this
bounded task. Remaining lanes and a whole-suite final result are unverified.
The broad build regenerated an unrelated teams catalogue; only that task-owned
regeneration was restored to the verified clean-start baseline, rather than
including it in this source change.

## Review limits and next boundary

One read-only review by `portable_verification_review` on `gpt-6-astra`/`xhigh`
examined the working changes against the recorded baseline and the Windows/Linux
evidence. The fixture correction was verified by RED-to-GREEN tests; no second
review was dispatched. No deferred Minor remains.

The review declined full-suite success, real chat-suite execution and macOS
runtime support; unchanged Unix clean/generate/snapshot-prune commands; recovery
from concurrent output tampering or mid-write crashes; and hosted CI activation,
merge/release readiness and provider/live behavior. These remain unverified or
outside this fix. The synthetic installed Vitest fixture proves invocation, not
real provider or chat compatibility. Helpers retain ordinary nontransactional
build semantics, not an adversarial filesystem-containment guarantee.

Next work must separately diagnose generated-contract reproducibility and the
remaining test-environment failures. Managed Claude native-control feasibility
is still upcoming; none of this work enables it or grants live qualification.
