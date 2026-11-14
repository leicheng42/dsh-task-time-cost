import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

// Run only in an isolated CI/verification checkout. Production dependencies and
// compatibility declarations stay unchanged; each SDK row gets coherent types.
const version = process.argv[2];
assert.ok(['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3'].includes(version), 'Select a reviewed SDK release');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
for (const name of Object.keys(manifest.devDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = version;
}
manifest.devDependencies['@deepseek-ai/dsh'] = version;
manifest.devDependencies.pnpm = '11';
manifest.devDependencies.zod = version === '0.2.2-rc.1' ? '4.4.3' : '4.6.6';
await writeFile('package.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared SDK ${version}, Zod ${manifest.devDependencies.zod}; install with --ignore-scripts.`);
