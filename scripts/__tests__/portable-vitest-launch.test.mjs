import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function fixture(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "portable vitest ")));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    for (const name of ["run-vitest-stable.mjs", "general-server-shard.mjs", "test-line-shard.mjs",
      "general-server-shard-durations.json", "serialized-shard-durations.json"]) {
      fs.copyFileSync(path.join(repo, "scripts", name), path.join(root, "scripts", name));
    }
    fs.mkdirSync(path.join(root, "server/src/__tests__"), { recursive: true });
    fs.writeFileSync(path.join(root, "server/src/__tests__/chat-channels.integration.test.ts"), "");
    fs.mkdirSync(path.join(root, "node_modules/vitest"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/vitest/package.json"), JSON.stringify({
      name: "vitest", type: "module", exports: { "./package.json": "./package.json" }, bin: { vitest: "./vitest.mjs" },
    }));
    fs.writeFileSync(path.join(root, "node_modules/vitest/vitest.mjs"), `
      import fs from 'node:fs'; import path from 'node:path';
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.TEST_CAPTURE, JSON.stringify({args, cwd: process.cwd(),
        nodeEnv: process.env.NODE_ENV, home: process.env.PAPERCLIP_HOME, tmp: process.env.TMPDIR}) + '\\n');
      if (args[0] === 'list') {
        const file = path.join(process.cwd(), 'server/src/__tests__/chat-channels.integration.test.ts');
        let cases = [10,20].map(line => ({name:'case '+line,file,projectName:'@paperclipai/server',location:{line,column:1}}));
        if (args.some(arg => arg.endsWith('.test.ts:20'))) cases = cases.filter(item => item.location.line === 20);
        fs.writeFileSync(args.find(arg => arg.startsWith('--json=')).slice(7), JSON.stringify(cases));
      }
      process.exit(Number(process.env.TEST_EXIT_CODE || 0));
    `);
    return run(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function invoke(root, args, exitCode = 0) {
  const env = { ...process.env, TEST_CAPTURE: path.join(root, "capture.jsonl"), TEST_EXIT_CODE: String(exitCode) };
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = ""; // The installed JS entry must not depend on a pnpm executable/shim.
  const result = spawnSync(process.execPath, [path.join(root, "scripts/run-vitest-stable.mjs"), ...args], {
    cwd: root, encoding: "utf8", env, timeout: 15000,
  });
  const capture = fs.existsSync(env.TEST_CAPTURE)
    ? fs.readFileSync(env.TEST_CAPTURE, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { result, capture };
}
test("runs the installed Vitest entry without pnpm and preserves native-lane arguments/environment", () => fixture(root => {
  const { result, capture } = invoke(root, ["--mode", "general", "--group", "general-server-native-runner"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(capture.length, 1);
  assert.deepEqual(capture[0].args, ["run", "--exclude", "**/dist/**", "--project", "@paperclipai/server",
    "--no-file-parallelism", "--maxWorkers=1", "server/src/services/native-runtime/native-codex-runner.integration.test.ts"]);
  assert.equal(capture[0].cwd, root);
  assert.equal(capture[0].nodeEnv, "test");
  assert.ok(fs.existsSync(capture[0].home));
  assert.ok(fs.existsSync(capture[0].tmp));
}));
test("propagates the Vitest failure code rather than reporting success", () => fixture(root => {
  const { result, capture } = invoke(root, ["--mode", "general", "--group", "general-server-native-runner"], 7);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(capture.length, 1);
}));
test("preserves both workspace projects and their native shard slice", () => fixture(root => {
  const { result, capture } = invoke(root, ["--mode", "general", "--group", "general-workspaces-a", "--shard-index", "1", "--shard-count", "3"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capture.map(call => call.args), [
    ["run", "--exclude", "**/dist/**", "--project", "@paperclipai/ui", "--shard=2/3"],
    ["run", "--exclude", "**/dist/**", "--project", "paperclipai", "--shard=2/3"],
  ]);
}));
test("uses the portable entry for collection and verifies the exact selected chat cases", () => fixture(root => {
  const { result, capture } = invoke(root, ["--mode", "general", "--group", "general-chat", "--shard-index", "1", "--shard-count", "2"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capture.map(call => call.args[0]), ["list", "list", "run"]);
  const args = capture[2].args;
  assert.ok(args.includes("server/src/__tests__/chat-channels.integration.test.ts:20"));
  assert.ok(!args.includes("server/src/__tests__/chat-channels.integration.test.ts:10"));
  assert.ok(args.includes("--allowOnly=false"));
}));
