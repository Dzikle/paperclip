import { expect, it, vi } from "vitest";
import { resolveNativeBinding } from "./native-profile-binding.js";
it.each(["commandcode_local", "cline_local", "claude_local"])("cannot form an admitted binding for %s", async adapterType => {
  const select = vi.fn(() => { throw new Error("unexpected DB access"); });
  await expect(resolveNativeBinding({ select } as never,
    { id: "agent", companyId: "company", adapterType, adapterConfig: { nativeGuardReady: true } },
    { nativeGuardReady: true, nativeCostTier: "free", maxPaidUsd: 0 }, "project")).rejects.toThrow("native_permission_unsupported");
  expect(select).not.toHaveBeenCalled();
});
