import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const files = [
  "packages/paperclip-runner/protocol/manifest.json",
  "packages/paperclip-runner/protocol/schemas/event-v2.schema.json",
  "packages/paperclip-runner/protocol/fixtures/conformance-minimal-run.json",
  "packages/paperclip-runner/protocol/fixtures/replay/unknown-optional-fields.json",
  "packages/paperclip-runner/src/protocol/generated/schema-bundle.ts",
  "packages/paperclip-runner/src/protocol/generated/standalone-validators.ts",
  "packages/paperclip-runner/src/drivers/acpx/generated-sidecar-contract.ts",
  "packages/paperclip-runner/runner/crates/runner-core/src/generated_acpx_sidecar_contract.rs",
];
test("a fresh autocrlf checkout preserves PRP Git byte identities", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prp-checkout-")));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = path.join(root, "empty-config");
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "");
    const git = (cwd, args) => execFileSync("git", args, { cwd, env, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
    git(root, ["init", "--quiet"]);
    fs.writeFileSync(path.join(root, ".gitattributes"), fs.readFileSync(path.join(repo, ".gitattributes")));
    // Canonical fixture blobs let this policy test run without exposing the
    // caller's Git metadata to a container. Real generated checks run separately.
    const originals = files.map(file => Buffer.from(file.endsWith(".json")
      ? '{"schema":"checkout-fixture","fields":["one","two"]}\n'
      : '// generated checkout fixture\n// second canonical line\n'));
    files.forEach((file, index) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, originals[index]);
    });
    git(root, ["-c", "core.autocrlf=false", "add", "--", ".gitattributes", ...files]);
    files.forEach(file => fs.rmSync(path.join(root, file)));
    // This overwrites only our disposable fixture's staged files, never the
    // caller's checkout. No commits, hooks, remotes or global config writes.
    git(root, ["-c", "core.autocrlf=true", "checkout-index", "--all", "--force"]);
    files.forEach((file, index) => assert.ok(
      fs.readFileSync(path.join(root, file)).equals(originals[index]),
      `checkout changed bytes of ${file}; raw contract hashes must remain valid`,
    ));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
