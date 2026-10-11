import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { nativeArtifactDigest } from "./native-runtime-artifacts.js";
it("recomputes compiled/native artifact bytes, not version claims", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-artifact-fixture-"));
  try {
    await fs.writeFile(path.join(root, "entry.js"), "offline artifact v1");
    const first = await nativeArtifactDigest(root);
    await fs.writeFile(path.join(root, "entry.js"), "offline artifact v2");
    expect(await nativeArtifactDigest(root)).not.toBe(first);
    await fs.mkdir(path.join(root, "additional"));
    expect(await nativeArtifactDigest(root)).not.toBe(first);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it.skipIf(process.platform === "win32")("refuses an artifact symlink escape", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-artifact-symlink-fixture-"));
  try { await fs.symlink("/unmanaged/external", path.join(root, "escape")); await expect(nativeArtifactDigest(root)).rejects.toThrow("native_runtime_pin_mismatch"); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
});
