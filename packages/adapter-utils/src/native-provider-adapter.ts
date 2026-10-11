import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "./types.js";
import type { AcpxEngineExecutorOptions } from "./acpx-engine/execute.js";
import { NativeProviderError, quoteNativeExecutable } from "./native-provider-contract.js";

export type NativeAcpExecutorOptions = Omit<AcpxEngineExecutorOptions, "adapterType" | "moduleDir" | "packageRootDir" | "requireModelIdentity" | "customSkillsMode">;
export const NATIVE_FAILURE_CATEGORIES = ["authentication_required", "quota_unavailable", "entitlement_unavailable", "native_model_unsupported", "native_model_identity_missing", "native_model_identity_mismatch", "native_permission_unsupported", "native_mcp_identity_mismatch", "native_transport_failed", "native_timeout", "native_failed"] as const;
export function nativeText(value: unknown, category = "native_config_invalid"): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error(category);
  return value;
}
export function nativeAbsolutePath(value: unknown): string {
  const result = nativeText(value, "native_command_invalid");
  if (!result.startsWith("/") || result.includes("\\") || path.posix.normalize(result) !== result || result === "/" || result.endsWith("/")) throw new Error("native_command_invalid");
  return result;
}
export function buildNativeAcpConfig(config: Record<string, unknown>, suffix: " --acp" | " acp"): Record<string, unknown> {
  for (const key of ["agentCommand", "acpAgentCommand", "engine", "args", "extraArgs", "autoApprove", "dangerouslySkipPermissions", "dangerouslyBypassSandbox", "effort", "thinkingEffort", "fastMode", "acpPermissionMode", "acpMode", "acpStateDir", "acpWarmHandleIdleMs"]) {
    if (config[key] !== undefined) throw new Error("native_control_unsupported");
  }
  const command = nativeAbsolutePath(config.command);
  const model = nativeText(config.model);
  const permissionMode = config.permissionMode;
  if (!["approve-all", "approve-reads", "deny-all"].includes(String(permissionMode))) throw new Error("native_permission_unsupported");
  const timeoutSec = config.timeoutSec ?? 600;
  if (typeof timeoutSec !== "number" || !Number.isSafeInteger(timeoutSec) || timeoutSec <= 0) throw new Error("native_timeout_invalid");
  const env: Record<string, string> = {};
  if (config.env !== undefined && (!config.env || typeof config.env !== "object" || Array.isArray(config.env))) throw new Error("native_env_invalid");
  for (const [key, value] of Object.entries(config.env as Record<string, unknown> ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /^(PAPERCLIP_|GITHUB_|GIT_|GH_TOKEN$|NODE_OPTIONS$|LD_|DYLD_|BASH_ENV$|ENV$|USERPROFILE$)/.test(key)
        || typeof value !== "string" || /[\0\r\n]/.test(value)) throw new Error("native_env_invalid");
    env[key] = value;
  }
  if (config.nativeHome !== undefined) {
    const home = nativeAbsolutePath(config.nativeHome);
    if (env.HOME !== undefined && env.HOME !== home) throw new Error("native_startup_env_conflict");
    env.HOME = home;
    if (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== home + "/.config") throw new Error("native_startup_env_conflict");
    env.XDG_CONFIG_HOME = home + "/.config";
  } else if (env.HOME || env.XDG_CONFIG_HOME) throw new Error("native_startup_env_conflict");
  return { ...config, agent: "custom", agentCommand: quoteNativeExecutable(command) + suffix, model,
    permissionMode, nonInteractivePermissions: "fail", warmHandleIdleMs: 0, timeoutSec, env };
}

/** No process or provider call: verify only owner-supplied local artifact provenance. */
export async function assertNativeLocalLaunch(ctx: AdapterExecutionContext): Promise<void> {
  if (process.platform !== "linux" || ctx.executionTarget?.kind === "remote" || ctx.executionTransport?.remoteExecution) throw new Error("native_transport_failed");
  const command = nativeAbsolutePath(ctx.config.command);
  const home = nativeAbsolutePath(ctx.config.nativeHome);
  const cwd = nativeAbsolutePath(ctx.config.cwd);
  if (await fs.realpath(home) !== home || await fs.realpath(cwd) !== cwd || home === cwd || home.startsWith(cwd + "/") || cwd.startsWith(home + "/")) throw new Error("native_config_invalid");
  const executable = await fs.realpath(command);
  await fs.access(executable, fs.constants.X_OK);
  const digest = ctx.config.nativeExecutableDigest;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("native_runtime_pin_missing");
  const content = await fs.readFile(executable);
  if (createHash("sha256").update(content).digest("hex") !== digest) throw new Error("native_runtime_pin_mismatch");
}

function publicCategory(result: AdapterExecutionResult): string {
  if (result.timedOut || result.errorCode === "acpx_timeout" || result.errorCode === "acpx_handshake_timeout") return "native_timeout";
  if (NATIVE_FAILURE_CATEGORIES.includes(result.errorCode as never)) return result.errorCode!;
  if (result.errorMeta?.acpCode === "ACP_BACKEND_UNSUPPORTED_CONTROL") return "native_permission_unsupported";
  return "native_failed";
}

/** Keep the shared coordinator; close/redact only this new plugin's public boundary. */
export async function executeNativeAcp(ctx: AdapterExecutionContext, execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>): Promise<AdapterExecutionResult> {
  let loggedBytes = 0;
  let result: AdapterExecutionResult;
  try { result = await execute({ ...ctx, onLog: async (stream, text) => {
    if (stream === "stderr") text = "[paperclip] Native runtime diagnostic withheld.\n";
    else {
      try {
        const event = JSON.parse(text) as Record<string, unknown>;
        if (event.type === "acpx.error") text = JSON.stringify({ type: "acpx.error", message: "native_failed" }) + "\n";
      } catch { /* normal governed stdout */ }
    }
    const remaining = 65_536 - loggedBytes;
    if (remaining <= 0) return;
    // write() omits an incomplete trailing code point instead of expanding it
    // to a three-byte replacement character.
    const bounded = new StringDecoder("utf8").write(Buffer.from(text).subarray(0, remaining));
    loggedBytes += Buffer.byteLength(bounded);
    await ctx.onLog(stream, bounded);
  } }); } catch (error) {
    result = { exitCode: 1, signal: null, timedOut: false, errorCode: error instanceof NativeProviderError ? error.code : "native_failed" };
  }
  if (result.exitCode === 0) return result;
  const category = publicCategory(result);
  return { ...result, errorCode: category, errorMessage: category, errorMeta: { category }, summary: category,
    resultJson: { nativeFailureCategory: category, stopReason: category } };
}

export async function inspectNativeEnvironment(ctx: AdapterEnvironmentTestContext, normalize: (config: Record<string, unknown>) => Record<string, unknown>): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentTestResult["checks"] = [];
  try {
    const config = normalize(ctx.config);
    const exists = await fs.access(String(config.command), fs.constants.X_OK).then(() => true).catch(() => false);
    checks.push({ code: exists ? "native_command_present" : "native_command_missing", level: exists ? "info" : "error", message: exists ? "Configured artifact is present; provenance requires qualification." : "Configured native executable is absent." });
  } catch { checks.push({ code: "native_config_invalid", level: "error", message: "Native configuration is invalid." }); }
  checks.push({ code: "native_protocol_unverified", level: "warn", message: "ACP controls are not verified by file inspection." });
  checks.push({ code: "native_auth_unverified", level: "warn", message: "Authentication and live availability require separately authorized qualification." });
  return { adapterType: ctx.adapterType, status: checks.some(check => check.level === "error") ? "fail" : "warn", checks, testedAt: new Date().toISOString() };
}
