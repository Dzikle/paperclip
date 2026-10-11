import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { inspectNativeEnvironment } from "@paperclipai/adapter-utils/native-provider-adapter";
import { buildClineAcpConfig } from "./acp.js";
export const testClineEnvironment = (ctx: AdapterEnvironmentTestContext) => inspectNativeEnvironment(ctx, buildClineAcpConfig);
