import fs from "node:fs/promises";
import { nativeAbsolutePath } from "@paperclipai/adapter-utils/native-provider-adapter";
/** Nonsecret filesystem generation, NOT a credential-content hash. Ordinary
 * login/refresh/rotation/replacement invalidates it. Owner records the association
 * on the company secret; tasks cannot mint or alter that association. */
export async function nativeCredentialGeneration(homeValue: unknown, fileValue: unknown): Promise<string> {
  const home = nativeAbsolutePath(homeValue), file = nativeAbsolutePath(fileValue);
  if (!file.startsWith(home + "/") || await fs.realpath(home) !== home || await fs.realpath(file) !== file) throw new Error("native_credential_binding_missing");
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144n || (stat.mode & 0o077n) !== 0n) throw new Error("native_credential_binding_missing");
  return `fs:${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.ctimeNs}:${stat.size}`;
}
