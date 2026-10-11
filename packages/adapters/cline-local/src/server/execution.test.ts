import { describe, expect, it, vi } from "vitest";
import { buildClineAcpConfig, createClineAcpExecutor } from "./acp.js";
describe("Cline configuration-authority gate", () => {
  it.each([undefined, "production", "coding", "capabilities", "availability"])("never starts a provider for %s before native containment is implemented", async phase => {
    const createRuntime = vi.fn();
    const execute = createClineAcpExecutor({ createRuntime });
    const result = await execute({ config: { nativeContainmentVerified: true }, context: { nativeQualificationPhase: phase }, onLog: vi.fn(), onMeta: vi.fn() } as never);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "native_permission_unsupported" });
    expect(createRuntime).not.toHaveBeenCalled();
  });
  it("normalizes protected controller env without allowing owner impersonation", () => {
    const governed = { PAPERCLIP_RUN_SCRATCH_DIR: "/tmp/proof", GIT_TERMINAL_PROMPT: "0" };
    const config = { command: "/opt/aif/bin/cline", model: "exact/model", provider: "fixture", permissionMode: "deny-all", env: governed };
    expect(() => buildClineAcpConfig(config)).toThrow("native_env_invalid");
    expect(buildClineAcpConfig(config, governed).env).toMatchObject(governed);
  });
});
