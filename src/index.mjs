export const TOOL_ID = 'changelog-release-sync';
export const LIMITS = Object.freeze({ bytes: 1_048_576, records: 1000, depth: 16, milliseconds: 5000 });
export const RULE_SEVERITY = Object.freeze({
  'input-unreadable': 'error', 'byte-limit': 'error', 'depth-limit': 'error', 'time-limit': 'error',
  'record-limit': 'error', 'package-invalid': 'error', 'tag-export-invalid': 'error', 'tag-export-incomplete': 'error',
  'tag-invalid': 'error', 'entry-invalid': 'error', 'tag-duplicate': 'error',
  'entry-duplicate': 'error', 'tag-entry-missing': 'error', 'entry-tag-missing': 'error',
  'package-entry-missing': 'error', 'package-tag-missing': 'error', 'package-version-behind': 'error',
  'entry-version-ahead': 'error', 'local-unpublished': 'info'
});
const INCOMPLETE = new Set(['input-unreadable', 'byte-limit', 'depth-limit', 'time-limit', 'record-limit', 'package-invalid', 'tag-export-invalid', 'tag-export-incomplete', 'tag-invalid', 'entry-invalid']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const VERSION = '(?:0|[1-9]\\d{0,8})\\.(?:0|[1-9]\\d{0,8})\\.(?:0|[1-9]\\d{0,8})';
const versionPattern = new RegExp(`^${VERSION}$`);
const tagPattern = new RegExp(`^v(${VERSION})$`);
const headingPattern = new RegExp(`^## \\[(${VERSION})\\]$`);
const parsedVersion = x => versionPattern.test(x) ? x.split('.').map(Number) : null;
function versionCompare(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; }
function tooDeep(input) {
  const stack = [[input, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (depth > LIMITS.depth) return true;
    if (value && typeof value === 'object') for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  return false;
}
function finding(findings, ruleId, file, pointer, message) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new Error('Unknown rule');
  findings.push({ ruleId, severity: RULE_SEVERITY[ruleId], message, location: { file, pointer } });
}
function report(findings, checked) {
  findings.sort((a, b) => cmp(a.location.file, b.location.file) || cmp(a.location.pointer, b.location.pointer) || cmp(a.ruleId, b.ruleId));
  const status = findings.some(f => INCOMPLETE.has(f.ruleId)) ? 'incomplete' : findings.some(f => f.severity === 'error') ? 'fail' : 'pass';
  return { schemaVersion: '1', tool: TOOL_ID, status, summary: { checked, errors: findings.filter(f => f.severity === 'error').length, warnings: 0 }, findings };
}
export function incomplete(ruleId, file, message) {
  const findings = [];
  finding(findings, ruleId, file, '', message);
  return report(findings, 0);
}

export function auditReleases(input, { now = () => performance.now() } = {}) {
  const started = now();
  if (!object(input) || !object(input.packageMeta) || !parsedVersion(input.packageMeta.version)) return incomplete('package-invalid', '@package', 'Local package version must be a supported stable version.');
  if (!object(input.tagsExport) || input.tagsExport.schemaVersion !== '1' || !Array.isArray(input.tagsExport.tags)) return incomplete('tag-export-invalid', '@tags', 'A version 1 tag export with a tags array is required.');
  if (Object.hasOwn(input.tagsExport, 'complete') && input.tagsExport.complete !== true) return incomplete('tag-export-incomplete', '@tags', 'Tag export explicitly declares incomplete evidence.');
  if (typeof input.changelog !== 'string') return incomplete('entry-invalid', '@changelog', 'Changelog Markdown is required.');
  if (tooDeep({ packageMeta: input.packageMeta, tagsExport: input.tagsExport })) return incomplete('depth-limit', '@package', 'JSON evidence exceeds nesting depth 16.');
  if (input.tagsExport.tags.length > LIMITS.records) return incomplete('record-limit', '@tags', 'Tag export exceeds 1000 tags.');
  const lines = input.changelog.split(/\r?\n/), headings = [], entries = new Map(), tags = new Map(), findings = [];
  for (const [i, line] of lines.entries()) {
    if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', '@changelog', 'Evaluation exceeded 5000 milliseconds.');
    if (!/^ {0,3}##(?:[ \t]|$)/.test(line)) continue;
    if (line === '## [Unreleased]') continue;
    const match = headingPattern.exec(line);
    if (!match) { finding(findings, 'entry-invalid', '@changelog', `line:${i + 1}`, 'Release heading is not a supported stable version.'); continue; }
    headings.push({ version: match[1], line: i + 1 });
    if (headings.length > LIMITS.records) return incomplete('record-limit', '@changelog', 'Changelog exceeds 1000 release headings.');
    if (entries.has(match[1])) finding(findings, 'entry-duplicate', '@changelog', `line:${i + 1}`, 'Release version is repeated in the changelog.');
    else entries.set(match[1], i + 1);
  }
  for (const [i, raw] of input.tagsExport.tags.entries()) {
    if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', '@tags', 'Evaluation exceeded 5000 milliseconds.');
    const match = typeof raw === 'string' ? tagPattern.exec(raw) : null;
    if (!match) { finding(findings, 'tag-invalid', '@tags', `/tags/${i}`, 'Tag is not a supported stable release tag.'); continue; }
    if (tags.has(match[1])) finding(findings, 'tag-duplicate', '@tags', `/tags/${i}`, 'Release tag is duplicated.');
    else tags.set(match[1], i);
  }
  if (findings.some(f => INCOMPLETE.has(f.ruleId))) return report(findings, 0);
  const local = input.packageMeta.version, localParts = parsedVersion(local);
  let greatest = null;
  for (const version of tags.keys()) {
    if (greatest === null || versionCompare(parsedVersion(version), parsedVersion(greatest)) > 0) greatest = version;
    if (!entries.has(version)) finding(findings, 'tag-entry-missing', '@tags', `/tags/${tags.get(version)}`, 'Release tag has no changelog entry.');
  }
  const localIsAhead = greatest === null || versionCompare(localParts, parsedVersion(greatest)) > 0;
  for (const [version, line] of entries) {
    if (versionCompare(parsedVersion(version), localParts) > 0) finding(findings, 'entry-version-ahead', '@changelog', `line:${line}`, 'Changelog release is newer than local package version.');
    if (!tags.has(version) && !(version === local && localIsAhead)) finding(findings, 'entry-tag-missing', '@changelog', `line:${line}`, 'Historical changelog release has no matching tag.');
  }
  if (greatest !== null && versionCompare(localParts, parsedVersion(greatest)) < 0) finding(findings, 'package-version-behind', '@package', '/version', 'Local package version is older than a release tag.');
  if (!entries.has(local)) finding(findings, 'package-entry-missing', '@package', '/version', 'Local package version has no changelog entry.');
  if (!tags.has(local)) {
    if (localIsAhead && entries.has(local)) finding(findings, 'local-unpublished', '@package', '/version', 'Current package version is local and unpublished; no tag was inferred.');
    else if (!localIsAhead) finding(findings, 'package-tag-missing', '@package', '/version', 'Local package version has no matching release tag.');
  }
  return report(findings, 1 + tags.size + headings.length);
}
