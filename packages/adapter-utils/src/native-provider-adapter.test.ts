import { describe, expect, it, vi } from "vitest";
import { executeNativeAcp } from "./native-provider-adapter.js";
import type { AdapterExecutionContext } from "./types.js";
describe("native plugin public boundary", () => {
  it("bounds aggregate output and redacts raw native errors", async () => {
    const onLog = vi.fn(async (_stream: string, _text: string) => {});
    const ctx = { onLog } as unknown as AdapterExecutionContext;
    const result = await executeNativeAcp(ctx, async wrapped => {
      await wrapped.onLog("stderr", "private-secret-value");
      await wrapped.onLog("stdout", JSON.stringify({ type: "acpx.error", message: "private-secret-value", childStderrTail: "private-secret-value" }));
      for (let n = 0; n < 4; n++) await wrapped.onLog("stdout", "a".repeat(65_536));
      return { exitCode: 1, signal: null, timedOut: false, summary: "private-secret-value", errorMessage: "private-secret-value", resultJson: { stopReason: "private-secret-value" } };
    });
    const output = onLog.mock.calls.map(call => call[1]).join("");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(65_536);
    expect(output).not.toContain("private-secret-value");
    expect(JSON.stringify(result)).not.toContain("private-secret-value");
  });
  it("refuses to publish a thrown private transport error", async () => {
    const ctx = { onLog: vi.fn(async () => {}) } as unknown as AdapterExecutionContext;
    const result = await executeNativeAcp(ctx, async () => { throw new Error("private-secret-value"); });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("native_failed");
    expect(JSON.stringify(result)).not.toContain("private-secret-value");
  });
  it("never expands a truncated UTF-8 character past the byte budget", async () => {
    const onLog = vi.fn(async (_stream: string, _text: string) => {});
    await executeNativeAcp({ onLog } as unknown as AdapterExecutionContext, async wrapped => {
      await wrapped.onLog("stdout", "a".repeat(65_535));
      await wrapped.onLog("stdout", "é");
      return { exitCode: 0, signal: null, timedOut: false };
    });
    expect(Buffer.byteLength(onLog.mock.calls.map(call => call[1]).join(""))).toBeLessThanOrEqual(65_536);
  });
  it("drops arbitrary failed-result payloads but retains billing", async () => {
    const result = await executeNativeAcp({ onLog: async () => {} } as unknown as AdapterExecutionContext, async () => ({
      exitCode: 1, signal: null, timedOut: false, costUsd: 0.01,
      resultJson: { arbitraryProviderError: "private-secret-value" },
    }));
    expect(result.costUsd).toBe(0.01);
    expect(JSON.stringify(result)).not.toContain("private-secret-value");
  });
});
