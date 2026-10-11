import { createHash } from "node:crypto";
import path from "node:path";

export type NativeRuntime = "cline" | "command-code" | "claude";
export interface NativeBindingIdentity {
  companyId: string; agentId: string; projectId: string; cwd: string;
  adapterType: string; model: string; provider: string; accountRef: string;
  runtimePin: string; policyDigest: string; mcpDigest: string;
  instructionsDigest: string; credentialVersionRef: string;
}
export interface NativeModelIdentity {
  model: string; source: "acp_session_status" | "native_response";
}
/** A controller-generated closed code, distinguishable from arbitrary native text. */
export class NativeProviderError extends Error {
  constructor(readonly code: string) { super(code); this.name = "NativeProviderError"; }
}
const identityKeys: Array<keyof NativeBindingIdentity> = [
  "companyId", "agentId", "projectId", "cwd", "adapterType", "model", "provider",
  "accountRef", "runtimePin", "policyDigest", "mcpDigest", "instructionsDigest", "credentialVersionRef",
];
export function nativeBindingFingerprint(binding: NativeBindingIdentity): string {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)
      || Object.keys(binding).length !== identityKeys.length) throw new Error("native_binding_invalid");
  const canonical: Record<string, string> = {};
  for (const key of [...identityKeys].sort()) {
    const value = binding[key];
    if (typeof value !== "string" || !value.trim() || value.trim() !== value
        || value.length > 4096 || /[\0\r\n]/.test(value)
        || (key.endsWith("Digest") && !/^[a-f0-9]{64}$/.test(value))) throw new Error("native_binding_invalid");
    canonical[key] = value;
  }
  if (!binding.cwd.startsWith("/") || binding.cwd.includes("\\")
      || path.posix.normalize(binding.cwd) !== binding.cwd
      || (binding.cwd !== "/" && binding.cwd.endsWith("/"))) throw new Error("native_binding_invalid");
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
export function requireNativeModelIdentity(actual: unknown, expected: string, source: NativeModelIdentity["source"]): NativeModelIdentity {
  if (typeof actual !== "string" || !actual.trim()) throw new NativeProviderError("native_model_identity_missing");
  if (!expected.trim() || actual !== expected) throw new NativeProviderError("native_model_identity_mismatch");
  return { model: actual, source };
}
export function quoteNativeExecutable(executable: string): string {
  if (typeof executable !== "string" || !executable.startsWith("/") || /[\0\r\n]/.test(executable)) throw new Error("native_command_invalid");
  return "'" + executable.replaceAll("'", "'\"'\"'") + "'";
}
/** ACPX's model cache can contain a requested-model fallback. configOptions
 * currentValue is retained from the backend response, not that fallback. */
export function requireNativeStatusModel(status: { details?: Record<string, unknown> } | null | undefined, expected: string): NativeModelIdentity {
  const options = status?.details?.configOptions;
  const candidates = Array.isArray(options) ? options.filter(value => value && typeof value === "object" && value.type === "select" && (value.id === "model" || value.category === "model")) : [];
  if (candidates.length !== 1) throw new NativeProviderError("native_model_identity_missing");
  return requireNativeModelIdentity(candidates[0].currentValue, expected, "acp_session_status");
}
/** Closed structured protocol codes only; provider prose is never authority. */
export function nativeStructuredFailure(value: unknown): string | null {
  let cause = value;
  for (let depth = 0; depth < 4 && cause && typeof cause === "object"; depth++) {
    const item = cause as { code?: unknown; detailCode?: unknown; cause?: unknown };
    const codes = [item.code, item.detailCode];
    if (codes.some(code => code === -32000 || code === "-32000" || code === "AUTH_REQUIRED" || code === "AUTHENTICATION_REQUIRED")) return "authentication_required";
    if (codes.some(code => code === "QUOTA_EXCEEDED" || code === "QUOTA_UNAVAILABLE")) return "quota_unavailable";
    if (codes.some(code => code === "ENTITLEMENT_REQUIRED" || code === "ENTITLEMENT_UNAVAILABLE")) return "entitlement_unavailable";
    if (codes.includes("ACP_MODEL_UNSUPPORTED")) return "native_model_unsupported";
    cause = item.cause;
  }
  return null;
}
