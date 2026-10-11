import { describe, expect, it } from "vitest";
import { claudeNativeModelIdentity, parseClaudeStreamJson } from "./parse.js";
describe("Claude actual native-response model evidence", () => {
  it("ignores system/config defaults without an actual assistant response", () => {
    const parsed = parseClaudeStreamJson(JSON.stringify({ type: "system", subtype: "init", model: "requested/model" }));
    expect(claudeNativeModelIdentity(parsed)).toBeNull();
  });
  it("captures actual assistant model, never overwrites it with a requested default", () => {
    const parsed = parseClaudeStreamJson([ { type: "system", subtype: "init", model: "requested/model" }, { type: "assistant", message: { model: "actual/model", content: [{ type: "text", text: "done" }] } } ].map(event => JSON.stringify(event)).join("\n"));
    expect(claudeNativeModelIdentity(parsed)).toEqual({ model: "actual/model", source: "native_response" });
  });
  it("refuses mixed-model response identity", () => {
    const parsed = parseClaudeStreamJson([ { type: "assistant", message: { model: "one/model" } }, { type: "assistant", message: { model: "other/model" } } ].map(event => JSON.stringify(event)).join("\n"));
    expect(claudeNativeModelIdentity(parsed)).toBeNull();
  });
});
