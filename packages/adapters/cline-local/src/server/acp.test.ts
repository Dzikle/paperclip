import { describe, expect, it } from "vitest";
import { buildClineAcpConfig } from "./acp.js";
import { createServerAdapter } from "../index.js";
import { createClineAcpExecutor } from "./acp.js";

const config = { command: "/opt/aif/bin/cline", model: "exact/model", provider: "owner-provider", permissionMode: "approve-reads" };
describe("Cline native plugin", () => {
  it("fixes native ACP launch, provider/model and finite permission policy", () => {
    const result = buildClineAcpConfig(config);
    expect(result).toMatchObject({ agent: "custom", agentCommand: "'/opt/aif/bin/cline' --acp", timeoutSec: 600,
      permissionMode: "approve-reads", nonInteractivePermissions: "fail", warmHandleIdleMs: 0,
      env: { CLINE_PROVIDER: "owner-provider", CLINE_MODEL: "exact/model" } });
    expect(result.agentCommand).not.toContain("auto-approve");
  });
  it.each(["agentCommand", "acpAgentCommand", "engine", "extraArgs", "args", "autoApprove", "dangerouslySkipPermissions", "effort", "thinkingEffort", "fastMode"])("rejects caller override %s", key => {
    expect(() => buildClineAcpConfig({ ...config, [key]: "bypass" })).toThrow();
  });
  it.each([0, -1, Infinity, NaN, "600", 1.5])("rejects unbounded/malformed timeout %j", timeoutSec => {
    expect(() => buildClineAcpConfig({ ...config, timeoutSec })).toThrow("native_timeout_invalid");
  });
  it("refuses missing controls and conflicting startup environment", () => {
    expect(() => buildClineAcpConfig({ ...config, permissionMode: undefined })).toThrow("native_permission_unsupported");
    expect(() => buildClineAcpConfig({ ...config, env: { CLINE_MODEL: "other/model" } })).toThrow("native_startup_env_conflict");
    expect(() => buildClineAcpConfig({ ...config, env: { CLINE_PROVIDER: "other/provider" } })).toThrow("native_startup_env_conflict");
    for (const key of ["PAPERCLIP_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "NODE_OPTIONS"]) {
      expect(() => buildClineAcpConfig({ ...config, env: { [key]: "untrusted-authority" } })).toThrow("native_env_invalid");
    }
  });
  it("declares external native capabilities and no interactive login", () => {
    const plugin = createServerAdapter();
    expect(plugin).toMatchObject({ type: "cline_local", acp: { agentId: "custom", skillsMode: "unsupported", prerequisites: { nodeRange: ">=24.11.0", packages: [] } },
      runtimeToolDelivery: "native_mcp", supportsLocalAgentJwt: true, supportsInstructionsBundle: true, requiresMaterializedRuntimeSkills: true });
    expect(plugin.loginCapability).toBeUndefined();
    expect(plugin.sessionCodec).toBeDefined();
  });
  it("fails without a native installation and never enters a login loop", async () => {
    const execute = createClineAcpExecutor();
    const ctx = { runId: "fixture", config: { ...config, command: "/absent/native/cline", nativeHome: "/absent/native/home", cwd: "/absent/native/cwd" },
      agent: { id: "agent", companyId: "company" }, runtime: {}, context: {}, onLog: async () => {} };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toBe("native_permission_unsupported");
    }
  });
});
