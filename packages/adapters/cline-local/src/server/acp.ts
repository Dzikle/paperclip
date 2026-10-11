import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { assertNativeLocalLaunch, buildNativeAcpConfig, executeNativeAcp, nativeText, type NativeAcpExecutorOptions } from "@paperclipai/adapter-utils/native-provider-adapter";
export function buildClineAcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  const next = buildNativeAcpConfig(config, " --acp");
  const provider = nativeText(config.provider);
  const env = next.env as Record<string, string>;
  for (const [key, value] of Object.entries({ CLINE_PROVIDER: provider, CLINE_MODEL: next.model as string })) {
    if (env[key] !== undefined && env[key] !== value) throw new Error("native_startup_env_conflict");
    env[key] = value;
  }
  return next;
}
export function createClineAcpExecutor(options: NativeAcpExecutorOptions = {}) {
  let execute: ((ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>) | undefined;
  return async (ctx: AdapterExecutionContext) => executeNativeAcp(ctx, async protectedCtx => {
    const config = buildClineAcpConfig(ctx.config);
    await assertNativeLocalLaunch({ ...protectedCtx, config });
    if (!execute) {
      const { createAcpxEngineExecutor } = await import("@paperclipai/adapter-utils/acpx-engine/execute");
      const moduleDir = path.dirname(fileURLToPath(import.meta.url));
      execute = createAcpxEngineExecutor({ ...options, adapterType: "cline_local", moduleDir, packageRootDir: path.resolve(moduleDir, "../.."), requireModelIdentity: true, customSkillsMode: "prompt" });
    }
    return execute({ ...protectedCtx, config });
  });
}
