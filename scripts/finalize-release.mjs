import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
const release = join(root, 'release');
const readJson = async name => JSON.parse(await readFile(join(artifacts, name), 'utf8'));
async function optionalProof(name) {
  try { return await readJson(name); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function status(value, label) {
  if (value === undefined) return 'not-verified';
  assert.ok(['passed', 'failed', 'not-verified'].includes(value), `Invalid evidence status: ${label}`);
  return value;
}
function combined(values) {
  return values.every(value => value === 'passed') ? 'passed' : values.includes('failed') ? 'failed' : 'not-verified';
}
function count(value, label) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, `Invalid evidence count: ${label}`);
  return value;
}

const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(project.name, 'dsh-task-time-cost');
assert.ok(typeof project.version === 'string' && project.version.length > 0);
assert.notEqual(project.version, '0.1.0', 'Version 0.1.0 was withdrawn after a real Client startup failure');
const archiveReport = await readJson('package-verification.json');
const isolatedReport = await readJson('isolated-verification.json');
assert.equal(archiveReport.name, project.name);
assert.equal(archiveReport.version, project.version, 'Rebuild and verify the current package before finalizing');
assert.equal(archiveReport.cleanDependencyInstall, 'passed', 'The final archive needs clean dependency-install evidence');
const archive = join(release, `${project.name}-${project.version}.tgz`);
assert.equal(resolve(root, archiveReport.archive), resolve(archive), 'The verified archive must be the current release artifact');
const bytes = await readFile(archive);
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256, archiveReport.sha256);
assert.equal(sha256, isolatedReport.archiveSha256, 'Isolated verification must cover these exact archive bytes');
assert.equal(bytes.length, archiveReport.bytes);
assert.ok(count(archiveReport.files, 'archive.files') > 0);
assert.equal(isolatedReport.byteMatchedFiles, archiveReport.files);
count(archiveReport.localDocumentLinks, 'archive.localDocumentLinks');
if (isolatedReport.version !== undefined) assert.equal(isolatedReport.version, project.version);
if (isolatedReport.bytes !== undefined) assert.equal(isolatedReport.bytes, bytes.length);
for (const key of ['hostImport', 'clientFactory', 'bundledLicenseReview']) assert.equal(archiveReport[key], 'passed');
for (const key of ['configImport', 'enabledComposition', 'disabledComposition']) assert.equal(isolatedReport[key], 'passed');

const checkLog = (await readFile(join(artifacts, 'final-check.txt'), 'utf8')).replace(/^\uFEFF/, '').replace(/\u001b\[[0-9;]*m/g, '');
function testMetric(key) {
  const matches = [...checkLog.matchAll(new RegExp(`^[\\t ]*(?:ℹ[\\t ]*|#[\\t ]*)?${key}[\\t ]+(\\d+)[\\t ]*\\r?$`, 'gm'))];
  assert.equal(matches.length, 1, `Expected one complete test summary for ${key}`);
  return count(Number(matches[0][1]), `tests.${key}`);
}
const tests = { total: testMetric('tests'), passed: testMetric('pass'), failed: testMetric('fail'),
  skipped: testMetric('skipped'), cancelled: testMetric('cancelled'), todo: testMetric('todo') };
assert.ok(tests.total > 0, 'The full test suite must run');
assert.equal(tests.passed, tests.total);
for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(tests[key], 0, `Tests must have no ${key} cases`);
const logLines = checkLog.split(/\r?\n/).map(line => line.trim());
for (const command of ['check', 'typecheck', 'test', 'build']) {
  assert.ok(logLines.includes(`> ${project.name}@${project.version} ${command}`), `Missing current-version ${command} evidence`);
}
assert.ok(logLines.includes(`> ${project.scripts.check}`), 'The logged check must use the current complete check command');
assert.ok(logLines.includes(`> ${project.scripts.typecheck}`));
assert.ok(logLines.includes(`Built ${project.name}@${project.version}: Host ESM and DSH Client factory.`), 'Missing current-version build evidence');
assert.equal(isolatedReport.profile, 'estimator-verify');
const profile = JSON.parse(await readFile(join(artifacts, 'isolated-dsh/profiles/estimator-verify/package.json'), 'utf8'));
assert.equal(profile.dependencies?.[project.name], undefined);
assert.deepEqual(profile.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']);

// Optional human-observed UI evidence is separate from archive import/factory checks.
// Missing evidence remains unknown; a malformed or stale proof is not silently accepted.
const ui = await optionalProof('ui-verification.json');
if (ui !== null) {
  assert.equal(ui.schemaVersion, 1);
  assert.equal(ui.version, project.version, 'UI evidence must cover the current Client version');
}
const coldClientBoot = status(ui?.coldClientBoot, 'coldClientBoot');
const slots = Object.fromEntries(['composerDock', 'completedAction'].map(key => [key, status(ui?.slots?.[key], `slots.${key}`)]));
const userRequirements = Object.fromEntries(['inlineRunningEta', 'nativeBottomNoCrowding', 'officialCardStyle', 'completedDurationOnly', 'compactEta', 'aiPlanIntegration', 'tokenBudgetTiming', 'retainedEtaReference', 'estimatedTokenDetails', 'automaticPriceReference']
  .map(key => [key, status(ui?.userRequirements?.[key], `userRequirements.${key}`)]));
const management = Object.fromEntries(['read', 'saveConfig', 'importBaselines', 'export', 'resetCalibration']
  .map(key => [key, status(ui?.management?.[key], `management.${key}`)]));
const visual = Object.fromEntries(['light', 'dark', 'narrow', 'keyboard'].map(key => [key, status(ui?.visual?.[key], `visual.${key}`)]));
const lifecycle = Object.fromEntries(['bundleUnmount', 'bundleRemount'].map(key => [key, status(ui?.lifecycle?.[key], `lifecycle.${key}`)]));
// These requirements already exist in the release checklist. A few screenshots
// or historical management actions cannot silently stand in for all of them.
const acceptanceDetails = Object.fromEntries(['managementFlows', 'feedbackPaths', 'viewportAndMotion', 'detailedScreenshots', 'pollingAndRequestCleanup']
  .map(key => [key, status(ui?.acceptanceDetails?.[key], `acceptanceDetails.${key}`)]));
const pluginErrors = ui?.console?.pluginErrors == null ? null : count(ui.console.pluginErrors, 'console.pluginErrors');
const unrelatedErrors = ui?.console?.unrelatedErrors == null ? null : count(ui.console.unrelatedErrors, 'console.unrelatedErrors');
const consoleStatus = pluginErrors === null ? 'not-verified' : pluginErrors === 0 ? 'passed' : 'failed';
const consoleNote = ui?.console?.note ?? null;
assert.ok(consoleNote === null || typeof consoleNote === 'string');
const screenshots = ui?.visual?.screenshots ?? null;
assert.ok(screenshots === null || Array.isArray(screenshots), 'UI screenshot evidence must be an array');
if (screenshots) for (const item of screenshots) {
  assert.ok((typeof item === 'string' && item.length > 0) || (item && typeof item === 'object' && typeof item.path === 'string' && item.path.length > 0), 'Screenshots must identify actual evidence paths');
}
const uiBoundaries = ui?.boundary ?? [];
assert.ok(Array.isArray(uiBoundaries) && uiBoundaries.every(value => typeof value === 'string'));

const storedRetentionProof = await optionalProof('desktop-retention.json');
const retentionProof = storedRetentionProof?.version === project.version ? storedRetentionProof : null;
function retentionPhase(key) {
  const proof = retentionProof?.[key];
  if (proof === undefined) return { status: 'not-verified' };
  assert.ok(proof && typeof proof === 'object');
  for (const field of ['priorFiles', 'missingFiles', 'changedFiles', 'priorCallFiles']) count(proof[field], `${key}.${field}`);
  assert.ok(proof.priorCallFiles <= proof.priorFiles);
  assert.equal(typeof proof.callBytesPreserved, 'boolean');
  assert.ok(typeof proof.checkedAt === 'string' && Number.isFinite(Date.parse(proof.checkedAt)));
  assert.equal(typeof proof.scope, 'string');
  const failed = proof.missingFiles > 0 || proof.changedFiles > 0 || !proof.callBytesPreserved;
  return { ...proof, status: failed ? 'failed' : proof.priorFiles > 0 && proof.priorCallFiles > 0 ? 'passed' : 'not-verified' };
}
const afterRemove = retentionPhase('after-remove');
const afterInstall = retentionPhase('after-install');
if (afterRemove.checkedAt && afterInstall.checkedAt) {
  assert.ok(Date.parse(afterRemove.checkedAt) <= Date.parse(afterInstall.checkedAt));
  assert.equal(afterInstall.priorFiles, afterRemove.priorFiles);
  assert.equal(afterInstall.priorCallFiles, afterRemove.priorCallFiles);
}
const retentionStatus = combined([afterRemove.status, afterInstall.status]);
const remainingGates = [];
function gate(label, result) { if (result !== 'passed') remainingGates.push(`${label} (${result})`); }
gate('Actual cold Client boot', coldClientBoot);
for (const [key, result] of Object.entries(slots)) gate(`Actual Client slot: ${key}`, result);
for (const [key, result] of Object.entries(userRequirements)) gate(`User requirement: ${key}`, result);
gate('Actual Client console inspection', consoleStatus);
for (const [key, result] of Object.entries(management)) gate(`Actual management interaction: ${key}`, result);
for (const [key, result] of Object.entries(visual)) gate(`Actual visual/keyboard verification: ${key}`, result);
for (const [key, result] of Object.entries(lifecycle)) gate(`Actual Client lifecycle: ${key}`, result);
for (const [key, result] of Object.entries(acceptanceDetails)) gate(`Remaining checklist coverage: ${key}`, result);
if (screenshots === null || screenshots.length < 3) remainingGates.push(`Three screenshots from the real plugin (not-verified; ${screenshots?.length ?? 'unknown'} recorded in UI proof)`);
gate('Actual Desktop uninstall/reinstall retention with historical calls', retentionStatus);

const report = {
  format: 'dsh-task-time-cost-local-verification-v1',
  verifiedAt: new Date().toISOString(),
  name: project.name,
  version: project.version,
  artifact: basename(archive),
  bytes: bytes.length,
  sha256,
  target: { dsh: project.engines.dsh, node: project.engines.node, platform: 'Windows Desktop' },
  p0Complete: remainingGates.length === 0,
  releaseNotes: [`${project.version} separates public documentation from private development records, audits packed privacy boundaries, and focuses invalid management fields. Algorithm and historical valuations are preserved. Current UI, lifecycle and original P0 gates retain version-scoped evidence.`, 
    'Known Token subtotals remain visible when other calls report no usage; incomplete coverage never becomes an exact total.',
    'Obsolete loaded-session summaries are recomputed and saved once, retaining initial forecasts and historical price resolutions.',
    'Current UI, lifecycle and historical-data checks keep their version-specific evidence; missing observations are not-verified. Exact running-line ETA remains an open requirement.',
    'Version 0.1.0 is withdrawn and must not be installed or delivered; its archive and checksum are superseded.'],
  withdrawnVersions: ['0.1.0'],
  checks: {
    cleanDependencyInstall: archiveReport.cleanDependencyInstall,
    strictTypes: 'passed',
    tests: { ...tests, scope: 'Offline synthetic/replay and actual Cordis/JSON backend and Gateway activation integration.' },
    hostBuild: 'passed',
    clientFactoryBuild: 'passed',
    archive: { files: archiveReport.files, localDocumentLinks: archiveReport.localDocumentLinks,
      hostImport: archiveReport.hostImport, clientFactoryExecution: archiveReport.clientFactory, bundledLicenseReview: archiveReport.bundledLicenseReview },
    isolatedCli: { archiveInstall: 'passed', byteMatchedFiles: isolatedReport.byteMatchedFiles,
      configImport: isolatedReport.configImport, enabledComposition: isolatedReport.enabledComposition, disabledComposition: isolatedReport.disabledComposition,
      uninstall: 'passed', baseBundlesPreserved: true,
      boundary: isolatedReport.boundary },
    desktopRetention: { status: retentionStatus, evidence: retentionProof === null ? null : 'artifacts/desktop-retention.json', afterRemove, afterInstall },
    realClient: { evidence: ui === null ? null : 'artifacts/ui-verification.json', version: ui?.version ?? null,
      coldClientBoot, slots, userRequirements, mount: combined([coldClientBoot, ...Object.values(slots)]),
      console: { status: consoleStatus, pluginErrors, unrelatedErrors, note: consoleNote },
      management, interactions: combined(Object.values(management)), lifecycle, acceptanceDetails,
      evidenceSources: ui?.evidenceSources ?? null,
      visual: { ...visual, screenshots }, themesAndNarrowLayout: combined([visual.light, visual.dark, visual.narrow]),
      screenshots: screenshots?.length ?? null },
    onlineAccuracy: 'not-measured',
    providerComparison: 'not-measured',
    observerOverhead: 'not-measured',
  },
  blockingCondition: remainingGates.length ? 'P0 acceptance evidence remains incomplete; see remainingGates and the recorded proof statuses.' : null,
  remainingGates,
  boundaries: ['Module import/factory execution is not real Client apply or screenshot acceptance.',
    'CLI composition and installed-byte checks are not a complete Host task lifecycle.',
    'Desktop historical-retention evidence is independent of the isolated CLI profile.',
    'UI states and screenshot references come only from the actual UI proof; missing observations stay not-verified.',
    'Engineering timing priors are assumptions. Public catalog prices are list-price references; explicit user rates take precedence, and relay or subscription bills can differ.',
    'No npm, GitHub or marketplace publication was performed.', ...uiBoundaries],
};
await mkdir(release, { recursive: true });
await writeFile(join(release, 'SHA256SUMS.txt'), `${sha256}  ${report.artifact}\n`, 'utf8');
await writeFile(join(release, 'verification.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
