import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { inspectNativeEnvironment } from "@paperclipai/adapter-utils/native-provider-adapter";
import { buildCommandCodeAcpConfig } from "./acp.js";
export async function testCommandCodeEnvironment(ctx: AdapterEnvironmentTestContext) {
  const result = await inspectNativeEnvironment(ctx, buildCommandCodeAcpConfig);
  result.checks.push({ code: "native_permission_unsupported", level: "error",
    message: "Required native guard controls are not verified; execution is disabled." });
  return { ...result, status: "fail" as const };
}
