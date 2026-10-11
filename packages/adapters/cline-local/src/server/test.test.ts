import { describe, expect, it } from "vitest";
import { testClineEnvironment } from "./test.js";
describe("Cline environment inspection", () => {
  it("reports a missing executable without a process, login or inference", async () => {
    const result = await testClineEnvironment({ companyId: "fixture", adapterType: "cline_local", config: {
      command: "/absent/native/cline", model: "exact/model", provider: "fixture", permissionMode: "deny-all", nativeHome: "/absent/native/home",
    } });
    expect(result.status).toBe("fail");
    expect(result.checks.some(check => check.code === "native_command_missing")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("codingQualified");
    expect(result.checks.some(check => check.code === "native_auth_unverified")).toBe(true);
  });
  it("never publishes invalid configuration secrets", async () => {
    const result = await testClineEnvironment({ companyId: "fixture", adapterType: "cline_local", config: { command: "secret-value" } });
    expect(result.status).toBe("fail");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});
