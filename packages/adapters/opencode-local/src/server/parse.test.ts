import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it.each(["APICallError", "APIError"])("certifies %s provider rejection only before any work", (name) => {
    const rejection = JSON.stringify({ type: "error", error: { name, data: {
      statusCode: 403, message: "Provider denied access", isRetryable: false,
      responseHeaders: {}, responseBody: "Provider denied access", metadata: {},
    } } });
    expect(parseOpenCodeJsonl(rejection).providerBootstrapUnavailable).toBe(true);
    for (const prefix of ["malformed", JSON.stringify({type:"text",part:{text:"Started"}}),
      JSON.stringify({type:"tool_use",part:{state:{status:"completed"}}}),
      JSON.stringify({type:"step_finish",part:{}})]) {
      expect(parseOpenCodeJsonl(prefix + "\n" + rejection).providerBootstrapUnavailable).toBe(false);
    }
    expect(parseOpenCodeJsonl(JSON.stringify({type:"error",error:{message:"403 in a tool"}})).providerBootstrapUnavailable).toBe(false);
    expect(parseOpenCodeJsonl(JSON.stringify({type:"error",error:{name,data:{statusCode:400}}})).providerBootstrapUnavailable).toBe(false);
  });
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("does not certify usage when a nonempty stream line is malformed", () => {
    const stdout = [
      JSON.stringify({ type: "step_finish", sessionID: "s1", part: {
        cost: 0.02, tokens: { input: 10, output: 4, cache: { read: 1 } },
      } }),
      '{"type":"step_finish","part":',
    ].join("\n");
    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.usage).toBeNull();
    expect(parsed.costUsd).toBeNull();
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});
