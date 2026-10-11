import { expect, it } from "vitest";
import { testCommandCodeEnvironment } from "./test.js";
import { createServerAdapter } from "../index.js";
it("keeps installed-file status separate from protocol/auth/coding qualification", async () => {
  const result = await testCommandCodeEnvironment({ adapterType: "commandcode_local", config: { command: "/absent/native", model: "exact/model", permissionMode: "deny-all" } } as never);
  expect(result.status).toBe("fail");
  expect(result.checks.map(check => check.code)).toContain("native_auth_unverified");
  expect(JSON.stringify(result)).not.toContain("codingQualified");
  expect(createServerAdapter()).toMatchObject({ type: "commandcode_local", runtimeToolDelivery: "native_mcp", requiresMaterializedRuntimeSkills: true });
  expect(createServerAdapter().loginCapability).toBeUndefined();
});
