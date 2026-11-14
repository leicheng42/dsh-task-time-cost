import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir, open, realpath } from 'node:fs/promises';
import { join, resolve, dirname, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root = await realpath(process.cwd());
const require = createRequire(join(root, 'package.json'));
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const archive = await realpath(process.argv[2] ?? join(root, 'artifacts', 'prebuilt', `${source.name}-${source.version}.tgz`));
const cliPackage = require.resolve('@deepseek-ai/dsh/package.json');
const cliManifest = JSON.parse(await readFile(cliPackage, 'utf8'));
const sdk = cliManifest.version;
assert.ok(['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3'].includes(sdk));
await mkdir(join(root, 'artifacts'), { recursive: true });
const work = await mkdtemp(join(root, 'artifacts', 'compat-smoke-'));
assert.equal(dirname(work), join(root, 'artifacts'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_') && key !== 'ELECTRON_RUN_AS_NODE'));
env.PATH = [join(root, 'node_modules', '.bin'), dirname(process.execPath), env.PATH].join(delimiter);
env.DSH_HOME = join(work, 'home');
const profileName = 'estimator-compat';
const profile = join(env.DSH_HOME, 'profiles', profileName);
await mkdir(profile, { recursive: true });
const base = '@deepseek-ai/dsh-base';
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'estimator-compat', private: true, type: 'module', dependencies: { [base]: sdk }, dsh: { profile: { bundles: [base] } } }, null, 2));
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
const cli = join(dirname(cliPackage), typeof cliManifest.bin === 'string' ? cliManifest.bin : cliManifest.bin.dsh);
async function command(label, executable, args) {
  const log = join(work, label + '.log'), fd = await open(log, 'w');
  try {
    const result = spawnSync(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', fd.fd, fd.fd] });
    assert.equal(result.status, 0, `${label}: ${result.error?.message ?? `see ${log}`}`);
  } finally { await fd.close(); }
  return await readFile(log, 'utf8');
}
async function dsh(label, args) { return command(label, process.execPath, [cli, ...args]); }
assert.ok((await dsh('version', ['--version'])).includes(sdk), 'the actual CLI must be the selected SDK');
const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true });
assert.equal(listing.status, 0, listing.error?.message ?? listing.stderr);
const files = listing.stdout.trim().split(/\r?\n/).filter(Boolean);
assert.ok(files.every(file => file.startsWith('package/') && !file.includes('\\') && !file.split('/').includes('..')));
const unpacked = join(work, 'unpacked');
await mkdir(unpacked);
await command('unpack', 'tar', ['-xzf', archive, '-C', unpacked]);
const packedRoot = join(unpacked, 'package');
const manifest = JSON.parse(await readFile(join(packedRoot, 'package.json'), 'utf8'));
assert.equal(manifest.name, source.name); assert.equal(manifest.version, source.version);
assert.equal(manifest.engines.dsh, source.engines.dsh);
assert.deepEqual(manifest.dsh.bundle.platforms, source.dsh.bundle.platforms);
const host = await import(pathToFileURL(join(packedRoot, 'lib/index.js')).href);
assert.equal(typeof host.apply, 'function'); assert.equal(typeof host.Config, 'function');
let factories = 0;
vm.runInNewContext(await readFile(join(packedRoot, 'lib/client.js'), 'utf8'), {
  window: { __ModuleLoader__: { load({ id, factory }) {
    assert.equal(id, source.name);
    const client = factory(name => { assert.equal(name, 'react'); return require('react'); });
    assert.equal(typeof client.apply, 'function'); factories++;
  } } }, console, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
});
assert.equal(factories, 1);
let matched = 0;
try {
  await dsh('install', ['plugin', '--profile', profileName, 'add', archive, '--ignore-scripts']);
  const installed = join(profile, 'node_modules', source.name);
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, source.version);
  for (const file of files) {
    const relative = file.slice('package/'.length);
    assert.deepEqual(await readFile(join(installed, relative)), await readFile(join(unpacked, file)), relative); matched++;
  }
  const config = await dsh('composition', ['--profile', profileName, '--dump-config']);
  assert.match(config, /name: dsh-task-time-cost/);
  const schema = await dsh('schema', ['--profile', profileName, '--dump-config-schema']);
  assert.ok(schema.includes('routeOverrides') && schema.includes('dsh-task-time-cost'));
  // Neither the installer nor the test grants a version exemption.
  const names = await readdir(profile);
  assert.equal(names.includes('compatibility.json'), false);
} finally {
  const current = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  if (current.dependencies?.[source.name]) await dsh('remove', ['plugin', '--profile', profileName, 'remove', source.name]);
}
const restored = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
assert.equal(restored.dependencies?.[source.name], undefined);
assert.deepEqual(restored.dsh.profile.bundles, [base]);
const report = { version: source.version, sdk, platform: process.platform, arch: process.arch, node: process.version,
  archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
  byteMatchedFiles: matched, hostImport: 'passed', clientFactory: 'passed', actualCliVersionAdmission: 'passed', configSchema: 'passed', removal: 'passed', versionExemptionGranted: false,
  boundary: 'The same prebuilt archive is imported and installed by each real SDK CLI; source tests exercise real Cordis/Gateway and JSON storage. This is not a native Desktop pixel/drag acceptance test.' };
const reportPath = join(root, 'artifacts', `compatibility-${process.platform}-${sdk}-node${process.versions.node.split('.')[0]}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
