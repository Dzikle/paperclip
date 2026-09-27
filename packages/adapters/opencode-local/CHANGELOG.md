# @paperclipai/adapter-opencode-local

## Unreleased (owner-maintained fork)

- Bind native runs to the resolved local or prepared remote workspace with
  `--dir`, including session resume and retry. This prevents inherited `PWD`
  from selecting a different OpenCode session directory. Existing matching
  `extraArgs`/legacy `args` directory flags are normalized; conflicting or
  missing values fail before the run invocation. Configure `cwd` or the
  execution target to change workspaces instead of overriding `--dir`.
- Linux real-child regression coverage includes task/configured cwd, paths with
  spaces, matching/conflicting flags, literal arguments and resume/retry; SSH
  coverage asserts the prepared remote path. No permission or schema changes.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies
  - @paperclipai/adapter-utils@0.3.0

## 0.2.7

### Patch Changes

- Add local OpenCode adapter package with server/UI/CLI modules.
