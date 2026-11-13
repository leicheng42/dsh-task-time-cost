import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const archive = resolve(process.argv[2] ?? join(root, `release/${project.name}-${project.version}.tgz`));
const artifacts = join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
function tar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}
const files = tar(['-tzf', archive]).trim().split(/\r?\n/).filter(Boolean);
for (const file of files) {
  assert.ok(file.startsWith('package/') && !file.includes('\\') && !file.split('/').includes('..'), `Unsafe archive entry: ${file}`);
  assert.ok(!/(?:^|\/)(?:node_modules|\.env|\.credentials[^/]*|artifacts|tests|release)(?:\/|$)/.test(file), `Private/unwanted archive entry: ${file}`);
  assert.ok(!/package\/(?:AGENTS|PROGRESS)\.md$/.test(file), `Internal development record: ${file}`);
  assert.ok(!file.startsWith('package/docs/') || file.startsWith('package/docs/public/'), `Internal documentation: ${file}`);
}
const required = ['package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json',
  'data/baselines.json', 'data/defaults.json', 'data/prices.json', 'data/sources.json', 'README.md', 'README.en.md', 'COMPATIBILITY.md',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
  'docs/public/guide.zh.md', 'docs/public/guide.en.md', 'docs/public/privacy.md',
  'docs/public/acceptance.md', 'docs/public/publishing.md', 'docs/public/DETAIL.md', 'docs/public/DETAIL.zh.md', 'docs/public/preview.svg'];
for (const file of required) assert.ok(files.includes(`package/${file}`), `Missing ${file}`);
const extracted = await mkdtemp(join(artifacts, 'package-check-'));
tar(['-xzf', archive, '-C', extracted]);
const packageRoot = join(extracted, 'package');
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'dsh-task-time-cost');
assert.equal(manifest.engines.dsh, '0.2.2-rc.2');
assert.deepEqual(manifest.dsh.client.external, ['react']);
assert.equal(manifest.scripts?.preinstall, undefined);
assert.equal(manifest.scripts?.postinstall, undefined);
const host = await import(pathToFileURL(join(packageRoot, 'lib/index.js')).href);
assert.equal(typeof host.apply, 'function');
assert.equal(typeof host.Config, 'function');
assert.equal(host.name, 'task-time-cost');
const require = createRequire(import.meta.url);
let registered = 0;
vm.runInNewContext(await readFile(join(packageRoot, 'lib/client.js'), 'utf8'), {
  window: { __ModuleLoader__: { load({ id, factory }) {
    assert.equal(id, manifest.name);
    const client = factory(name => { assert.equal(name, 'react'); return require('react'); });
    assert.equal(typeof client.apply, 'function');
    assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'remote']);
    registered += 1;
  } } }, console, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
});
assert.equal(registered, 1);
const meta = JSON.parse(await readFile(join(artifacts, 'build-metafile.json'), 'utf8'));
for (const [target, allowed] of [['host', ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-typert-protocol']], ['client', ['react']]]) {
  for (const output of Object.values(meta[target].outputs)) for (const item of output.imports) {
    if (item.external && !item.path.startsWith('node:')) assert.ok(allowed.includes(item.path), `Unexpected ${target} external: ${item.path}`);
  }
  for (const source of Object.keys(meta[target].inputs)) if (source.includes('node_modules/')) assert.ok(source.includes('/zod/') || source.startsWith('node_modules/react-dom/'), `Review bundled third-party license: ${source}`);
}
let links = 0;
for (const file of files.filter(file => file.endsWith('.md'))) {
  const path = join(extracted, file);
  const markdown = await readFile(path, 'utf8');
  assert.ok(!/[A-Z]:[\\/]Users[\\/]|[A-Z]:[\\/]桌面[\\/]|127\.0\.0\.1:\d+|nativeWindowHandle|MCP\d{2,}/i.test(markdown), `Machine-specific/private narrative: ${file}`);
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const destination = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!destination || /^[a-z][a-z+.-]*:/i.test(destination)) continue;
    await access(resolve(dirname(path), decodeURIComponent(destination)));
    links += 1;
  }
}
const decode = bytes => bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').replace(/\u001b\[[0-9;]*m/g, '');
for (const source of ['isolated-enabled.yml', 'isolated-disabled.yml', 'isolated-config-schema.json']) {
  const content = decode(await readFile(join(artifacts, source)));
  await writeFile(join(artifacts, source.replace(/(\.[^.]+)$/, '.utf8$1')), content, 'utf8');
}
const cleanInstallLog = decode(await readFile(join(artifacts, 'final-ci.txt')));
assert.match(cleanInstallLog, /\badded \d+ packages?\b/, 'Run a clean npm ci before the final release checks');
const rawLog = await readFile(join(artifacts, 'final-check-raw.txt'));
const checkLog = decode(rawLog);
assert.ok(checkLog.includes(`> ${project.name}@${project.version} check`), 'The release check must match the current project version');
const totalTests = Number(/\btests (\d+)/.exec(checkLog)?.[1]);
const passedTests = Number(/\bpass (\d+)/.exec(checkLog)?.[1]);
assert.ok(totalTests >= 160, `Core, accuracy and real Gateway activation regressions must run (found ${totalTests})`);
assert.equal(passedTests, totalTests);
assert.match(checkLog, /fail 0/);
assert.match(checkLog, /skipped 0/);
await writeFile(join(artifacts, 'final-check.txt'), checkLog, 'utf8');
const bytes = await readFile(archive);
const report = { verifiedAt: new Date().toISOString(), name: manifest.name, version: manifest.version,
  archive, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), files: files.length,
  localDocumentLinks: links, cleanDependencyInstall: 'passed', tests: { total: totalTests, passed: passedTests, failed: 0, skipped: 0 },
  hostImport: 'passed', clientFactory: 'passed', bundledLicenseReview: 'passed', extracted,
  boundaries: ['Module import/factory execution is not real GUI or full Host lifecycle acceptance.', 'No model request or additional server was started.'] };
await writeFile(join(artifacts, 'package-verification.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
