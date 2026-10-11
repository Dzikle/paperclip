import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClineAcpExecutor } from "./acp.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cline-plugin-fixture-")));
  roots.push(root);
  const cwd = path.join(root, "project"), home = path.join(root, "home"), command = path.join(root, "native");
  await fs.mkdir(cwd); await fs.mkdir(home);
  const artifact = "offline fixture only; never executed";
  await fs.writeFile(command, artifact, { mode: 0o700 });
  const runtime = {
    ensureSession: vi.fn(async (_input: unknown) => ({ backendSessionId: "backend", agentSessionId: "native", runtimeSessionName: "session" })),
    setConfigOption: vi.fn(async () => {}), getStatus: vi.fn(async () => ({ models: { currentModelId: "exact/model" } })),
    startTurn: vi.fn(() => ({ events: (async function* () { yield { type: "done", stopReason: "end_turn" }; })(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }), cancel: async () => {} })),
    close: vi.fn(async () => {}),
  };
  const createRuntime = vi.fn((_options: unknown) => runtime as never), settlements = vi.fn();
  const execute = createClineAcpExecutor({ createRuntime, warmHandles: new Map(), onSettlementDisposition: settlements });
  const ctx = { runId: "offline-cline", agent: { id: "agent", companyId: "company" }, runtime: {}, context: {}, authToken: "run-scoped-token",
    config: { command, nativeHome: home, nativeExecutableDigest: createHash("sha256").update(artifact).digest("hex"), cwd, stateDir: path.join(root, "state"),
      provider: "owner-provider", model: "exact/model", permissionMode: "deny-all", timeoutSec: 2, paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: [] } },
    onLog: vi.fn(async () => {}), onMeta: vi.fn(async () => {}) };
  return { execute, ctx, runtime, createRuntime, settlements, command, home };
}
describe.runIf(process.platform === "linux")("Cline injected runtime integration", () => {
  it("preserves exact controller-governed launch env without allowing config impersonation", async () => {
    const f = await fixture();
    const governed = { PAPERCLIP_RUN_SCRATCH_DIR: "/tmp/proof", PAPERCLIP_GIT_AUTH_MODE: "managed", GIT_TERMINAL_PROMPT: "0" };
    Object.assign(f.ctx.config, { env: governed });
    expect((await f.execute(f.ctx as never)).exitCode).not.toBe(0);
    Object.assign(f.ctx.context, { nativeControllerEnv: governed });
    expect((await f.execute(f.ctx as never)).exitCode).toBe(0);
    const options = f.runtime.ensureSession.mock.calls[0]?.[0] as { sessionOptions: { env: Record<string,string> } };
    expect(options.sessionOptions.env).toMatchObject(governed);
  });
  it("launches in the isolated home and never inherits owner authority", async () => {
    const f = await fixture();
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ambient-owner-secret";
    try {
      expect((await f.execute(f.ctx as never)).exitCode).toBe(0);
      expect(f.createRuntime.mock.calls[0]?.[0]).toMatchObject({ inheritProcessEnv: false, permissionMode: "deny-all", nonInteractivePermissions: "fail" });
      const options = f.runtime.ensureSession.mock.calls[0]?.[0] as { sessionOptions: { env: Record<string, string> } };
      expect(options.sessionOptions.env.HOME).toBe(f.home);
      expect(options.sessionOptions.env.GITHUB_TOKEN).toBeUndefined();
      expect(options.sessionOptions.env.PAPERCLIP_API_KEY).toBe("run-scoped-token");
      expect(f.runtime.startTurn).toHaveBeenCalledOnce();
      expect(f.settlements).toHaveBeenCalledOnce();
    } finally { if (previous === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous; }
  });
  it.each(["initial", "expired"])("settles %s typed authentication failure with no internal retry or login", async phase => {
    const f = await fixture();
    if (phase === "expired") {
      const successful = await f.execute(f.ctx as never);
      expect(successful.exitCode).toBe(0);
      Object.assign(f.ctx.runtime, { sessionParams: successful.sessionParams });
    }
    f.runtime.ensureSession.mockRejectedValue(Object.assign(new Error("private-auth-secret"), { code: -32000 }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.execute(f.ctx as never);
      expect(result.errorCode).toBe("authentication_required");
      expect(JSON.stringify(result)).not.toContain("private-auth-secret");
    }
    expect(f.runtime.ensureSession).toHaveBeenCalledTimes(phase === "expired" ? 3 : 2);
    expect(f.runtime.startTurn).toHaveBeenCalledTimes(phase === "expired" ? 1 : 0);
    expect(f.runtime.close).toHaveBeenCalledTimes(phase === "expired" ? 3 : 2);
    expect(f.settlements).toHaveBeenCalledTimes(phase === "expired" ? 3 : 2);
  });
  it("does not infer authentication from raw error wording", async () => {
    const f = await fixture();
    f.runtime.ensureSession.mockRejectedValue(new Error("login credential quota expired"));
    expect((await f.execute(f.ctx as never)).errorCode).toBe("native_failed");
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
  });
  it("fails before native startup if the pinned artifact was replaced", async () => {
    const f = await fixture();
    await fs.writeFile(f.command, "changed executable");
    expect((await f.execute(f.ctx as never)).exitCode).toBe(1);
    expect(f.createRuntime).not.toHaveBeenCalled();
  });
  it("denies an unsupported approval policy without starting a prompt", async () => {
    const f = await fixture();
    f.runtime.setConfigOption.mockRejectedValue(Object.assign(new Error("private-control-error"), { code: "ACP_BACKEND_UNSUPPORTED_CONTROL" }));
    expect((await f.execute(f.ctx as never)).errorCode).toBe("native_permission_unsupported");
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledOnce();
  });
});
