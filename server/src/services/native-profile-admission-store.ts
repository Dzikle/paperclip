import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { agents, companyMemberships, documentRevisions, heartbeatRuns, issueDocuments, issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import { nativeBindingFingerprint, type NativeBindingIdentity } from "@paperclipai/adapter-utils/native-provider-contract";
import { forbidden, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { resolveNativeBinding, type NativeBindingAgent } from "./native-profile-binding.js";
import { assertNativeDispatchAdmission, assertNativeMetadataMutation, assertNativeQualificationScope, invalidateNativeAvailability, nativeNoToolPolicyDigest, validateNativeAdmission, type NativeAdmission, type NativeQualificationScope, type NativeRunEvidence } from "./native-profile-admission.js";
import { captureNativeCanarySource, verifyNativeCanaryCandidate, type NativeCanarySource } from "./native-canary-source.js";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function assertNativeCodingTimeout(config: Record<string, unknown>): void {
  const timeout = config.timeoutSec ?? 600;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 600) throw new Error("native_timeout_not_authorized");
}
type NativeAgent = typeof agents.$inferSelect;
export interface NativeAdmissionActor { type: string; source?: string; isInstanceAdmin?: boolean; userId?: string }
export interface NativeDispatchProof {
  binding: NativeBindingIdentity; baseBindingFingerprint: string; effectivePolicyDigest: string;
  phase: "production" | NativeQualificationScope["phase"]; issueId: string; projectId: string;
  canarySource?: NativeCanarySource;
}
export function nativeAdmissionApplies(agent: Pick<NativeAgent, "adapterType" | "metadata">): boolean {
  return ["cline_local", "commandcode_local"].includes(agent.adapterType) || Boolean(object(agent.metadata).nativeProviderManaged || object(agent.metadata).nativeProviderAdmission || object(agent.metadata).nativeProviderQualification);
}
export async function assertNativeOwner(db: Db, actor: NativeAdmissionActor, companyId: string): Promise<void> {
  if (actor.type !== "board") throw forbidden("native_owner_required");
  if (actor.source === "local_implicit" || actor.isInstanceAdmin === true) return;
  if (!actor.userId) throw forbidden("native_owner_required");
  const [membership] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, actor.userId), eq(companyMemberships.status, "active"), eq(companyMemberships.membershipRole, "owner"))).limit(1);
  if (!membership) throw forbidden("native_owner_required");
}
async function loadEvidence(db: Db, companyId: string, admission: NativeAdmission): Promise<Record<string, NativeRunEvidence>> {
  const q = admission.qualification;
  const ids = [q.runId, q.testsRunId, q.reviewerRunId, q.capabilityRunId, admission.availability.runId];
  const rows = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, ids)));
  const evidence: Record<string, NativeRunEvidence> = {};
  for (const row of rows) {
    const result = object(row.resultJson), proof = object(result.nativeProviderProof);
    let phase = proof.phase as NativeRunEvidence["phase"], issueId = String(proof.issueId ?? row.nativeIssueId ?? "");
    let candidateTree = typeof proof.candidateTree === "string" ? proof.candidateTree : undefined;
    let stageApproved = false;
    if (row.id === q.testsRunId || row.id === q.reviewerRunId) {
      phase = row.id === q.testsRunId ? "tests" : "reviewer";
      // Witness comes from an immutable run-authored document revision AND
      // Paperclip's stage decision, not owner-supplied run IDs or agent names.
      const revisions = await db.select({ body: documentRevisions.body, issueId: issueDocuments.issueId }).from(documentRevisions).innerJoin(issueDocuments, eq(issueDocuments.documentId, documentRevisions.documentId)).where(and(eq(documentRevisions.companyId, companyId), eq(documentRevisions.createdByRunId, row.id), eq(documentRevisions.createdByAgentId, row.agentId), eq(issueDocuments.key, `native-qualification-${row.id}`))).limit(2);
      if (revisions.length !== 1 || Buffer.byteLength(revisions[0].body) > 32_768) throw new Error("native_qualification_mismatch");
      const receipt = object(JSON.parse(revisions[0].body));
      if (receipt.schemaVersion !== 1 || receipt.runId !== row.id || receipt.agentId !== row.agentId || receipt.issueId !== revisions[0].issueId || receipt.phase !== phase || receipt.verdict !== "passed" || receipt.validationSource !== "credential-free isolated committed copy") throw new Error("native_qualification_mismatch");
      issueId = revisions[0].issueId;
      candidateTree = typeof receipt.candidateTree === "string" ? receipt.candidateTree : undefined;
      const decisions = await db.select().from(issueExecutionDecisions).where(and(eq(issueExecutionDecisions.companyId, companyId), eq(issueExecutionDecisions.issueId, issueId), eq(issueExecutionDecisions.createdByRunId, row.id), eq(issueExecutionDecisions.actorAgentId, row.agentId), eq(issueExecutionDecisions.outcome, "approved"))).limit(2);
      const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
      const stages = object(issue?.executionPolicy).stages;
      const completed = object(issue?.executionState).completedStageIds;
      const reviewStages = Array.isArray(stages) ? stages.filter(stage => object(stage).type === "review") : [];
      const roleStage = object(reviewStages[phase === "tests" ? 0 : 1]);
      const participants = roleStage.participants;
      stageApproved = decisions.length === 1 && Array.isArray(completed) && completed.includes(decisions[0].stageId)
        && roleStage.id === decisions[0].stageId && Array.isArray(participants) && participants.length === 1 && object(participants[0]).agentId === row.agentId;
    }
    const [issue] = await db.select({ projectId: issues.projectId }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
    if (!issue?.projectId) throw new Error("native_qualification_mismatch");
    evidence[row.id] = { id: row.id, companyId: row.companyId, agentId: row.agentId, status: row.status, issueId, projectId: issue.projectId, phase, finishedAtMs: row.finishedAt?.getTime() ?? NaN, candidateTree, stageApproved,
      resultJson: { ...result, baseBindingFingerprint: proof.baseBindingFingerprint as string, effectivePolicyDigest: proof.effectivePolicyDigest as string, mcpDigest: proof.mcpDigest as string, nativeCapabilityVerified: proof.nativeCapabilityVerified === true, nativeCanaryVerified: proof.nativeCanaryVerified === true } as NativeRunEvidence["resultJson"] };
  }
  return evidence;
}
export async function validateNativeMetadataUpdate(db: Db, actor: NativeAdmissionActor, existing: NativeAgent, patch: Record<string, unknown>): Promise<void> {
  if (!("metadata" in patch)) return;
  const before = object(existing.metadata), after = patch.metadata === null ? {} : { ...before, ...object(patch.metadata) };
  assertNativeMetadataMutation(actor.type === "board" ? "owner" : "agent", before, after);
  if (before.nativeProviderManaged || after.nativeProviderAdmission || after.nativeProviderQualification) after.nativeProviderManaged = true;
  patch.metadata = after;
  const changed = ["nativeProviderAdmission", "nativeProviderQualification", "nativeProviderManaged"].some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if (!changed) return;
  await assertNativeOwner(db, actor, existing.companyId);
  if (!["idle", "paused"].includes(existing.status)) throw unprocessable("native_agent_not_idle");
  const config = object(patch.adapterConfig ?? existing.adapterConfig);
  const agent = { ...existing, adapterType: typeof patch.adapterType === "string" ? patch.adapterType : existing.adapterType, adapterConfig: config };
  try {
    const admission = after.nativeProviderAdmission as NativeAdmission | undefined;
    if (admission) {
      const binding = await resolveNativeBinding(db, agent, config, admission.binding.projectId);
      after.nativeProviderAdmission = validateNativeAdmission({ currentBinding: binding, proposed: admission, runs: await loadEvidence(db, existing.companyId, admission), actor: "owner", nowMs: Date.now() });
    }
    const scope = after.nativeProviderQualification as NativeQualificationScope | undefined;
    if (scope) {
      if (!Array.isArray(scope.issueIds) || !scope.issueIds.length || scope.issueIds.length > 3) throw new Error("native_qualification_scope_invalid");
      const proofIssues = await db.select().from(issues).where(and(eq(issues.companyId, existing.companyId), inArray(issues.id, scope.issueIds)));
      if (proofIssues.length !== scope.issueIds.length || proofIssues.some(issue => issue.status !== "backlog" || issue.assigneeAgentId !== existing.id || !issue.projectId || issue.projectId !== proofIssues[0].projectId)) throw new Error("native_qualification_scope_invalid");
      const binding = await resolveNativeBinding(db, agent, config, proofIssues[0].projectId!);
      if (scope.phase === "coding") { assertNativeCodingTimeout(config); await captureNativeCanarySource(binding.cwd, config.nativeCanaryBaseCommit); }
      assertNativeQualificationScope({ currentBinding: binding, scope, issueId: scope.issueIds[0], phase: scope.phase, nowMs: Date.now(), previousAttempts: 0 });
      if (["cline_local", "claude_local"].includes(agent.adapterType)) throw new Error("native_permission_unsupported");
    }
  } catch { throw unprocessable("native_qualification_mismatch"); }
}
export async function authorizeNativeDispatch(db: Db, input: { agent: NativeAgent; config: Record<string, unknown>; issueId: string | null; projectId: string | null; runId: string; runtimeSkills: PaperclipSkillEntry[] }): Promise<NativeDispatchProof | null> {
  if (!nativeAdmissionApplies(input.agent)) return null;
  if (!input.issueId || !input.projectId) throw new Error("native_project_mismatch");
  return db.transaction(async tx => {
    const store = tx as unknown as Db;
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, input.agent.id), eq(agents.companyId, input.agent.companyId))).for("update").limit(1);
    if (!agent || agent.adapterType !== input.agent.adapterType || !isDeepStrictEqual(agent.adapterConfig, input.agent.adapterConfig)) throw new Error("native_binding_mismatch");
    if (["cline_local", "claude_local"].includes(agent.adapterType)) throw new Error("native_permission_unsupported");
    const binding = await resolveNativeBinding(store, agent as NativeBindingAgent, input.config, input.projectId!);
    const fingerprint = nativeBindingFingerprint(binding), metadata = object(agent.metadata);
    const scope = metadata.nativeProviderQualification as NativeQualificationScope | undefined;
    let phase: NativeDispatchProof["phase"] = "production";
    if (scope) {
      const [count] = await tx.select({ attempts: sql<number>`count(*)::integer` }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id), ne(heartbeatRuns.id, input.runId), sql`${heartbeatRuns.contextSnapshot} -> 'nativeProviderProof' ->> 'baseBindingFingerprint' = ${fingerprint}`, sql`${heartbeatRuns.contextSnapshot} -> 'nativeProviderProof' ->> 'phase' = ${scope.phase}`));
      assertNativeQualificationScope({ currentBinding: binding, scope, issueId: input.issueId!, phase: scope.phase, nowMs: Date.now(), previousAttempts: count?.attempts ?? 0 });
      phase = scope.phase;
    } else assertNativeDispatchAdmission({ currentBinding: binding, admission: metadata.nativeProviderAdmission as NativeAdmission ?? null });
    // Validate materialized content against current owner-selected versions.
    await resolveNativeBinding(store, agent as NativeBindingAgent, input.config, input.projectId!, input.runtimeSkills);
    const proof: NativeDispatchProof = { binding, baseBindingFingerprint: fingerprint, effectivePolicyDigest: phase === "capabilities" || phase === "availability" ? nativeNoToolPolicyDigest(agent.adapterType) : binding.policyDigest, phase, issueId: input.issueId!, projectId: input.projectId! };
    if (phase === "coding") { assertNativeCodingTimeout(input.config); proof.canarySource = await captureNativeCanarySource(binding.cwd, input.config.nativeCanaryBaseCommit); }
    await tx.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ nativeProviderProof: proof })}::jsonb` }).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, agent.companyId)));
    return proof;
  });
}
export function nativeQualificationOverlay(config: Record<string, unknown>, proof: NativeDispatchProof): Record<string, unknown> {
  if (proof.phase === "coding") {
    const timeout = config.timeoutSec ?? 600;
    if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("native_timeout_invalid");
    return { ...config, timeoutSec: Math.min(timeout, 600) };
  }
  if (proof.phase !== "capabilities" && proof.phase !== "availability") return config;
  return { ...config, permissionMode: "deny-all", timeoutSec: 120,
    ...(proof.binding.adapterType === "commandcode_local" ? { nativePolicy: { permissions: { defaultMode: "dont-ask", deny: ["*"], allow: [], disableBypass: true } } } : {}) };
}
export async function recordNativeDispatchResult(db: Db, agent: NativeAgent, runId: string, proof: NativeDispatchProof | null, result: AdapterExecutionResult): Promise<AdapterExecutionResult> {
  if (!proof) return result;
  const identity = object(object(result.resultJson).nativeModelIdentity);
  if (result.exitCode === 0 && identity.model !== proof.binding.model) result = { ...result, exitCode: 1, errorCode: identity.model ? "native_model_identity_mismatch" : "native_model_identity_missing", errorMessage: "native_model_identity_mismatch", clearSession: true };
  let candidateTree: string | undefined;
  if (proof.phase === "coding" && result.exitCode === 0) {
    try { candidateTree = await verifyNativeCanaryCandidate(proof.binding.cwd, proof.canarySource); }
    catch { result = { ...result, exitCode: 1, errorCode: "native_qualification_mismatch", errorMessage: "native_qualification_mismatch", clearSession: true }; }
  }
  const category = result.errorCode ?? "";
  if (["authentication_required", "quota_unavailable", "entitlement_unavailable"].includes(category)) {
    const [updated] = await db.update(agents).set({ metadata: sql`jsonb_set(coalesce(${agents.metadata}, '{}'::jsonb), '{nativeProviderAdmission,availability}', (coalesce(${agents.metadata} -> 'nativeProviderAdmission' -> 'availability', '{}'::jsonb) || ${JSON.stringify({ available: false, invalidatedByRunId: runId, category })}::jsonb), false)`, updatedAt: new Date() }).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId), sql`${agents.metadata} -> 'nativeProviderAdmission' ->> 'bindingFingerprint' = ${proof.baseBindingFingerprint}`)).returning({ id: agents.id });
    if (updated) await logActivity(db, { companyId: agent.companyId, actorType: "system", actorId: "system", agentId: agent.id, runId, action: "native_profile.availability_revoked", entityType: "agent", entityId: agent.id, details: { bindingFingerprint: proof.baseBindingFingerprint, category, runId } });
  }
  return { ...result, resultJson: { ...object(result.resultJson), nativeProviderProof: { phase: proof.phase, issueId: proof.issueId, projectId: proof.projectId, baseBindingFingerprint: proof.baseBindingFingerprint, effectivePolicyDigest: proof.effectivePolicyDigest, mcpDigest: proof.binding.mcpDigest,
    ...(candidateTree ? { candidateTree, nativeCanaryVerified: true } : {}), ...(proof.phase === "capabilities" && result.exitCode === 0 ? { nativeCapabilityVerified: true } : {}) } } };
}
