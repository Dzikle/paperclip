import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function fixture(pkg, run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "portable assets ")));
  try {
    const source = path.join(repo, "packages", pkg);
    const script = path.join(source, "scripts/copy-build-assets.mjs");
    fs.mkdirSync(path.join(root, "scripts"));
    if (fs.existsSync(script)) fs.copyFileSync(script, path.join(root, "scripts/copy-build-assets.mjs"));
    const build = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).scripts.build.split("&&");
    const stage = build.slice(build.findIndex(part => part.trim() === "tsc") + 1).join("&&");
    const invoke = () => {
      const output = path.resolve(root, "dist/migrations");
      assert.ok(output.startsWith(fs.realpathSync(root) + path.sep));
      return spawnSync(process.platform === "win32" ? process.env.ComSpec : "/bin/sh",
        process.platform === "win32" ? ["/d", "/s", "/c", stage] : ["-c", stage], {
          cwd: root, encoding: "utf8", timeout: 15000,
        });
    };
    return run(root, invoke);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function put(root, relative, bytes) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
}
test("the shared post-build stage copies both notice files byte-for-byte", () => fixture("shared", (root, invoke) => {
  put(root, "src/cliplab/LICENSE", "notice\r\nexact bytes\n");
  put(root, "src/cliplab/PROVENANCE.md", "provenance\n");
  const result = invoke(); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, "dist/cliplab/LICENSE"), "utf8"), "notice\r\nexact bytes\n");
  assert.equal(fs.readFileSync(path.join(root, "dist/cliplab/PROVENANCE.md"), "utf8"), "provenance\n");
}));
test("the DB post-build stage refreshes only generated migrations with exact SQL/journal bytes", () => fixture("db", (root, invoke) => {
  put(root, "src/migrations/0001 first.sql", "SELECT 1;\r\n");
  put(root, "src/migrations/meta/_journal.json", '{"entries":[1]}\n');
  put(root, "src/migrations/meta/0001_snapshot.json", "not packaged");
  put(root, "dist/migrations/stale.sql", "stale");
  put(root, "dist/index.js", "compiled output");
  const result = invoke(); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(root, "dist/migrations")).sort(), ["0001 first.sql", "meta"]);
  assert.equal(fs.readFileSync(path.join(root, "dist/migrations/0001 first.sql"), "utf8"), "SELECT 1;\r\n");
  assert.equal(fs.readFileSync(path.join(root, "dist/migrations/meta/_journal.json"), "utf8"), '{"entries":[1]}\n');
  assert.deepEqual(fs.readdirSync(path.join(root, "dist/migrations/meta")), ["_journal.json"]);
  assert.equal(fs.readFileSync(path.join(root, "dist/index.js"), "utf8"), "compiled output");
}));
test("missing DB inputs fail without erasing the last generated migration set", () => fixture("db", (root, invoke) => {
  put(root, "src/migrations/0001.sql", "SELECT 1;");
  put(root, "dist/migrations/old.sql", "previous output");
  assert.notEqual(invoke().status, 0);
  assert.equal(fs.readFileSync(path.join(root, "dist/migrations/old.sql"), "utf8"), "previous output");
}));
test("missing shared notice inputs return a failing status", () => fixture("shared", (root, invoke) => {
  put(root, "src/cliplab/LICENSE", "notice");
  assert.notEqual(invoke().status, 0);
}));
