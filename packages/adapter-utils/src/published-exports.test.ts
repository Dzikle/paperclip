import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This test pins the published subpath surface of `package.json`.
//
// `@paperclipai/server` is itself a published npm package. Its published
// build imports `@paperclipai/adapter-utils/duplex-observability` as a real
// npm dependency, not as a workspace link. Node resolves that import against
// `publishConfig.exports`, so the subpath must stay published there. An
// earlier revision of this file denied the subpath with an explicit `null`
// entry; that denial broke module resolution for the published server. The
// subpath now falls through to the wildcard entry, the same as every other
// file in the package.

interface PackageManifest {
  exports: Record<string, unknown>;
  publishConfig: {
    exports: Record<string, unknown>;
  };
}

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;

describe("publishConfig publishes the duplex observability subpath", () => {
  it("imports the built native executor and contract through published package subpaths", async () => {
    // Run after workspace builds. Node, not Vite, resolves the published exports.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-native-exports-"));
    const packageRoot = path.dirname(manifestPath);
    try {
      await fs.access(path.join(packageRoot, "dist", "native-provider-contract.js"));
      for (const name of ["adapter-utils", "shared"]) {
        const source = path.resolve(packageRoot, "..", name);
        const target = path.join(root, "node_modules", "@paperclipai", name);
        const pkg = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "package.json"), JSON.stringify({ ...pkg, ...pkg.publishConfig }));
        await fs.cp(path.join(source, "dist"), path.join(target, "dist"), { recursive: true });
        // External dependencies only; shared resolves against the staged sibling.
        for (const dep of Object.keys(pkg.dependencies ?? {}).filter(dep => !dep.startsWith("@paperclipai/"))) {
          const link = path.join(root, "node_modules", dep);
          await fs.mkdir(path.dirname(link), { recursive: true });
          await fs.symlink(path.join(source, "node_modules", dep), link, "junction");
        }
      }
      const output = execFileSync(process.execPath, ["--input-type=module", "-e",
        "import {createAcpxEngineExecutor} from '@paperclipai/adapter-utils/acpx-engine/execute'; import {requireNativeModelIdentity} from '@paperclipai/adapter-utils/native-provider-contract'; console.log(typeof createAcpxEngineExecutor, requireNativeModelIdentity('exact/model','exact/model','native_response').model);"], { cwd: root, encoding: "utf8" });
      expect(output.trim()).toBe("function exact/model");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 30_000);
  it("does not deny the subpath in publishConfig.exports", () => {
    expect(manifest.publishConfig.exports).not.toHaveProperty("./duplex-observability");
  });

  it("keeps the wildcard entry in publishConfig.exports so the subpath resolves through it", () => {
    expect(manifest.publishConfig.exports["./*"]).toBeDefined();
  });

  it("keeps the top-level wildcard export unchanged", () => {
    expect(manifest.exports["./*"]).toBe("./src/*.ts");
  });
});
