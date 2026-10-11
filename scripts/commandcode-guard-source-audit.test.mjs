import assert from "node:assert/strict";
import { before, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

let audit, functions, parser;
const bundlePath = process.env.AIF_COMMANDCODE_AUDIT_BUNDLE;
const parserPath = process.env.AIF_COMMANDCODE_AUDIT_PARSER;
before(async () => {
  await assert.doesNotReject(async () => { audit = await import("./commandcode-guard-source-audit.mjs"); },
    "the approved pinned-source audit module must exist");
  functions = await audit.readPinnedFunctions({ bundlePath, parserPath });
  parser = await import(pathToFileURL(parserPath).href);
});

test("extracts only the two pinned functions with exact provenance", () => {
  assert.deepEqual(Array.from(functions.keys()), ["createModHost", "anchorPathPattern"]);
  assert.equal(functions.provenance.bundleSha256, "d976c2ad89f93a2b81af4d150dca99aeedfd679f15e8b8c032314e61e484da7b");
  console.log("Pinned audit provenance:", JSON.stringify(functions.provenance));
});
test("refuses a tampered bundle before importing any parser", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commandcode-audit-"));
  try {
    const altered = path.join(root, "altered.mjs");
    await fs.writeFile(altered, "throw new Error('must not execute');");
    await assert.rejects(audit.readPinnedFunctions({ bundlePath: altered, parserPath: "/missing/parser.mjs" }), /native_audit_bundle_mismatch/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("refuses directories and missing artifact inputs", async () => {
  await assert.rejects(audit.readPinnedFunctions({ bundlePath: os.tmpdir(), parserPath }), /native_audit_file_invalid/);
  await assert.rejects(audit.readPinnedFunctions({ parserPath }), /native_audit_path_required/);
});
test("rejects missing and duplicate function declarations", () => {
  assert.throws(() => audit.extractNamedFunctions("function createModHost() {}", parser));
  assert.throws(() => audit.extractNamedFunctions("function createModHost() {} function createModHost() {} function anchorPathPattern() {}", parser));
});
test("refuses a substituted parser before importing its code", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commandcode-audit-"));
  try {
    const altered = path.join(root, "parser.mjs");
    await fs.writeFile(altered, "throw new Error('must not execute parser');");
    await assert.rejects(audit.readPinnedFunctions({ bundlePath, parserPath: altered }), /native_audit_parser_mismatch/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
function newHost() { return audit.createOfflineModHost(functions.get("createModHost")); }
function session(names, events = [], sessionId = "offline-session") {
  return { sessionId, listToolNames: () => [...names], subscribe: () => () => {}, emit: event => events.push(event) };
}
const registration = { name: "offline-guard", path: "/offline/guard.mjs", source: "fixture" };
test("the fixture exposes no ambient process, I/O, timers or code generation", () => {
  const { context } = newHost();
  for (const name of ["process", "require", "fetch", "setTimeout"]) assert.equal(vm.runInContext(`typeof ${name}`, context), "undefined");
  assert.throws(() => vm.runInContext("new Function('return 1')()", context), /Code generation/);
});
test("native empty filter disables the initially bound exempt/control tools", async () => {
  const { host } = newHost(); let api;
  await host.register({ ...registration, factory: async value => { api = value; api.setActiveTools([]); } });
  const names = ["read_file", "agent", "ask_user_question", "run_command"];
  host.bind(session(names));
  assert.deepEqual(Array.from(api.getActiveTools()), []);
  for (const name of names) assert.equal(host.isToolEnabled(name), false);
});
test("native snapshot filter defaults a late MCP tool to enabled", async () => {
  const { host } = newHost(); let api;
  await host.register({ ...registration, factory: async value => { api = value; api.setActiveTools([]); } });
  const names = ["read_file"]; host.bind(session(names));
  names.push("mcp__late__tool");
  assert.equal(host.isToolEnabled("mcp__late__tool"), true);
  assert.deepEqual(Array.from(api.getActiveTools()), ["mcp__late__tool"]);
});
test("native rebind does not deny a newly introduced tool", async () => {
  const { host } = newHost();
  await host.register({ ...registration, factory: async api => { api.setActiveTools([]); } });
  host.bind(session(["read_file"]));
  host.bind(session(["read_file", "mcp__rebound__tool"], [], "rebound-session"));
  assert.equal(host.isToolEnabled("read_file"), false);
  assert.equal(host.isToolEnabled("mcp__rebound__tool"), true);
});
for (const asynchronous of [false, true]) {
  test(`native session-start ${asynchronous ? "rejection" : "exception"} only emits a diagnostic`, async () => {
    const { host, context } = newHost(); const events = [];
    // Real mods and the host share a JS realm. An outer-realm async fixture
    // would fail the vendor's instanceof Promise check for an artificial reason.
    const hook = vm.runInContext(`${asynchronous ? "async " : ""}() => { throw new Error('offline guard failure'); }`, context, { timeout: 1000 });
    await host.register({ ...registration, factory: async api => {
      api.hooks({ onSessionStart: hook });
    } });
    assert.doesNotThrow(() => host.bind(session(["read_file"], events)));
    await host.settle();
    assert.equal(events.filter(event => event.type === "mod_error").length, 1);
    assert.equal(host.isToolEnabled("read_file"), true);
  });
}
test("native registration factory rejection is distinct from nonfatal session hooks", async () => {
  const { host } = newHost();
  await assert.rejects(host.register({ ...registration, factory: async () => { throw new Error("factory rejected"); } }), /factory rejected/);
  assert.equal(host.list().length, 0);
});
test("pinned path anchors distinguish project-relative and filesystem-root rules", () => {
  const context = vm.createContext({ toPosix: value => value.replaceAll("\\", "/") }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(functions.get("anchorPathPattern"), context, { timeout: 1000 });
  const base = { cwd: "/offline/project", home: "/isolated/home" };
  assert.equal(context.anchorPathPattern({ ...base, pattern: "/isolated/home/**" }), "/offline/project/isolated/home/**");
  assert.equal(context.anchorPathPattern({ ...base, pattern: "//isolated/home/**" }), "/isolated/home/**");
});
