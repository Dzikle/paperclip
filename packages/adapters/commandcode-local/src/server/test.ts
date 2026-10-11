import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { inspectNativeEnvironment } from "@paperclipai/adapter-utils/native-provider-adapter";
import { buildCommandCodeAcpConfig } from "./acp.js";
export const testCommandCodeEnvironment = (ctx: AdapterEnvironmentTestContext) => inspectNativeEnvironment(ctx, buildCommandCodeAcpConfig);
