import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { sessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";
import { createClineAcpExecutor } from "./server/acp.js";
import { testClineEnvironment } from "./server/test.js";
export function createServerAdapter(): ServerAdapterModule {
  return { type: "cline_local", execute: createClineAcpExecutor(), testEnvironment: testClineEnvironment, sessionCodec,
    acp: { agentId: "custom", skillsMode: "unsupported", prerequisites: { nodeRange: ">=24.11.0", packages: [] } },
    supportsLocalAgentJwt: true, supportsInstructionsBundle: true, requiresMaterializedRuntimeSkills: true, runtimeToolDelivery: "native_mcp",
    getConfigSchema: () => ({ fields: [
      ...["command", "model", "provider", "nativeHome", "nativeExecutableDigest"].map(key => ({ key, label: key, type: "text" as const, required: true })),
      { key: "permissionMode", label: "Explicit ACP permissions", type: "select", required: true, options: ["approve-all", "approve-reads", "deny-all"].map(value => ({ value, label: value })) },
      { key: "timeoutSec", label: "Finite timeout (seconds)", type: "number", default: 600 },
    ] }),
  };
}
