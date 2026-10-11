import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { agents, agentConfigRevisions, agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { claimedAdapterType } from "./conversation-continuation.js";
import { providerBootstrapFallbackDecision, type ProviderFallbackProfile } from "./provider-bootstrap-fallback.js";
import { buildFinishSuccessfulRunHandoffIdempotencyKey, FINISH_SUCCESSFUL_RUN_HANDOFF_REASON } from "./recovery/successful-run-handoff.js";
import { buildRunLivenessContinuationIdempotencyKey, RUN_LIVENESS_CONTINUATION_REASON } from "./recovery/run-liveness-continuations.js";

type Agent = typeof agents.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
export type ProviderFallbackReceipt = {
  sourceRunId: string; policyRevisionId: string; switchCount: 1;
  primaryConfigHash: string; profile: ProviderFallbackProfile;
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,val]) => [key,stable(val)]));
  return value;
}
function configHash(agent: Agent) {
  return createHash("sha256").update(JSON.stringify(stable({ adapterType: agent.adapterType, adapterConfig: agent.adapterConfig,
    profile: record(agent.runtimeConfig).providerFallback }))).digest("hex");
}
export function hasProviderFallback(run: Pick<Run, "runnerProfileJson">): boolean {
  return Object.hasOwn(record(run.runnerProfileJson), "providerFallback");
}
type NativeWake = Pick<typeof agentWakeupRequests.$inferSelect,
  "source" | "triggerDetail" | "reason" | "requestedByActorType" | "requestedByActorId" | "idempotencyKey">;
function nativeFollowupParent(wake: NativeWake, context: Record<string, unknown>): string | null {
  const parent = context.parentRunId, issueId = context.issueId;
  if (wake.source !== "automation" || wake.triggerDetail !== "system" ||
      wake.requestedByActorType !== "system" || wake.requestedByActorId !== "heartbeat" ||
      typeof parent !== "string" || typeof issueId !== "string") return null;
  if (wake.reason === FINISH_SUCCESSFUL_RUN_HANDOFF_REASON && context.sourceRunId === parent &&
      wake.idempotencyKey === buildFinishSuccessfulRunHandoffIdempotencyKey({issueId,sourceRunId:parent})) return parent;
  const state = context.livenessContinuationState, attempt = context.livenessContinuationAttempt;
  if (wake.reason === RUN_LIVENESS_CONTINUATION_REASON && context.livenessContinuationSourceRunId === parent &&
      (state === "plan_only" || state === "empty_response") && typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0 &&
      wake.idempotencyKey === buildRunLivenessContinuationIdempotencyKey({issueId,sourceRunId:parent,livenessState:state,nextAttempt:attempt})) return parent;
  return null;
}
export function providerFallbackRuntime(db: Db) {
  async function inheritNativeFollowup(agent: Pick<Agent,"id"|"companyId">, issueId: string, wake: NativeWake, context: Record<string,unknown>) {
    const parentId = nativeFollowupParent(wake,context);
    if (!parentId || context.issueId !== issueId) return null;
    const [parent] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,parentId),
      eq(heartbeatRuns.companyId,agent.companyId),eq(heartbeatRuns.agentId,agent.id))).limit(1);
    if (!parent || record(parent.contextSnapshot).issueId !== issueId || !hasProviderFallback(parent)) return null;
    if (parent.status !== "succeeded" || !parent.finishedAt || claimedAdapterType(parent) !== "codex_local") {
      throw new Error("provider_fallback_provenance_invalid");
    }
    // Copy only the server-sealed receipt, never a profile supplied by a wake
    // caller. Claim/execute revalidate current board policy and qualification;
    // a revoked selection must cancel rather than silently return to primary.
    return {parentRunId:parent.id,receipt:record(parent.runnerProfileJson).providerFallback};
  }
  async function qualification(agent: Agent, profile: unknown) {
    const id = record(profile).qualificationRunId;
    if (typeof id !== "string") return null;
    const [proof] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,id),eq(heartbeatRuns.companyId,agent.companyId))).limit(1);
    return proof ? { status: proof.status, adapterType: claimedAdapterType(proof),
      model: String(record(proof.usageJson).model ?? record(proof.resultJson).model ?? ""), sameCompany: true } : null;
  }
  async function prepare(run: Run, agent: Agent): Promise<ProviderFallbackReceipt | null> {
    const profile = record(agent.runtimeConfig).providerFallback;
    if (!profile || hasProviderFallback(run)) return null;
    const revisions = await db.select().from(agentConfigRevisions).where(and(eq(agentConfigRevisions.agentId,agent.id),eq(agentConfigRevisions.companyId,agent.companyId))).orderBy(desc(agentConfigRevisions.createdAt));
    const revision = revisions.find(rev => rev.createdByUserId && !rev.createdByAgentId &&
      isDeepStrictEqual(record(record(rev.afterConfig).runtimeConfig).providerFallback,profile));
    const selected = providerBootstrapFallbackDecision({ primaryAdapterType: agent.adapterType, status: run.status,
      errorCode: run.errorCode, alreadySwitched: hasProviderFallback(run), profile, boardApproved: !!revision,
      qualification: await qualification(agent,profile) });
    if (!selected || !revision) return null;
    return { sourceRunId: run.id, policyRevisionId: revision.id, switchCount: 1, primaryConfigHash: configHash(agent), profile: selected };
  }
  async function resolve(run: Run, primary: Agent): Promise<Agent> {
    if (!hasProviderFallback(run)) return primary;
    const receipt = record(run.runnerProfileJson).providerFallback as ProviderFallbackReceipt;
    if (!receipt || receipt.switchCount !== 1 || receipt.primaryConfigHash !== configHash(primary)) throw new Error("provider_fallback_configuration_changed");
    const [source] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,receipt.sourceRunId),eq(heartbeatRuns.companyId,run.companyId),eq(heartbeatRuns.agentId,run.agentId))).limit(1);
    const [wake] = run.wakeupRequestId ? await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,run.wakeupRequestId)).limit(1) : [];
    const [revision] = await db.select().from(agentConfigRevisions).where(and(eq(agentConfigRevisions.id,receipt.policyRevisionId),eq(agentConfigRevisions.agentId,primary.id),eq(agentConfigRevisions.companyId,primary.companyId))).limit(1);
    const [parent] = run.retryOfRunId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,run.retryOfRunId),
      eq(heartbeatRuns.companyId,run.companyId),eq(heartbeatRuns.agentId,run.agentId))).limit(1) : [];
    const context = record(run.contextSnapshot);
    const nativeParent = wake ? nativeFollowupParent(wake,context) : null;
    const nativeLineage = nativeParent === parent?.id && parent?.status === "succeeded" && !!parent.finishedAt &&
      claimedAdapterType(parent) === "codex_local";
    const retryLineage = wake?.requestedByActorId === null && !!run.scheduledRetryReason &&
      context.retryOfRunId === parent?.id && record(wake.payload).retryOfRunId === parent?.id;
    const parentSelection = parent && record(parent.contextSnapshot).issueId === context.issueId &&
      (parent.id === receipt.sourceRunId || isDeepStrictEqual(record(parent.runnerProfileJson).providerFallback,receipt));
    const selected = source && providerBootstrapFallbackDecision({primaryAdapterType:primary.adapterType,status:source.status,errorCode:source.errorCode,
      alreadySwitched:false,profile:receipt.profile,boardApproved: !!revision?.createdByUserId && !revision.createdByAgentId &&
        isDeepStrictEqual(record(record(revision.afterConfig).runtimeConfig).providerFallback,record(primary.runtimeConfig).providerFallback),
      qualification:await qualification(primary,receipt.profile)});
    if (!selected || run.invocationSource !== "automation" || !parentSelection || (!nativeLineage && !retryLineage) ||
      wake?.source !== "automation" || wake.triggerDetail !== "system" ||
      wake?.requestedByActorType !== "system" || wake.runId !== run.id || wake.agentId !== run.agentId || wake.companyId !== run.companyId ||
      record(source?.contextSnapshot).issueId !== record(run.contextSnapshot).issueId) throw new Error("provider_fallback_provenance_invalid");
    // No credentials or alternate instructions are persisted/copied. The
    // logical principal, workspace, restrictions and run-scoped env stay put.
    const config: Record<string,unknown> = { ...record(primary.adapterConfig), model:selected.model, extraArgs:selected.extraArgs,
      command:"codex", dangerouslyBypassApprovalsAndSandbox:false };
    const env = { ...record(config.env) };
    delete env.OPENCODE_CONFIG_CONTENT;
    return {...primary, adapterType:selected.adapterType, adapterConfig:{...config,env}};
  }
  return { prepare,resolve,inheritNativeFollowup };
}
