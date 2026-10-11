import { describe, expect, it } from "vitest";
import { nativeBindingFingerprint, type NativeBindingIdentity } from "@paperclipai/adapter-utils/native-provider-contract";
import { assertNativeDispatchAdmission, assertNativeMetadataMutation, assertNativeQualificationScope, invalidateNativeAvailability, nativeNoToolPolicyDigest, validateNativeAdmission, type NativeAdmission, type NativeAdmissionInput, type NativeRunEvidence } from "./native-profile-admission.js";
const nowMs = Date.parse("2026-10-11T12:00:00Z");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function validAdmissionFixture(): { admission: NativeAdmission; input: NativeAdmissionInput } {
  const binding: NativeBindingIdentity = { companyId: id(1), agentId: id(2), projectId: id(3), cwd: "/tmp/aif-native-test", adapterType: "cline_local", model: "exact/model", provider: "fixture", accountRef: "fixture-account", runtimePin: "fixture@1", policyDigest: "a".repeat(64), mcpDigest: "b".repeat(64), instructionsDigest: "c".repeat(64), credentialVersionRef: "fixture-secret-v1" };
  const fingerprint = nativeBindingFingerprint(binding);
  const admission: NativeAdmission = { schemaVersion: 1, binding, bindingFingerprint: fingerprint, qualification: { runId: id(4), issueId: id(5), candidateTree: "d".repeat(40), testsRunId: id(6), reviewerRunId: id(7), capabilityRunId: id(8) }, availability: { runId: id(9), verifiedAt: new Date(nowMs).toISOString(), available: true } };
  const makeRun = (runId: string, phase: NativeRunEvidence["phase"], agentId = binding.agentId): NativeRunEvidence => ({ id: runId, companyId: binding.companyId, agentId, status: "succeeded", projectId: binding.projectId, issueId: phase === "coding" || phase === "tests" || phase === "reviewer" ? id(5) : id(10), phase, finishedAtMs: nowMs,
    candidateTree: "d".repeat(40), stageApproved: true, resultJson: { nativeModelIdentity: { model: binding.model, source: "acp_session_status" }, baseBindingFingerprint: fingerprint, effectivePolicyDigest: phase === "availability" || phase === "capabilities" ? nativeNoToolPolicyDigest(binding.adapterType) : binding.policyDigest, mcpDigest: binding.mcpDigest, nativeCapabilityVerified: true } });
  const runs = Object.fromEntries([makeRun(id(4), "coding"), makeRun(id(6), "tests", id(20)), makeRun(id(7), "reviewer", id(21)), makeRun(id(8), "capabilities"), makeRun(id(9), "availability")].map(run => [run.id, run]));
  return { admission, input: { currentBinding: binding, proposed: admission, runs, actor: "owner", nowMs } };
}
describe("owner-controlled native profile admission", () => {
  it("rejects normalized impossible calendar dates in saved metadata", () => {
    const f = validAdmissionFixture();
    f.admission.availability.verifiedAt = "2026-02-30T12:00:00Z";
    expect(() => assertNativeDispatchAdmission({ currentBinding: f.admission.binding, admission: f.admission })).toThrow("native_availability_stale");
  });
  it("accepts successful exact binding with independent same-tree Tests/Reviewer", () => {
    const f = validAdmissionFixture(); expect(validateNativeAdmission(f.input)).toEqual(f.admission);
    expect(() => assertNativeDispatchAdmission({ currentBinding: f.admission.binding, admission: f.admission })).not.toThrow();
  });
  it.each(["agent", "other-company", "other-project", "same-agent", "failed-run", "requested-only", "missing-mcp", "wrong-tree", "future", "stale", "invalid-date", "different-binding", "unknown-schema", "missing-capability", "arbitrary-overlay"])("rejects %s proof", corruption => {
    const f = validAdmissionFixture(), run = f.input.runs[id(4)];
    if (corruption === "agent") f.input.actor = "agent";
    if (corruption === "other-company") run.companyId = id(90);
    if (corruption === "other-project") run.projectId = id(90);
    if (corruption === "same-agent") f.input.runs[id(7)].agentId = f.admission.binding.agentId;
    if (corruption === "failed-run") run.status = "failed";
    if (corruption === "requested-only") run.resultJson = { model: "exact/model" };
    if (corruption === "missing-mcp") delete f.input.runs[id(8)].resultJson!.mcpDigest;
    if (corruption === "wrong-tree") f.input.runs[id(6)].candidateTree = "e".repeat(40);
    if (corruption === "future") f.admission.availability.verifiedAt = new Date(nowMs + 1).toISOString();
    if (corruption === "stale") f.admission.availability.verifiedAt = new Date(nowMs - 900_001).toISOString();
    if (corruption === "invalid-date") f.admission.availability.verifiedAt = "not-a-date";
    if (corruption === "different-binding") f.input.currentBinding = { ...f.input.currentBinding, model: "other/model" };
    if (corruption === "unknown-schema") Object.assign(f.admission, { schemaVersion: 2 });
    if (corruption === "missing-capability") delete f.input.runs[id(8)];
    if (corruption === "arbitrary-overlay") f.input.runs[id(9)].resultJson!.effectivePolicyDigest = "e".repeat(64);
    expect(() => validateNativeAdmission(f.input)).toThrow();
  });
  it("rejects forged, cleared or replaced protected metadata by an agent", () => {
    const f = validAdmissionFixture();
    for (const proposed of [{}, null, { nativeProviderAdmission: { ...f.admission, availability: { ...f.admission.availability, available: false } } }, { nativeProviderQualification: { phase: "coding" } }]) {
      expect(() => assertNativeMetadataMutation("agent", { nativeProviderAdmission: f.admission }, proposed)).toThrow("native_owner_required");
    }
    expect(() => assertNativeMetadataMutation("agent", { note: "old" }, { note: "new" })).not.toThrow();
  });
  it("refuses stale retained registry bindings at dispatch", () => {
    const f = validAdmissionFixture();
    for (const field of Object.keys(f.admission.binding)) expect(() => assertNativeDispatchAdmission({ currentBinding: { ...f.admission.binding, [field]: field.endsWith("Digest") ? "f".repeat(64) : "/changed" }, admission: f.admission })).toThrow();
    expect(() => assertNativeDispatchAdmission({ currentBinding: f.admission.binding, admission: invalidateNativeAvailability(f.admission, id(91), "authentication_required") })).toThrow("native_availability_unavailable");
  });
  it("revokes availability without erasing history, but ignores ordinary failures", () => {
    const f = validAdmissionFixture();
    const next = invalidateNativeAvailability(f.admission, id(91), "authentication_required");
    expect(next.qualification).toEqual(f.admission.qualification);
    expect(next.availability).toMatchObject({ available: false, invalidatedByRunId: id(91), category: "authentication_required" });
    expect(invalidateNativeAvailability(f.admission, id(91), "native_failed")).toEqual(f.admission);
  });
  it("allows only exact finite proof scope, before production admission", () => {
    const f = validAdmissionFixture();
    const scope = { schemaVersion: 1 as const, bindingFingerprint: f.admission.bindingFingerprint, issueIds: [id(10)], phase: "capabilities" as const, expiresAt: new Date(nowMs + 60_000).toISOString(), maxAttempts: 2 as const };
    const input = { currentBinding: f.admission.binding, scope, issueId: id(10), phase: scope.phase, nowMs, previousAttempts: 0 };
    expect(() => assertNativeQualificationScope(input)).not.toThrow();
    for (const patch of [{ issueId: id(11) }, { previousAttempts: 2 }, { phase: "coding" }, { nowMs: nowMs + 60_000 }]) expect(() => assertNativeQualificationScope({ ...input, ...patch } as never)).toThrow();
    expect(() => assertNativeQualificationScope({ ...input, scope: { ...scope, expiresAt: new Date(nowMs + 1_800_001).toISOString() } })).toThrow();
  });
});
