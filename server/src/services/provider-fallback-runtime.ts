import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { agents, agentConfigRevisions, agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { claimedAdapterType } from "./conversation-continuation.js";
import { providerBootstrapFallbackDecision, type ProviderFallbackProfile } from "./provider-bootstrap-fallback.js";

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
export function providerFallbackRuntime(db: Db) {
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
    const selected = source && providerBootstrapFallbackDecision({primaryAdapterType:primary.adapterType,status:source.status,errorCode:source.errorCode,
      alreadySwitched:false,profile:receipt.profile,boardApproved: !!revision?.createdByUserId && !revision.createdByAgentId &&
        isDeepStrictEqual(record(record(revision.afterConfig).runtimeConfig).providerFallback,record(primary.runtimeConfig).providerFallback),
      qualification:await qualification(primary,receipt.profile)});
    if (!selected || run.invocationSource !== "automation" || !run.retryOfRunId ||
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
  return { prepare,resolve };
}
