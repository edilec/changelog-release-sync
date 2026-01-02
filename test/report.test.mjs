import test from 'node:test';
import assert from 'node:assert/strict';
import { auditReleases, TOOL_ID, LIMITS } from '../src/index.mjs';

const good = () => ({ packageMeta: { name: 'sample-package', version: '1.2.0' }, tagsExport: { schemaVersion: '1', tags: ['v1.0.0', 'v1.2.0'] }, changelog: '# Changelog\n\n## [1.2.0]\nNew release.\n\n## [1.0.0]\nFirst release.\n' });

test('matching local package, release tags, and changelog passes', () => {
  const result = auditReleases(good());
  assert.equal(TOOL_ID, 'changelog-release-sync');
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.findings, []);
});

const rules = report => report.findings.map(f => f.ruleId);

test('unpublished higher local version is labeled local and no absent tag is invented', () => {
  const input = good(); input.packageMeta.version = '1.10.0'; input.changelog += '\n## [1.10.0]\nPending local version.\n';
  const result = auditReleases(input);
  assert.equal(result.status, 'pass');
  assert.deepEqual(rules(result), ['local-unpublished']);
  assert.equal(result.findings[0].severity, 'info');
  assert.ok(!JSON.stringify(result).includes('v1.10.0'));
});

test('a local version without a changelog entry fails even when untagged', () => {
  const input = good(); input.packageMeta.version = '1.3.0';
  const result = auditReleases(input);
  assert.equal(result.status, 'fail');
  assert.deepEqual(rules(result), ['package-entry-missing']);
});

test('a tag without a changelog entry and a historical entry without a tag fail', () => {
  const missingEntry = good(); missingEntry.tagsExport.tags.push('v1.1.0');
  assert.equal(auditReleases(missingEntry).status, 'fail');
  assert.ok(rules(auditReleases(missingEntry)).includes('tag-entry-missing'));
  const missingTag = good(); missingTag.changelog += '\n## [1.1.0]\nHistorical note.\n';
  assert.equal(auditReleases(missingTag).status, 'fail');
  assert.ok(rules(auditReleases(missingTag)).includes('entry-tag-missing'));
});

test('duplicate tags and duplicate release headings fail with ordinal provenance', () => {
  const tags = good(); tags.tagsExport.tags.push('v1.2.0');
  const tagResult = auditReleases(tags);
  assert.equal(tagResult.status, 'fail');
  assert.equal(tagResult.findings.find(f => f.ruleId === 'tag-duplicate').location.pointer, '/tags/2');
  const headings = good(); headings.changelog += '\n## [1.2.0]\nRepeated.\n';
  const entryResult = auditReleases(headings);
  assert.equal(entryResult.status, 'fail');
  assert.equal(entryResult.findings.find(f => f.ruleId === 'entry-duplicate').location.pointer, 'line:9');
});

test('package version behind the greatest released tag fails using numeric version order', () => {
  const input = good(); input.packageMeta.version = '1.2.0'; input.tagsExport.tags.push('v1.10.0'); input.changelog += '\n## [1.10.0]\nLater release.\n';
  assert.equal(auditReleases(input).status, 'fail');
  assert.ok(rules(auditReleases(input)).includes('package-version-behind'));
});

test('invalid tag or heading evidence is incomplete rather than compared from a reduced index', () => {
  const badTag = good(); badTag.tagsExport.tags.push('v1.x.0');
  assert.equal(auditReleases(badTag).status, 'incomplete');
  assert.deepEqual(rules(auditReleases(badTag)), ['tag-invalid']);
  const badHeading = good(); badHeading.changelog += '\n## [v1.3.0]\nUnsupported heading.\n';
  assert.equal(auditReleases(badHeading).status, 'incomplete');
  assert.deepEqual(rules(auditReleases(badHeading)), ['entry-invalid']);
});

test('explicitly partial tag export cannot pass', () => {
  const input = good(); input.tagsExport.complete = false;
  const result = auditReleases(input);
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(rules(result), ['tag-export-incomplete']);
  assert.equal(result.summary.checked, 0);
});

test('tab-delimited level-two release heading cannot be silently ignored', () => {
  const input = { packageMeta: { version: '1.0.0' }, tagsExport: { schemaVersion: '1', tags: ['v1.0.0'] }, changelog: '## [1.0.0]\n##\t[1.1.0]\n' };
  const result = auditReleases(input);
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(rules(result), ['entry-invalid']);
  assert.equal(result.findings[0].location.pointer, 'line:2');
});

test('release-like lines inside fenced code or HTML comments are not headings', () => {
  for (const wrapper of [['```md', '```'], ['~~~md', '~~~'], ['<!--', '-->']]) {
    const input = { packageMeta: { version: '1.0.0' }, tagsExport: { schemaVersion: '1', tags: ['v1.0.0'] }, changelog: `## [1.0.0]\n${wrapper[0]}\n## [1.0.0]\n${wrapper[1]}\n` };
    const result = auditReleases(input);
    assert.equal(result.status, 'pass', wrapper[0]);
    assert.deepEqual(result.findings, []);
  }
});

test('empty tag export can describe an unpublished local release', () => {
  const input = good(); input.tagsExport.tags = []; input.changelog = '## [1.2.0]\nLocal only.\n';
  const result = auditReleases(input);
  assert.equal(result.status, 'pass');
  assert.deepEqual(rules(result), ['local-unpublished']);
});

test('untrusted package name and changelog content never appear in report', () => {
  const input = good(); input.packageMeta.name = 'secret-package-name'; input.changelog += 'private-marker\n'; input.tagsExport.tags.push('v1.1.0');
  const result = auditReleases(input);
  assert.ok(!JSON.stringify(result).includes('secret-package-name'));
  assert.ok(!JSON.stringify(result).includes('private-marker'));
  assert.equal(result.status, 'fail');
});

test('finding line 10 precedes line 2 in code-unit order', () => {
  const input = good();
  input.changelog = ['# Changelog', '## [bad]', ...Array(7).fill('body'), '## [also-bad]'].join('\n');
  const result = auditReleases(input);
  assert.deepEqual(result.findings.map(f => f.location.pointer), ['line:10', 'line:2']);
  assert.equal(result.status, 'incomplete');
});

test('record, JSON depth, and injected time accept N and refuse N+1', () => {
  const input = { packageMeta: { version: '1.999.0' }, tagsExport: { schemaVersion: '1', tags: [] }, changelog: '' };
  for (let i = 0; i < LIMITS.records; i++) { input.tagsExport.tags.push(`v1.${i}.0`); input.changelog += `## [1.${i}.0]\n`; }
  assert.equal(auditReleases(input).status, 'pass');
  input.tagsExport.tags.push('v2.0.0');
  assert.deepEqual(rules(auditReleases(input)), ['record-limit']);
  input.tagsExport.tags.pop(); input.changelog += '## [2.0.0]\n';
  assert.deepEqual(rules(auditReleases(input)), ['record-limit']);
  const nested = good(); let leaf = nested.packageMeta; for (let i = 0; i < LIMITS.depth - 1; i++) { leaf.extra = {}; leaf = leaf.extra; }
  assert.equal(auditReleases(nested).status, 'pass');
  leaf.extra = { tooDeep: true };
  assert.deepEqual(rules(auditReleases(nested)), ['depth-limit']);
  const exact = [0, LIMITS.milliseconds];
  assert.equal(auditReleases(good(), { now: () => exact.shift() ?? LIMITS.milliseconds }).status, 'pass');
  const late = [0, LIMITS.milliseconds + 1];
  assert.deepEqual(rules(auditReleases(good(), { now: () => late.shift() ?? LIMITS.milliseconds + 1 })), ['time-limit']);
});
