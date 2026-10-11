import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nativeCredentialGeneration } from "./native-credential-generation.js";
describe.runIf(process.platform === "linux")("nonsecret native credential filesystem generation", () => {
  it("changes on replacement without reading/publishing credential bytes", async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aif-credential-generation-")));
    try {
      const file = path.join(home, "auth.json");
      await fs.writeFile(file, "private-token-one", { mode: 0o600 });
      const before = await nativeCredentialGeneration(home,file);
      await fs.writeFile(file + ".replacement", "private-token-two", { mode: 0o600 });
      await fs.rename(file + ".replacement",file);
      const after = await nativeCredentialGeneration(home,file);
      expect(after).not.toBe(before); expect(after).not.toContain("private-token");
      await fs.chmod(file,0o644);
      await expect(nativeCredentialGeneration(home,file)).rejects.toThrow();
    } finally { await fs.rm(home,{ recursive:true,force:true }); }
  });
});
