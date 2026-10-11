import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandCodeAcpExecutor } from "./acp.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "commandcode-execution-fixture-"))); roots.push(root);
  const cwd = path.join(root, "project"), home = path.join(root, "home"), command = path.join(root, "native");
  await fs.mkdir(cwd); await fs.mkdir(path.join(home, ".commandcode"), { recursive: true });
  const artifact = "offline fixture only"; await fs.writeFile(command, artifact, { mode: 0o700 });
  const nativePolicy = { permissions: { defaultMode: "dont-ask", deny: ["*"], allow: [], disableBypass: true } };
  const settings = JSON.stringify({ model: "exact/model", ...nativePolicy });
  await fs.writeFile(path.join(home, ".commandcode/settings.json"), settings);
  await fs.writeFile(path.join(home, ".commandcode/config.json"), JSON.stringify({ model: "exact/model", provider: "command-code", tasteLearning: false, ideContextEnabled: false, autoInstallExtension: false }));
  const runtimes: Array<ReturnType<typeof makeRuntime>> = [];
  function makeRuntime() { return {
    ensureSession: vi.fn(async (_input: unknown) => ({ backendSessionId: "backend", agentSessionId: "native", runtimeSessionName: "session" })),
    setConfigOption: vi.fn(async () => {}), getStatus: vi.fn(async () => ({ models: { currentModelId: "exact/model" }, details: { configOptions: [{ id: "model", type: "select", currentValue: "exact/model", options: [{ value: "exact/model", name: "Exact" }] }] } })),
    startTurn: vi.fn((_input: { text: string }) => ({ events: (async function* () { yield { type: "done", stopReason: "end_turn" }; })(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }), cancel: async () => {} })), close: vi.fn(async () => {}),
  }; }
  const runtime = makeRuntime();
  const createRuntime = vi.fn((_options: unknown) => { runtimes.push(runtime); return runtime as never; });
  const settlements = vi.fn(), execute = createCommandCodeAcpExecutor({ createRuntime, warmHandles: new Map(), onSettlementDisposition: settlements });
  const ctx = { runId: "offline-commandcode", agent: { id: "agent", companyId: "company" }, runtime: {}, context: {},
    config: { command, nativeHome: home, nativeExecutableDigest: createHash("sha256").update(artifact).digest("hex"), cwd, stateDir: path.join(root, "state"),
      provider: "command-code", model: "exact/model", permissionMode: "deny-all", nativePolicy, nativeSettingsDigest: createHash("sha256").update(settings).digest("hex"),
      timeoutSec: 2, paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: [] } }, onLog: vi.fn(async () => {}), onMeta: vi.fn(async () => {}) };
  return { ctx, runtime, execute, createRuntime, settlements, root };
}
describe.runIf(process.platform === "linux")("Command Code unsupported launch boundary", () => {
  it.each([undefined, "capabilities", "availability", "coding"])("blocks phase %s before runtime creation or settings mutation", async phase => {
    const f = await fixture();
    const settings = path.join(f.ctx.config.nativeHome, ".commandcode/settings.json");
    const before = await fs.readFile(settings);
    Object.assign(f.ctx.config, { nativeGuardReady: true });
    Object.assign(f.ctx.context, { nativeQualificationPhase: phase, nativeGuardReady: true,
      nativeGuardConfirmation: { runId: f.ctx.runId, ready: true },
      nativeQualificationBasePolicy: { nativePolicy: f.ctx.config.nativePolicy, permissionMode: "deny-all", nativeSettingsDigest: f.ctx.config.nativeSettingsDigest } });
    const result = await f.execute(f.ctx as never);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "native_permission_unsupported", clearSession: true });
    expect(f.createRuntime).not.toHaveBeenCalled();
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    expect(await fs.readFile(settings)).toEqual(before);
    expect(await fs.stat(path.join(f.ctx.config.nativeHome, ".aif-native-policy")).then(() => true).catch(() => false)).toBe(false);
    expect(result.usage).toBeUndefined(); expect(result.costUsd).toBeUndefined();
  });
});
it("refuses invalid configuration without logging private values on any platform", async () => {
  const createRuntime = vi.fn();
  const execute = createCommandCodeAcpExecutor({ createRuntime });
  const result = await execute({ config: { env: { TOKEN: "fixture-private-token" } },
    context: { nativeGuardReady: true }, onLog: vi.fn(), onMeta: vi.fn() } as never);
  expect(result).toMatchObject({ exitCode: 1, clearSession: true, errorCode: "native_permission_unsupported" });
  expect(createRuntime).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("fixture-private-token");
});
