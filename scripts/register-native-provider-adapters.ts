import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Explicit owner command. No import-time registration, npm fetch, or inference.
export async function registerNativeAdapters({root = path.resolve(fileURLToPath(new URL('..', import.meta.url))), store = undefined} = {}) {
  const proposed = [];
  for (const [name,type] of [['cline-local','cline_local'],['commandcode-local','commandcode_local']]) {
    const localPath = await fs.realpath(path.join(root,'packages','adapters',name));
    const pkg = JSON.parse(await fs.readFile(path.join(localPath,'package.json'),'utf8'));
    if (pkg.name !== `@aif/adapter-${name}` || pkg.version !== '0.1.0') throw new Error('native_plugin_package_mismatch');
    await fs.access(path.join(localPath,'dist','ui-parser.cjs'));
    // Absolute compiled entry avoids workspace source exports at the plugin root.
    const module = await import(pathToFileURL(path.join(localPath,'dist','index.js')).href);
    if (typeof module.createServerAdapter !== 'function' || module.createServerAdapter().type !== type) throw new Error('native_plugin_entry_mismatch');
    proposed.push({packageName:pkg.name,version:pkg.version,type,localPath,installedAt:new Date().toISOString()});
  }
  if (!store) {
    const home = process.env.PAPERCLIP_HOME;
    if (!home || !path.isAbsolute(home)) throw new Error('native_plugin_owner_home_required');
    // The existing store intentionally tolerates corrupt JSON. This owner command
    // must not overwrite it as an empty registry.
    try {
      const raw = JSON.parse(await fs.readFile(path.join(home,'adapter-plugins.json'),'utf8'));
      if (!Array.isArray(raw) || raw.some(record => !record || typeof record.type !== 'string')) throw new Error('native_plugin_store_invalid');
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('native_plugin_store_invalid'); }
    store = await import(pathToFileURL(path.join(root,'server','dist','services','adapter-plugin-store.js')).href);
  }
  const records = store.listAdapterPlugins();
  for (const record of proposed) {
    const matches = records.filter(existing => existing.type === record.type);
    if (matches.length > 1 || matches.some(existing => existing.packageName !== record.packageName || existing.localPath !== record.localPath || existing.version !== record.version)) throw new Error('native_plugin_registration_conflict');
  }
  for (const record of proposed) if (!records.some(existing => existing.type === record.type)) store.addAdapterPlugin(record);
  return proposed.map(({type,packageName,version,localPath}) => ({type,packageName,version,localPath}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--apply')) throw new Error('native_plugin_owner_apply_required');
  console.log(JSON.stringify(await registerNativeAdapters()));
}
