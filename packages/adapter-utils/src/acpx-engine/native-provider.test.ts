import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../types.js";
import { createAcpxEngineExecutor } from "./execute.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(models: Array<string | undefined> = ["exact/model", "exact/model", "exact/model"]) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-native-contract-"));
  roots.push(cwd);
  const runtime = {
    ensureSession: vi.fn(async (_input: { resumeSessionId?: string }) => ({ backendSessionId: "backend", agentSessionId: "native", runtimeSessionName: "session" })),
    setConfigOption: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ models: { currentModelId: models.shift(), availableModelIds: ["exact/model"] } })),
    startTurn: vi.fn((_input: { text: string }) => ({ events: (async function* () { yield { type: "done", stopReason: "end_turn" }; })(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }), cancel: vi.fn(async () => {}) })),
    close: vi.fn(async () => {}),
  };
  const settlements = vi.fn();
  const execute = createAcpxEngineExecutor({ adapterType: "cline_local", requireModelIdentity: true, customSkillsMode: "prompt", createRuntime: () => runtime as never, warmHandles: new Map(), onSettlementDisposition: settlements });
  const context = {
    runId: "native-offline-run", agent: { id: "native-offline-agent", companyId: "native-offline-company" }, runtime: {},
    config: { cwd, stateDir: path.join(cwd, "state"), agent: "custom", agentCommand: "'/fixture/native' --acp", model: "exact/model", permissionMode: "deny-all", timeoutSec: 2, paperclipSkillSync: { desiredSkills: [] }, paperclipRuntimeSkills: [] },
    context: {}, onLog: vi.fn(async () => {}), onMeta: vi.fn(async () => {}),
  } as unknown as AdapterExecutionContext;
  return { execute, context, runtime, settlements, cwd };
}
describe("opt-in native ACP evidence", () => {
  it.each([undefined, "substituted/model"])("starts no prompt for actual model %j", async model => {
    const f = await fixture([model]);
    const result = await f.execute(f.context);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain(model ? "native_model_identity_mismatch" : "native_model_identity_missing");
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledOnce();
    expect(f.settlements).toHaveBeenCalledOnce();
  });
  it("retains actual native evidence after a completed turn", async () => {
    const f = await fixture();
    const result = await f.execute(f.context);
    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.nativeModelIdentity).toEqual({ model: "exact/model", source: "acp_session_status" });
    expect(f.runtime.startTurn).toHaveBeenCalledOnce();
  });
  it("marks post-turn drift failed without replaying the turn", async () => {
    const f = await fixture(["exact/model", "exact/model", "substituted/model"]);
    const result = await f.execute(f.context);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("native_model_identity_mismatch");
    expect(f.runtime.startTurn).toHaveBeenCalledOnce();
    expect(f.runtime.close).toHaveBeenCalledOnce();
  });
  it("rechecks resumed session model before a prompt", async () => {
    const f = await fixture();
    const first = await f.execute(f.context);
    expect(first.exitCode).toBe(0);
    f.runtime.getStatus.mockResolvedValue({ models: { currentModelId: "substituted/model", availableModelIds: ["exact/model"] } });
    const result = await f.execute({ ...f.context, runtime: { ...f.context.runtime, sessionParams: first.sessionParams ?? null } });
    expect(result.exitCode).toBe(1);
    expect(f.runtime.ensureSession.mock.calls[1]?.[0]?.resumeSessionId).toBe("backend");
    expect(f.runtime.startTurn).toHaveBeenCalledOnce();
  });
  it("capability qualification settles without inference", async () => {
    const f = await fixture();
    f.context.context.nativeQualificationPhase = "capabilities";
    const result = await f.execute(f.context);
    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.nativeModelIdentity).toEqual({ model: "exact/model", source: "acp_session_status" });
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledOnce();
    expect(f.settlements).toHaveBeenCalledOnce();
  });
  it("config alone cannot request capability qualification", async () => {
    const f = await fixture();
    f.context.config.nativeQualificationPhase = "capabilities";
    const result = await f.execute(f.context);
    expect(result.exitCode).toBe(0);
    expect(f.runtime.startTurn).toHaveBeenCalledOnce();
  });
  it("starts no prompt when native status inspection is unsupported", async () => {
    const f = await fixture();
    Object.assign(f.runtime, { getStatus: undefined });
    const result = await f.execute(f.context);
    expect(result.errorMessage).toContain("native_model_identity_missing");
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledOnce();
  });
  it("starts no prompt when requested controls are rejected", async () => {
    const f = await fixture();
    f.runtime.setConfigOption.mockRejectedValue(new Error("unsupported model control"));
    const result = await f.execute(f.context);
    expect(result.exitCode).toBe(1);
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledOnce();
  });
  it("bounds an unresponsive status inspector and settles once", async () => {
    const f = await fixture();
    let started!: () => void;
    const inspected = new Promise<void>(resolve => { started = resolve; });
    f.runtime.getStatus.mockImplementation(() => { started(); return new Promise(() => {}); });
    vi.useFakeTimers();
    try {
      const pending = f.execute(f.context);
      await inspected;
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("native_timeout");
      expect(f.runtime.startTurn).not.toHaveBeenCalled();
      expect(f.runtime.close).toHaveBeenCalledOnce();
      expect(f.settlements).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("fails closed when selected role instructions are unavailable", async () => {
    const f = await fixture();
    f.context.config.paperclipSkillSync = { desiredSkills: ["paperclipai/fixture/developer"] };
    await expect(f.execute(f.context)).rejects.toThrow("native_skill_unavailable");
    expect(f.runtime.ensureSession).not.toHaveBeenCalled();
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
  });
  it("injects only selected materialized skills and changes resume identity with content", async () => {
    const f = await fixture(Array(6).fill("exact/model"));
    const source = path.join(f.cwd, "role");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "SKILL.md"), "# Developer\nSelected role instructions.");
    f.context.config.paperclipRuntimeSkills = [{ key: "paperclipai/fixture/developer", runtimeName: "developer", source }];
    f.context.config.paperclipSkillSync = { desiredSkills: ["paperclipai/fixture/developer"] };
    const first = await f.execute(f.context);
    expect(first.exitCode).toBe(0);
    expect(f.runtime.startTurn.mock.calls[0]?.[0]?.text).toContain("Selected role instructions.");
    await fs.writeFile(path.join(source, "SKILL.md"), "# Developer\nChanged role instructions.");
    const second = await f.execute({ ...f.context, runtime: { ...f.context.runtime, sessionParams: first.sessionParams ?? null } });
    expect(second.exitCode).toBe(0);
    expect(second.sessionParams?.configFingerprint).not.toBe(first.sessionParams?.configFingerprint);
  });
  it("refuses instructions larger than 32 KiB before native startup", async () => {
    const f = await fixture();
    const source = path.join(f.cwd, "large-role");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "SKILL.md"), "é".repeat(17_000));
    f.context.config.paperclipRuntimeSkills = [{ key: "paperclipai/fixture/developer", runtimeName: "developer", source }];
    f.context.config.paperclipSkillSync = { desiredSkills: ["paperclipai/fixture/developer"] };
    await expect(f.execute(f.context)).rejects.toThrow("native_skill_limit");
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
  });
});
