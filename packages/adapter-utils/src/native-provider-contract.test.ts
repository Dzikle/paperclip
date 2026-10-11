import { describe, expect, it } from "vitest";
import { nativeBindingFingerprint, quoteNativeExecutable, requireNativeModelIdentity, type NativeBindingIdentity } from "./native-provider-contract.js";

const binding: NativeBindingIdentity = {
  companyId: "company", agentId: "agent", projectId: "project", cwd: "/work/македонија",
  adapterType: "cline_local", model: "exact/model", provider: "fixture", accountRef: "account-v1",
  runtimePin: "cline@3.0.70", policyDigest: "a".repeat(64), mcpDigest: "b".repeat(64),
  instructionsDigest: "c".repeat(64), credentialVersionRef: "credential-v1",
};
describe("native provider contract", () => {
  it("matches the fixed Python UTF-8 fingerprint fixture", () => {
    const crossLanguage = { ...binding, cwd: "/paperclip/source", accountRef: "account-ёж", runtimePin: "fixture@1", credentialVersionRef: "secret-ref:v1" };
    expect(nativeBindingFingerprint(crossLanguage)).toBe("7fc6460695a311b513165695c1b944429030db8e0476557dc3573f05be9c09a6");
  });
  it("requires actual exact native model evidence", () => {
    expect(() => requireNativeModelIdentity(undefined, binding.model, "acp_session_status")).toThrow("native_model_identity_missing");
    expect(() => requireNativeModelIdentity("other/model", binding.model, "acp_session_status")).toThrow("native_model_identity_mismatch");
    expect(requireNativeModelIdentity(binding.model, binding.model, "native_response")).toEqual({ model: binding.model, source: "native_response" });
    expect(() => requireNativeModelIdentity(binding.model, "", "native_response")).toThrow();
  });
  it("fingerprints every identity field, independently of insertion order", () => {
    const fingerprint = nativeBindingFingerprint(binding);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(nativeBindingFingerprint(Object.fromEntries(Object.entries(binding).reverse()) as NativeBindingIdentity)).toBe(fingerprint);
    for (const key of Object.keys(binding) as Array<keyof NativeBindingIdentity>) {
      const changed = { ...binding, [key]: key.endsWith("Digest") ? "d".repeat(64) : binding[key] + "2" };
      expect(nativeBindingFingerprint(changed)).not.toBe(fingerprint);
    }
  });
  it.each(["relative", "/work/../other", "/work//other", "/work/", "C:\\work", "/work\nother"])("rejects noncanonical cwd %j", cwd => {
    expect(() => nativeBindingFingerprint({ ...binding, cwd })).toThrow("native_binding_invalid");
  });
  it("rejects missing fields, extra secret fields and malformed digests", () => {
    expect(() => nativeBindingFingerprint({ ...binding, provider: " " })).toThrow();
    expect(() => nativeBindingFingerprint({ ...binding, policyDigest: "A".repeat(64) })).toThrow();
    expect(() => nativeBindingFingerprint({ ...binding, token: "not-allowed" } as NativeBindingIdentity)).toThrow();
  });
  it("quotes native executable paths without shell expansion", () => {
    expect(quoteNativeExecutable("/opt/O'Brien/bin/native")).toBe("'/opt/O'\"'\"'Brien/bin/native'");
    for (const executable of ["cmd.exe", "C:\\Windows\\System32\\cmd.exe", "/tmp/a\n--bypass", "/tmp/a\0b", "/tmp/a\rb"]) {
      expect(() => quoteNativeExecutable(executable)).toThrow("native_command_invalid");
    }
  });
});
