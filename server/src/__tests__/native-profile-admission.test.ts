import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { agents, companyMemberships, heartbeatRuns } from "@paperclipai/db";
import { nativeBindingFingerprint } from "@paperclipai/adapter-utils/native-provider-contract";
import { authorizeNativeDispatch, nativeAdmissionApplies, nativeQualificationOverlay, recordNativeDispatchResult, validateNativeMetadataUpdate } from "../services/native-profile-admission-store.js";
import { resolveNativeBinding } from "../services/native-profile-binding.js";
import { logActivity } from "../services/activity-log.js";
vi.mock("../services/native-profile-binding.js", () => ({ resolveNativeBinding: vi.fn() }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => {}) }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const binding = { companyId: id(1), agentId: id(2), projectId: id(3), cwd: "/tmp/unused-native-fixture", adapterType: "cline_local", model: "exact/model", provider: "fixture", accountRef: "fixture-account", runtimePin: "fixture@1", policyDigest: "a".repeat(64), mcpDigest: "b".repeat(64), instructionsDigest: "c".repeat(64), credentialVersionRef: "fixture-v1" };
const fingerprint = nativeBindingFingerprint(binding);
const agent = { id: id(2), companyId: id(1), status: "idle", adapterType: "cline_local", metadata: { unrelated: "preserved", nativeProviderManaged: true }, adapterConfig: { model: binding.model } };
const admission = { schemaVersion: 1 as const, binding, bindingFingerprint: fingerprint, qualification: { runId: id(4), issueId: id(5), candidateTree: "d".repeat(40), testsRunId: id(6), reviewerRunId: id(7), capabilityRunId: id(8) }, availability: { runId: id(9), verifiedAt: "2026-10-11T12:00:00Z", available: true } };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(resolveNativeBinding).mockResolvedValue(binding); });
function fakeDb(current: Record<string, unknown> = agent, rotatedFingerprint = fingerprint, attempts = 0) {
  const dialect = new PgDialect(), writes: Array<{ values: unknown; query: ReturnType<PgDialect["sqlToQuery"]> }> = [];
  const database = {
    transaction: async (fn: (db: unknown) => unknown) => fn(database),
    select: () => {
      let table: unknown;
      const query = { from: (value: unknown) => { table = value; return query; }, where: () => query, for: () => query,
        limit: async () => table === agents ? [current] : table === heartbeatRuns ? [{ attempts }] : table === companyMemberships ? [] : [],
        then: (resolve: (rows: unknown[]) => void) => resolve(table === agents ? [current] : table === heartbeatRuns ? [{ attempts }] : []),
      }; return query;
    },
    update: () => {
      let values: unknown;
      const query = { set: (value: unknown) => { values = value; return query; }, where: (clause: Parameters<PgDialect["sqlToQuery"]>[0]) => { const compiled = dialect.sqlToQuery(clause); writes.push({ values, query: compiled }); return query; },
        returning: async () => writes.at(-1)?.query.params.includes(rotatedFingerprint) ? [{ id: agent.id }] : [], then: (resolve: (value: unknown[]) => void) => resolve([]) };
      return query;
    },
  };
  return { db: database as never, writes };
}
describe("native admission dispatch/owner integration without external services", () => {
  it("refuses changed persisted adapter config after runtime config capture", async () => {
    const original = { ...agent, metadata: { ...agent.metadata, nativeProviderAdmission: admission } };
    const current = { ...original, adapterConfig: { ...original.adapterConfig, model: "changed/model" } };
    await expect(authorizeNativeDispatch(fakeDb(current).db, { agent: original as never, config: {}, issueId: id(5), projectId: id(3), runId: id(30), runtimeSkills: [] })).rejects.toThrow("native_binding_mismatch");
  });
  it("an agent cannot replace or clear either grant", async () => {
    const f = fakeDb();
    for (const metadata of [null, { nativeProviderManaged: false }, { nativeProviderAdmission: admission }, { nativeProviderQualification: { phase: "coding" } }]) await expect(validateNativeMetadataUpdate(f.db, { type: "agent" }, agent as never, { metadata })).rejects.toThrow();
    expect(resolveNativeBinding).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0);
  });
  it("preserves unrelated metadata on an ordinary partial update", async () => {
    const f = fakeDb(), patch = { metadata: { note: "new" } };
    await validateNativeMetadataUpdate(f.db, { type: "agent" }, agent as never, patch);
    expect(patch.metadata).toMatchObject({ unrelated: "preserved", nativeProviderManaged: true, note: "new" });
  });
  it("a non-owner board membership cannot change admission", async () => {
    const f = fakeDb();
    await expect(validateNativeMetadataUpdate(f.db, { type: "board", userId: "not-owner" }, agent as never, { metadata: { nativeProviderAdmission: admission } })).rejects.toThrow("native_owner_required");
    expect(resolveNativeBinding).not.toHaveBeenCalled();
  });
  it("protects managed Claude even after admission removal, while preserving bootstrap", () => {
    expect(nativeAdmissionApplies({ adapterType: "claude_local", metadata: { nativeProviderManaged: true } })).toBe(true);
    for (const adapterType of ["codex_local", "opencode_local", "claude_local"]) expect(nativeAdmissionApplies({ adapterType, metadata: null })).toBe(false);
  });
  it("rechecks the current controller binding before executing a stale registry choice", async () => {
    const f = fakeDb({ ...agent, metadata: { ...agent.metadata, nativeProviderAdmission: admission } });
    vi.mocked(resolveNativeBinding).mockResolvedValue({ ...binding, credentialVersionRef: "rotated-v2" });
    await expect(authorizeNativeDispatch(f.db, { agent: agent as never, config: {}, issueId: id(5), projectId: id(3), runId: id(30), runtimeSkills: [] })).rejects.toThrow("native_binding_mismatch");
    expect(f.writes).toHaveLength(0);
  });
  it("uses the existing run ledger to bound exact-scope qualification attempts", async () => {
    const scope = { schemaVersion: 1 as const, bindingFingerprint: fingerprint, issueIds: [id(5)], phase: "capabilities" as const, expiresAt: new Date(Date.now() + 60_000).toISOString(), maxAttempts: 2 as const };
    const scoped = { ...agent, metadata: { ...agent.metadata, nativeProviderQualification: scope } };
    const input = { agent: scoped as never, config: {}, issueId: id(5), projectId: id(3), runId: id(30), runtimeSkills: [] };
    const f = fakeDb(scoped);
    const proof = await authorizeNativeDispatch(f.db, input);
    expect(proof?.phase).toBe("capabilities"); expect(f.writes).toHaveLength(1);
    await expect(authorizeNativeDispatch(fakeDb(scoped, fingerprint, 2).db, input)).rejects.toThrow("native_qualification_scope_invalid");
    await expect(authorizeNativeDispatch(f.db, { ...input, issueId: id(99) })).rejects.toThrow("native_qualification_scope_invalid");
  });
  it("a late authentication failure compares the ORIGINAL binding, preserving rotation", async () => {
    const f = fakeDb(agent, "f".repeat(64));
    const proof = { binding, baseBindingFingerprint: fingerprint, effectivePolicyDigest: binding.policyDigest, phase: "production" as const, issueId: id(5), projectId: id(3) };
    const result = await recordNativeDispatchResult(f.db, agent as never, id(30), proof, { exitCode: 1, signal: null, timedOut: false, errorCode: "authentication_required" });
    expect(result.errorCode).toBe("authentication_required");
    expect(f.writes[0].query.params).toContain(fingerprint);
    expect(f.writes[0].query.sql).toContain("bindingFingerprint");
    expect(f.writes[0].query.params).not.toContain("f".repeat(64));
    const values = f.writes[0].values as { metadata: Parameters<PgDialect["sqlToQuery"]>[0] };
    const metadataQuery = new PgDialect().sqlToQuery(values.metadata);
    expect(metadataQuery.sql).toContain("nativeProviderAdmission,availability");
    expect(JSON.stringify(metadataQuery.params)).toContain("authentication_required");
    expect(logActivity).not.toHaveBeenCalled();
  });
  it("overlays only no-tool policy and bounded availability timeout", () => {
    const proof = { binding, baseBindingFingerprint: fingerprint, effectivePolicyDigest: "e".repeat(64), phase: "availability" as const, issueId: id(5), projectId: id(3) };
    const config = { model: "exact/model", cwd: binding.cwd, provider: "fixture", permissionMode: "approve-reads", timeoutSec: 600, accountRef: "fixture-account" };
    expect(nativeQualificationOverlay(config, proof)).toEqual({ ...config, permissionMode: "deny-all", timeoutSec: 120 });
  });
});
