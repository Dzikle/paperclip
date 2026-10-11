import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { buildNativeAcpConfig, executeNativeAcp, nativeAbsolutePath, nativeText, type NativeAcpExecutorOptions } from "@paperclipai/adapter-utils/native-provider-adapter";
import { NativeProviderError } from "@paperclipai/adapter-utils/native-provider-contract";

export function buildCommandCodeAcpConfig(config: Record<string, unknown>, controllerEnv: Record<string, unknown> = {}): Record<string, unknown> {
  const next = buildNativeAcpConfig(config, " acp", controllerEnv);
  const env = next.env as Record<string, string>;
  for (const [key, value] of Object.entries({ COMMANDCODE_SKIP_UPDATES: "1", DO_NOT_TRACK: "1" })) {
    if (env[key] !== undefined && env[key] !== value) throw new Error("native_startup_env_conflict");
    env[key] = value;
  }
  return next;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + stable(item)).join(",") + "}";
  return JSON.stringify(value);
}
async function readManagedJson(file: string): Promise<{ value: unknown; digest: string }> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) throw new NativeProviderError("native_permission_unsupported");
  const bytes = await fs.readFile(file);
  return { value: JSON.parse(bytes.toString("utf8")), digest: createHash("sha256").update(bytes).digest("hex") };
}
/** Refuse unknown settings rather than trusting native backend-over-client MCP precedence.
 * No credentials are read or changed. Actual pinned-CLI enforcement is a separate
 * capability qualification gate; this is not a host isolation boundary and
 * passing this inspection never enables the blocked executor. */
export async function assertCommandCodePolicy(config: Record<string, unknown>): Promise<void> {
  const home = nativeAbsolutePath(config.nativeHome), cwd = nativeAbsolutePath(config.cwd);
  const directory = path.join(home, ".commandcode");
  if (await fs.realpath(directory) !== directory) throw new NativeProviderError("native_mcp_identity_mismatch");
  for (const entry of await fs.readdir(directory)) {
    if (!["auth.json", "settings.json", "config.json", "telemetry-install-id"].includes(entry)) throw new NativeProviderError("native_mcp_identity_mismatch");
  }
  for (const name of [".commandcode", ".mcp.json"]) {
    const exists = await fs.lstat(path.join(cwd, name)).then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; });
    if (exists) throw new NativeProviderError("native_mcp_identity_mismatch");
  }
  const policy = config.nativePolicy as { permissions?: Record<string, unknown> } | undefined;
  const permissions = policy?.permissions;
  if (!policy || Object.keys(policy).join() !== "permissions" || !permissions
      || Object.keys(permissions).sort().join() !== "allow,defaultMode,deny,disableBypass"
      || permissions.defaultMode !== "dont-ask" || permissions.disableBypass !== true
      || !Array.isArray(permissions.allow) || !Array.isArray(permissions.deny)
      || [...permissions.allow, ...permissions.deny].some(rule => typeof rule !== "string" || rule.length > 1024 || /[\0\r\n]/.test(rule))
      || permissions.allow.length > 64 || permissions.deny.length > 64) throw new NativeProviderError("native_permission_unsupported");
  if (config.permissionMode === "deny-all") {
    if (permissions.allow.length || stable(permissions.deny) !== '["*"]') throw new NativeProviderError("native_permission_unsupported");
  } else {
    // A single leading slash is cwd-relative in 1.79.2. home already begins
    // with /, so prefix another / for the native filesystem-root anchor.
    // Control-flow tools bypass native permission rules; listing their real
    // names is secondary policy documentation, not an enforcement claim.
    const requiredDenies = ["Bash(git push:*)", "Bash(gh:*)", "agent", "ask_user_question", "run_command", `Read(/${home}/**)`, `Write(/${home}/**)`, `Edit(/${home}/**)`];
    const deny = permissions.deny as string[];
    if (!permissions.allow.length || requiredDenies.some(rule => !deny.includes(rule))) throw new NativeProviderError("native_permission_unsupported");
  }
  const settings = await readManagedJson(path.join(directory, "settings.json"));
  if (settings.digest !== config.nativeSettingsDigest || stable(settings.value) !== stable({ model: nativeText(config.model), ...policy })) throw new NativeProviderError("native_permission_unsupported");
  // Native provider selection must be explicit; forbid hooks, plugins, BYOK
  // endpoints and feature-model overrides from this low-precedence source.
  const preferences = await readManagedJson(path.join(directory, "config.json"));
  const expected = { model: nativeText(config.model), provider: nativeText(config.provider), tasteLearning: false, ideContextEnabled: false, autoInstallExtension: false };
  if (stable(preferences.value) !== stable(expected)) throw new NativeProviderError("native_permission_unsupported");
}
export function createCommandCodeAcpExecutor(options: NativeAcpExecutorOptions = {}) {
  void options;
  // Required pinned native guard controls are not proven. No phase, owner
  // boolean, cached receipt or injected runtime bypasses this source gate.
  return async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    const result = await executeNativeAcp(ctx, async () => {
      throw new NativeProviderError("native_permission_unsupported");
    });
    return { ...result, clearSession: true };
  };
}
