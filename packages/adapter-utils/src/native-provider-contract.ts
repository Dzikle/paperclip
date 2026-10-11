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
  if (typeof actual !== "string" || !actual.trim()) throw new Error("native_model_identity_missing");
  if (!expected.trim() || actual !== expected) throw new Error("native_model_identity_mismatch");
  return { model: actual, source };
}
export function quoteNativeExecutable(executable: string): string {
  if (typeof executable !== "string" || !executable.startsWith("/") || /[\0\r\n]/.test(executable)) throw new Error("native_command_invalid");
  return "'" + executable.replaceAll("'", "'\"'\"'") + "'";
}
