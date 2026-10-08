/** A provider switch is separate from infrastructure retry counters. */
export type ProviderFallbackProfile = { adapterType: "codex_local"; model: string; extraArgs: string[]; qualificationRunId: string };
export function providerBootstrapFallbackDecision(facts: {
  primaryAdapterType: string; status: string; errorCode: string | null;
  alreadySwitched: boolean; profile: unknown; boardApproved: boolean;
  qualification: { status: string; adapterType: string | null; model: string; sameCompany: boolean } | null;
}): ProviderFallbackProfile | null {
  const profile = facts.profile as ProviderFallbackProfile | null;
  if (facts.primaryAdapterType !== "opencode_local" || facts.status !== "failed" ||
      facts.errorCode !== "provider_unavailable_bootstrap" || facts.alreadySwitched || !facts.boardApproved ||
      !profile || profile.adapterType !== "codex_local" || typeof profile.model !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(profile.model) || typeof profile.qualificationRunId !== "string" ||
      !Array.isArray(profile.extraArgs) || profile.extraArgs.length > 16 ||
      profile.extraArgs.some(arg => typeof arg !== "string" || arg.length > 256 ||
        /dangerously|yolo|api.?key|token|password/i.test(arg)) ||
      facts.qualification?.status !== "succeeded" || !facts.qualification.sameCompany ||
      facts.qualification.adapterType !== profile.adapterType || facts.qualification.model !== profile.model) return null;
  return { adapterType: "codex_local", model: profile.model, extraArgs: [...profile.extraArgs], qualificationRunId: profile.qualificationRunId };
}
