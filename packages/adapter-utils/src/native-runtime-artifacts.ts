import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
/** Byte identity of a bounded immutable image artifact. Never follows symlinks. */
export async function nativeArtifactDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  let count = 0, bytes = 0;
  async function visit(file: string, relative: string): Promise<void> {
    if (++count > 20_000) throw new Error("native_runtime_pin_mismatch");
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error("native_runtime_pin_mismatch");
    if (stat.isDirectory()) {
      hash.update(`directory:${relative}\n`);
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (stat.size > 64 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error("native_runtime_pin_mismatch");
      hash.update(`file:${relative}:${stat.mode & 0o111}\n`);
      hash.update(await fs.readFile(file)); hash.update("\n");
    } else throw new Error("native_runtime_pin_mismatch");
  }
  await visit(root, "");
  return hash.digest("hex");
}
