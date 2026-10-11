import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { buildNativeAcpConfig, executeNativeAcp, nativeText, type NativeAcpExecutorOptions } from "@paperclipai/adapter-utils/native-provider-adapter";
import { NativeProviderError } from "@paperclipai/adapter-utils/native-provider-contract";
export function buildClineAcpConfig(config: Record<string, unknown>, controllerEnv: Record<string, unknown> = {}): Record<string, unknown> {
  const next = buildNativeAcpConfig(config, " --acp", controllerEnv);
  const provider = nativeText(config.provider);
  const env = next.env as Record<string, string>;
  for (const [key, value] of Object.entries({ CLINE_PROVIDER: provider, CLINE_MODEL: next.model as string })) {
    if (env[key] !== undefined && env[key] !== value) throw new Error("native_startup_env_conflict");
    env[key] = value;
  }
  return next;
}
export function createClineAcpExecutor(options: NativeAcpExecutorOptions = {}) {
  void options;
  // HOME alone does not contain native/project MCP, hooks or rules. No owner
  // grant or probe bypasses this gate. Re-enable only with a reviewed pinned
  // configuration-authority contract, not a caller-supplied boolean.
  return async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => executeNativeAcp(ctx, async () => {
    throw new NativeProviderError("native_permission_unsupported");
  });
}
