import { describe, expect, it } from "vitest";
import { providerBootstrapFallbackDecision } from "./provider-bootstrap-fallback.js";

const profile = { adapterType: "codex_local", model: "gpt-5.6-sol", extraArgs: ["--sandbox", "read-only"], qualificationRunId: "qualified" };
const facts = {
  primaryAdapterType: "opencode_local", status: "failed", errorCode: "provider_unavailable_bootstrap",
  alreadySwitched: false, profile, boardApproved: true,
  qualification: { status: "succeeded", adapterType: "codex_local", model: "gpt-5.6-sol", sameCompany: true },
};
describe("qualified bootstrap provider fallback", () => {
  it("switches a failed provider bootstrap to the approved profile only once", () => {
    expect(providerBootstrapFallbackDecision(facts)).toEqual(profile);
    expect(providerBootstrapFallbackDecision({ ...facts, alreadySwitched: true })).toBeNull();
  });
  it.each([
    { status: "succeeded" }, { status: "cancelled" }, { errorCode: "budget_exceeded" },
    { errorCode: "adapter_failed" }, { primaryAdapterType: "process" }, { boardApproved: false },
    { qualification: { ...facts.qualification, sameCompany: false } },
    { qualification: { ...facts.qualification, model: "other" } },
    { qualification: { ...facts.qualification, status: "failed" } },
  ])("fails closed on unqualified/non-provider failures (%o)", (changed) => {
    expect(providerBootstrapFallbackDecision({ ...facts, ...changed })).toBeNull();
  });
});
