import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
test("portable fixtures work when the temporary root is reached through a directory alias", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "portable-temp-root-")));
  try {
    const target = path.join(root, "actual");
    const alias = path.join(root, "alias");
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    const env = { ...process.env, TEMP: alias, TMP: alias, TMPDIR: alias };
    // This is a distinct child test runner, not the parent's worker transport.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec",
      path.join(here, "portable-build-assets.test.mjs"), path.join(here, "portable-vitest-launch.test.mjs")], {
      env, encoding: "utf8", timeout: 30000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(Number(result.stdout.match(/pass (\d+)/)?.[1]) > 0, "child must actually execute the fixture tests");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
