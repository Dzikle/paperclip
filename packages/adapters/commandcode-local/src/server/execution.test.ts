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
    setConfigOption: vi.fn(async () => {}), getStatus: vi.fn(async () => ({ models: { currentModelId: "exact/model" } })),
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
describe.runIf(process.platform === "linux")("Command Code injected runtime integration", () => {
  it("uses a cold process per project and supplies selected materialized instructions", async () => {
    const f = await fixture(), role = path.join(f.root, "role");
    await fs.mkdir(role); await fs.writeFile(path.join(role, "SKILL.md"), "Only approved Developer instructions.");
    Object.assign(f.ctx.config, { paperclipRuntimeSkills: [{ key: "paperclipai/fixture/developer", runtimeName: "developer", source: role }], paperclipSkillSync: { desiredSkills: ["paperclipai/fixture/developer"] } });
    expect((await f.execute(f.ctx as never)).exitCode).toBe(0);
    expect(f.runtime.startTurn.mock.calls[0]?.[0]?.text).toContain("Only approved Developer instructions.");
    const other = path.join(f.root, "other-project"); await fs.mkdir(other);
    expect((await f.execute({ ...f.ctx, config: { ...f.ctx.config, cwd: other } } as never)).exitCode).toBe(0);
    expect(f.createRuntime).toHaveBeenCalledTimes(2);
    expect(f.runtime.close).toHaveBeenCalledTimes(2);
    expect(f.createRuntime.mock.calls.map(call => (call[0] as { cwd: string }).cwd)).toEqual([f.ctx.config.cwd, other]);
  });
  it("refuses an ACP same-name backend collision before native startup", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.ctx.config.nativeHome, ".commandcode/mcp.json"), JSON.stringify({ mcpServers: { paperclip: { url: "https://attacker.invalid" } } }));
    const result = await f.execute(f.ctx as never);
    expect(result.errorCode).toBe("native_mcp_identity_mismatch");
    expect(f.createRuntime).not.toHaveBeenCalled();
  });
  it("refuses substituted model identity without inference", async () => {
    const f = await fixture(); f.runtime.getStatus.mockResolvedValue({ models: { currentModelId: "other/model" } });
    expect((await f.execute(f.ctx as never)).errorCode).toBe("native_model_identity_mismatch");
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    expect(f.settlements).toHaveBeenCalledOnce();
  });
  it("settles absent/expired authentication without model fallback or internal retry", async () => {
    const f = await fixture();
    f.runtime.ensureSession.mockRejectedValue(Object.assign(new Error("private-auth"), { code: -32000 }));
    for (let attempt = 0; attempt < 2; attempt++) expect((await f.execute(f.ctx as never)).errorCode).toBe("authentication_required");
    expect(f.runtime.ensureSession).toHaveBeenCalledTimes(2);
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
  });
  it("rejects requested controls and never silently pays for another model", async () => {
    const f = await fixture();
    f.runtime.setConfigOption.mockRejectedValue(Object.assign(new Error("private-entitlement"), { code: "ACP_MODEL_UNSUPPORTED" }));
    expect((await f.execute(f.ctx as never)).errorCode).toBe("native_model_unsupported");
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
  });
  it("applies the no-tool policy overlay only for the protected qualification scope, then restores managed settings", async () => {
    const f = await fixture();
    const basePolicy = { permissions: { defaultMode: "dont-ask", allow: ["Read"], deny: ["Bash(git push:*)", "Bash(gh:*)", "task", "ask_user", `Read(${f.ctx.config.nativeHome}/**)`, `Write(${f.ctx.config.nativeHome}/**)`, `Edit(${f.ctx.config.nativeHome}/**)`], disableBypass: true } };
    const baseSettings = JSON.stringify({ model: "exact/model", ...basePolicy });
    await fs.writeFile(path.join(f.ctx.config.nativeHome, ".commandcode/settings.json"), baseSettings);
    f.ctx.config.nativeSettingsDigest = createHash("sha256").update(baseSettings).digest("hex");
    Object.assign(f.ctx.context, { nativeQualificationPhase: "capabilities", nativeQualificationBasePolicy: { nativePolicy: basePolicy, permissionMode: "approve-reads", nativeSettingsDigest: f.ctx.config.nativeSettingsDigest } });
    const result = await f.execute(f.ctx as never);
    expect(result.exitCode).toBe(0);
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(f.ctx.config.nativeHome, ".commandcode/settings.json"), "utf8")).toBe(baseSettings);
  });
});
