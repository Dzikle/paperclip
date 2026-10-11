import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { nativeBindingFingerprint, type NativeBindingIdentity, type NativeModelIdentity } from "@paperclipai/adapter-utils/native-provider-contract";

export interface NativeAdmission {
  schemaVersion: 1; binding: NativeBindingIdentity; bindingFingerprint: string;
  qualification: { runId: string; issueId: string; candidateTree: string; testsRunId: string; reviewerRunId: string; capabilityRunId: string };
  availability: { runId: string; verifiedAt: string; available: boolean; invalidatedByRunId?: string; category?: string };
}
export interface NativeRunEvidence {
  id: string; agentId: string; companyId: string; status: string;
  projectId: string; issueId: string; phase: "capabilities" | "availability" | "coding" | "tests" | "reviewer";
  finishedAtMs: number; candidateTree?: string; stageApproved?: boolean;
  resultJson: ({ nativeModelIdentity?: NativeModelIdentity; baseBindingFingerprint?: string; effectivePolicyDigest?: string; mcpDigest?: string; nativeCapabilityVerified?: boolean } & Record<string, unknown>) | null;
}
export interface NativeAdmissionInput { currentBinding: NativeBindingIdentity; proposed: NativeAdmission; runs: Record<string, NativeRunEvidence>; actor: "owner" | "agent"; nowMs: number }
export interface NativeDispatchAdmissionInput { currentBinding: NativeBindingIdentity; admission: NativeAdmission | null }
export interface NativeQualificationScope { schemaVersion: 1; bindingFingerprint: string; issueIds: string[]; phase: "capabilities" | "availability" | "coding"; expiresAt: string; maxAttempts: 2 }
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hashPattern = /^[a-f0-9]{64}$/;
function fail(code = "native_admission_invalid"): never { throw new Error(code); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function keys(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  const object = record(value);
  if (required.some(key => !(key in object)) || Object.keys(object).some(key => !required.includes(key) && !optional.includes(key))) fail();
  return object;
}
function dateMs(value: unknown): number {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail("native_availability_stale");
  const timestamp = Date.parse(value);
  // Date.parse normalizes invalid dates such as February 30; do not admit them.
  if (new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)) fail("native_availability_stale");
  return timestamp;
}
function admissionShape(value: unknown): NativeAdmission {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 32_768) fail();
  const object = keys(value, ["schemaVersion", "binding", "bindingFingerprint", "qualification", "availability"]);
  if (object.schemaVersion !== 1) fail();
  const binding = object.binding as NativeBindingIdentity;
  if (!["cline_local", "commandcode_local", "claude_local"].includes(binding?.adapterType) || nativeBindingFingerprint(binding) !== object.bindingFingerprint) fail("native_binding_mismatch");
  const qualification = keys(object.qualification, ["runId", "issueId", "candidateTree", "testsRunId", "reviewerRunId", "capabilityRunId"]);
  if (![qualification.runId, qualification.issueId, qualification.testsRunId, qualification.reviewerRunId, qualification.capabilityRunId].every(value => typeof value === "string" && uuidPattern.test(value)) || typeof qualification.candidateTree !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(qualification.candidateTree)) fail();
  const availability = keys(object.availability, ["runId", "verifiedAt", "available"], ["invalidatedByRunId", "category"]);
  if (typeof availability.runId !== "string" || !uuidPattern.test(availability.runId) || typeof availability.available !== "boolean") fail();
  dateMs(availability.verifiedAt);
  if (availability.invalidatedByRunId !== undefined && (typeof availability.invalidatedByRunId !== "string" || !uuidPattern.test(availability.invalidatedByRunId))) fail();
  if (availability.category !== undefined && !["authentication_required", "quota_unavailable", "entitlement_unavailable"].includes(String(availability.category))) fail();
  return value as NativeAdmission;
}
export function nativeNoToolPolicyDigest(adapterType: string): string {
  return createHash("sha256").update(JSON.stringify({ adapterType, permissionMode: "deny-all", timeoutSec: 120,
    ...(adapterType === "commandcode_local" ? { nativePolicy: { permissions: { defaultMode: "dont-ask", deny: ["*"], allow: [], disableBypass: true } } } : {}) })).digest("hex");
}
export function assertNativeMetadataMutation(actor: "owner" | "agent", existing: unknown, proposed: unknown): void {
  const before = existing && typeof existing === "object" ? existing as Record<string, unknown> : {};
  const after = proposed && typeof proposed === "object" ? proposed as Record<string, unknown> : {};
  if (actor !== "owner" && ["nativeProviderAdmission", "nativeProviderQualification", "nativeProviderManaged"].some(key => !isDeepStrictEqual(before[key], after[key]))) fail("native_owner_required");
}
export function validateNativeAdmission(input: NativeAdmissionInput): NativeAdmission {
  if (input.actor !== "owner") fail("native_owner_required");
  const admission = admissionShape(input.proposed), binding = input.currentBinding;
  assertNativeDispatchAdmission({ currentBinding: binding, admission });
  if (!Number.isFinite(input.nowMs)) fail();
  const timestamp = dateMs(admission.availability.verifiedAt);
  if (timestamp > input.nowMs || input.nowMs - timestamp > 900_000) fail("native_availability_stale");
  const proof = admission.qualification;
  const ids = [proof.runId, proof.testsRunId, proof.reviewerRunId, proof.capabilityRunId, admission.availability.runId];
  if (new Set(ids).size !== ids.length) fail("native_qualification_mismatch");
  const phases = ["coding", "tests", "reviewer", "capabilities", "availability"] as const;
  const evidence = ids.map((id, index) => {
    const run = input.runs[id];
    if (!run || run.id !== id || run.companyId !== binding.companyId || run.projectId !== binding.projectId || run.status !== "succeeded" || run.phase !== phases[index] || !Number.isFinite(run.finishedAtMs) || run.finishedAtMs > input.nowMs) fail("native_qualification_mismatch");
    if (index === 1 || index === 2) {
      if (run.agentId === binding.agentId || !run.stageApproved || run.issueId !== proof.issueId || run.candidateTree !== proof.candidateTree) fail("native_qualification_mismatch");
    } else {
      const result = run.resultJson;
      if (run.agentId !== binding.agentId || result?.nativeModelIdentity?.model !== binding.model || !["acp_session_status", "native_response"].includes(String(result?.nativeModelIdentity?.source))
          || result?.baseBindingFingerprint !== admission.bindingFingerprint || result?.mcpDigest !== binding.mcpDigest
          || result?.effectivePolicyDigest !== (index === 0 ? binding.policyDigest : nativeNoToolPolicyDigest(binding.adapterType))) fail("native_qualification_mismatch");
      if (index === 0 && (run.issueId !== proof.issueId || run.candidateTree !== proof.candidateTree)) fail("native_qualification_mismatch");
      if (index === 3 && result?.nativeCapabilityVerified !== true) fail("native_qualification_mismatch");
      if (index === 4 && (run.finishedAtMs !== timestamp || input.nowMs - run.finishedAtMs > 900_000)) fail("native_availability_stale");
    }
    return run;
  });
  if (evidence[1].agentId === evidence[2].agentId) fail("native_qualification_mismatch");
  return structuredClone(admission);
}
export function assertNativeDispatchAdmission(input: NativeDispatchAdmissionInput): void {
  if (!input.admission) fail("native_admission_required");
  const admission = admissionShape(input.admission);
  if (nativeBindingFingerprint(input.currentBinding) !== admission.bindingFingerprint) fail("native_binding_mismatch");
  if (!admission.availability.available || admission.availability.invalidatedByRunId) fail("native_availability_unavailable");
}
export function invalidateNativeAvailability(admission: NativeAdmission, runId: string, category: string): NativeAdmission {
  if (!["authentication_required", "quota_unavailable", "entitlement_unavailable"].includes(category)) return admission;
  if (!uuidPattern.test(runId)) fail();
  return { ...admission, availability: { ...admission.availability, available: false, invalidatedByRunId: runId, category } };
}
export function assertNativeQualificationScope(input: { currentBinding: NativeBindingIdentity; scope: NativeQualificationScope; issueId: string; phase: NativeQualificationScope["phase"]; nowMs: number; previousAttempts: number }): void {
  const scope = keys(input.scope, ["schemaVersion", "bindingFingerprint", "issueIds", "phase", "expiresAt", "maxAttempts"]);
  const expiry = dateMs(scope.expiresAt);
  if (scope.schemaVersion !== 1 || scope.maxAttempts !== 2 || !hashPattern.test(String(scope.bindingFingerprint)) || nativeBindingFingerprint(input.currentBinding) !== scope.bindingFingerprint
      || !Array.isArray(scope.issueIds) || !scope.issueIds.length || scope.issueIds.length > 3 || new Set(scope.issueIds).size !== scope.issueIds.length
      || scope.issueIds.some(id => typeof id !== "string" || !uuidPattern.test(id)) || !scope.issueIds.includes(input.issueId)
      || !["capabilities", "availability", "coding"].includes(String(scope.phase)) || scope.phase !== input.phase
      || !Number.isFinite(input.nowMs) || expiry <= input.nowMs || expiry - input.nowMs > 1_800_000
      || !Number.isSafeInteger(input.previousAttempts) || input.previousAttempts < 0 || input.previousAttempts >= 2) fail("native_qualification_scope_invalid");
}
