import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, link, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LIMITS } from '../src/index.mjs';

const cli = join(import.meta.dirname, '../bin/changelog-release-sync.mjs');
const pkg = { name: 'sample-package', version: '1.2.0' };
const tags = { schemaVersion: '1', tags: ['v1.0.0', 'v1.2.0'] };
const changelog = '# Changelog\n\n## [1.2.0]\nNew release.\n\n## [1.0.0]\nFirst release.\n';
const run = (root, ...extra) => spawnSync(process.execPath, [cli, '--root', root, '--package', 'package.json', '--tags', 'tags.json', '--changelog', 'CHANGELOG.md', ...extra], { encoding: 'utf8', env: process.env });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'release-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(root, 'tags.json'), JSON.stringify(tags));
  await writeFile(join(root, 'CHANGELOG.md'), changelog);
  return root;
}

test('CLI matching release evidence exits 0 with deterministic JSON only', async t => {
  const root = await fixture(t); const a = run(root), b = run(root);
  assert.equal(a.status, 0); assert.equal(a.stdout, b.stdout); assert.equal(a.stderr, '');
  assert.equal(JSON.parse(a.stdout).status, 'pass');
});

test('CLI missing release entry exits 1 without creating a tag or release', async t => {
  const root = await fixture(t); await writeFile(join(root, 'tags.json'), JSON.stringify({ schemaVersion: '1', tags: [...tags.tags, 'v1.1.0'] }));
  const before = await readFile(join(root, 'tags.json')); const result = run(root);
  assert.equal(result.status, 1); assert.ok(JSON.parse(result.stdout).findings.some(f => f.ruleId === 'tag-entry-missing'));
  assert.deepEqual(await readFile(join(root, 'tags.json')), before);
});

test('CLI reports a local unpublished version without inventing a missing tag', async t => {
  const root = await fixture(t); await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.3.0' }));
  await writeFile(join(root, 'CHANGELOG.md'), changelog + '\n## [1.3.0]\nLocal only.\n');
  const result = run(root);
  assert.equal(result.status, 0); assert.ok(JSON.parse(result.stdout).findings.some(f => f.ruleId === 'local-unpublished'));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'tags.json'), 'utf8')).tags, tags.tags);
});

test('CLI strict UTF-8 and missing evidence produce incomplete reports with fixed provenance', async t => {
  const root = await fixture(t);
  for (const [name, role] of [['package.json', '@package'], ['tags.json', '@tags'], ['CHANGELOG.md', '@changelog']]) {
    const before = await readFile(join(root, name)); await writeFile(join(root, name), Buffer.from([0xff]));
    const result = run(root); assert.equal(result.status, 2);
    const finding = JSON.parse(result.stdout).findings[0];
    assert.equal(finding.ruleId, 'input-unreadable'); assert.equal(finding.location.file, role);
    await writeFile(join(root, name), before);
  }
  await rm(join(root, 'tags.json'));
  const missing = run(root);
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).findings[0].location.file, '@tags');
});

test('CLI each input byte bound accepts exact N and refuses N+1', async t => {
  const root = await fixture(t);
  for (const [name, base] of [['package.json', JSON.stringify(pkg)], ['tags.json', JSON.stringify(tags)], ['CHANGELOG.md', changelog]]) {
    await writeFile(join(root, name), base + ' '.repeat(LIMITS.bytes - Buffer.byteLength(base)));
    assert.equal(run(root).status, 0);
    await writeFile(join(root, name), base + ' '.repeat(LIMITS.bytes + 1 - Buffer.byteLength(base)));
    const result = run(root); assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).findings[0].ruleId, 'byte-limit');
    await writeFile(join(root, name), base);
  }
});

test('CLI invalid option has empty stdout and input symlink cannot escape root', async t => {
  const root = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'release-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const bad = run(root, '--unknown'); assert.equal(bad.status, 2); assert.equal(bad.stdout, '');
  await writeFile(join(outside, 'tags.json'), JSON.stringify(tags));
  await rm(join(root, 'tags.json')); await symlink(join(outside, 'tags.json'), join(root, 'tags.json'));
  const escaped = run(root); assert.equal(escaped.status, 2); assert.equal(JSON.parse(escaped.stdout).status, 'incomplete');
});

test('CLI allows ordinary output but refuses destination symlink and parent escape', async t => {
  const root = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'release-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const allowed = run(root, '--out', 'report.json');
  assert.equal(allowed.status, 0); assert.equal(await readFile(join(root, 'report.json'), 'utf8'), allowed.stdout);
  await writeFile(join(outside, 'sentinel.json'), 'unchanged'); await symlink(join(outside, 'sentinel.json'), join(root, 'linked.json'));
  const linked = run(root, '--out', 'linked.json'); assert.equal(linked.status, 2); assert.equal(linked.stdout, '');
  assert.equal(await readFile(join(outside, 'sentinel.json'), 'utf8'), 'unchanged');
  await symlink(outside, join(root, 'escape'));
  const escaped = run(root, '--out', 'escape/report.json'); assert.equal(escaped.status, 2); assert.equal(escaped.stdout, '');
  await assert.rejects(stat(join(outside, 'report.json')));
});

test('CLI refuses hard links to every input and missing-input aliases including symlinked parent', async t => {
  const root = await fixture(t);
  for (const name of ['package.json', 'tags.json', 'CHANGELOG.md']) {
    await link(join(root, name), join(root, 'hard.json'));
    const before = await readFile(join(root, name)); const result = run(root, '--out', 'hard.json');
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.deepEqual(await readFile(join(root, name)), before);
    await rm(join(root, 'hard.json'));
  }
  await rm(join(root, 'tags.json')); await symlink(root, join(root, 'alias'));
  for (const dest of ['tags.json', 'alias/tags.json']) {
    const result = run(root, '--out', dest);
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    await assert.rejects(stat(join(root, 'tags.json')));
  }
});
