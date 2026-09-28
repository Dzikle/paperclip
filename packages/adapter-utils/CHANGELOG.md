# @paperclipai/adapter-utils

## Unreleased

### Patch Changes

- Restrict native-child inherited host environment to runtime identity, locale and certificate settings. Provider/project credentials, proxy settings and other variables now require explicit adapter/run bindings; controller database, signing and auth secrets are not ambient agent capabilities. Apply the same projection to native adapter preflight environments.
- OpenCode/Codex provider definitions and `{env:VAR}` expansion now require run bindings; model/hello/quota probes and local GitHub discovery cannot reintroduce ambient controller secrets. Existing native credential-file/home selection and explicit governed tokens remain available; this is environment containment, not filesystem sandboxing.

- Allow the Paperclip host to route adapter sandbox-sync full-tree Git enumeration through its process-wide bounded scheduler.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

## 0.2.7

### Patch Changes

- Version bump (patch)

## 0.2.6

### Patch Changes

- Version bump (patch)

## 0.2.5

### Patch Changes

- Version bump (patch)

## 0.2.4

### Patch Changes

- Version bump (patch)

## 0.2.3

### Patch Changes

- Version bump (patch)

## 0.2.2

### Patch Changes

- Version bump (patch)

## 0.2.1

### Patch Changes

- Version bump (patch)
