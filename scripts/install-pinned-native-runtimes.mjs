import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const NATIVE_CLI_PINS = [
  { name: 'cline', version: '3.0.70', integrity: 'sha512-ekeGJ7YdVKL9p//KF0F5nxFXMvgSuhwPxvCUkS+SaBDJJoOUt+HMeJS+J+hkF3ezPekbSvpK1wCPGraZbAEO8A==' },
  { name: 'command-code', version: '1.79.2', integrity: 'sha512-e7seLyyriUJtK5MArViSVRekCmRP5VCZrHgoURWayH7agAwvsE+nq+c0rt1dzVs/iD/lc5cMZLu9I0+SZnPORA==' },
];
export function assertIntegrity(bytes, expected) {
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== expected) throw new Error('native_package_integrity_mismatch');
}
// Build-time only. Never imported by heartbeat or executed at controller startup.
export async function installPinnedNativeRuntimes() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aif-native-tarballs-'));
  try {
    for (const pin of NATIVE_CLI_PINS) {
      const output = execFileSync('npm', ['pack', `${pin.name}@${pin.version}`, '--json', '--ignore-scripts'], {cwd:temporary,timeout:120000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
      const rows = JSON.parse(output.toString());
      if (rows.length !== 1 || rows[0].version !== pin.version || path.basename(rows[0].filename) !== rows[0].filename) throw new Error('native_package_pin_mismatch');
      const tarball = path.join(temporary,rows[0].filename);
      assertIntegrity(await fs.readFile(tarball),pin.integrity);
      // CLI packages may require their install lifecycle to unpack native assets;
      // it runs only after the exact candidate tarball was verified, in image build.
      execFileSync('npm',['install','--global','--omit=dev',tarball],{timeout:120000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
    }
  } catch { throw new Error('native_pinned_install_failed'); }
  finally { await fs.rm(temporary,{recursive:true,force:true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await installPinnedNativeRuntimes();
