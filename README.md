# Changelog Release Sync

Offline, read-only comparison of a local package version, an exported Git tag list, and changelog headings. It reports missing, mismatched, and duplicate releases without creating tags or releases. Requires Node.js 22 or newer; no package dependencies.

## Run

```sh
node bin/changelog-release-sync.mjs --root examples/passing --package package.json --tags tags.json --changelog CHANGELOG.md
node bin/changelog-release-sync.mjs --root examples/failing --package package.json --tags tags.json --changelog CHANGELOG.md
node bin/changelog-release-sync.mjs --root examples/local --package package.json --tags tags.json --changelog CHANGELOG.md
npm run check
```

The examples exit `0` (matching), `1` (tag without entry), and `0` (local unpublished, with an informational finding), respectively. `--human` adds a short stderr summary. `--out report.json` additionally writes the same JSON report within `--root`; stdout remains JSON. The output parent must already exist. Input and output names are relative to `--root`, and input realpaths must remain inside it. Output symlinks, output-parent escapes, and path or hard-link aliases to any named input are refused; refusal exits `2` with empty stdout. An ordinary existing output file may be replaced atomically. Without `--out`, no file is written.

## Input contract

`--package` is a local `package.json` with a `version` string. `--tags` is a separately exported UTF-8 JSON snapshot, such as `{"schemaVersion":"1","tags":["v1.0.0"]}`. An empty `tags` array is valid evidence of no tags in that export. Optional `complete` must be `true` if present; an explicit partial tag export never passes. The tool does not run Git, fetch tags, or infer an absent tag. `--changelog` is UTF-8 Markdown with release headings exactly `## [1.2.3]`; `## [Unreleased]` is permitted. Other level-two headings are unsupported and make the report incomplete rather than silently disappearing. Heading-like lines inside top-level backtick/tilde fences or HTML comment blocks are ignored as content, not releases. Arbitrary non-heading prose is ignored and never copied to output.

Only stable numeric `MAJOR.MINOR.PATCH` versions are supported, each component 0 to 999,999,999 without leading zeroes. Tags must be `v` plus that version; prerelease/build metadata and other tag schemes yield `incomplete` because this parser cannot safely compare them. Version order is numeric, not string order. JSON extra fields are ignored but count toward depth and byte limits.

The package version must have a changelog entry. Each tag must have one changelog entry; historical changelog releases must have a matching tag. Duplicate tags and release headings fail. A package version greater than all exported tags, with its own entry and no tag, is reported as `local-unpublished` and remains a pass if nothing else fails. A package version older than the greatest tag fails. These are snapshot comparisons, not claims that a tag is published on a remote.

## Rules and exit codes

| Rule | Severity | Meaning |
| --- | --- | --- |
| `tag-entry-missing` | error | A release tag lacks a changelog entry. |
| `entry-tag-missing` | error | A historical changelog release lacks a tag. |
| `package-entry-missing` | error | Local package version lacks a changelog entry. |
| `package-tag-missing` | error | Local version is not a newer unpublished version and lacks a tag. |
| `package-version-behind`, `entry-version-ahead` | error | Package/tag/changelog version order conflicts. |
| `tag-duplicate`, `entry-duplicate` | error | A release identity occurs more than once. |
| `local-unpublished` | info | Current local version has an entry but no tag; no tag is inferred. |
| `package-invalid`, `tag-export-invalid`, `tag-invalid`, `entry-invalid` | error, incomplete | Required or supported comparison evidence is absent. |
| `tag-export-incomplete` | error, incomplete | Tag export explicitly marks its evidence as partial. |
| `input-unreadable`, `byte-limit`, `depth-limit`, `record-limit`, `time-limit` | error, incomplete | Input cannot be evaluated within declared limits. |

Exit `0` is `pass`, exit `1` is evaluated `fail`, and exit `2` is `incomplete` or an invalid invocation. Unknown options/configuration and output refusal leave stdout empty with a generic stderr diagnostic. Unreadable, undecodable, or unparseable input produces an `incomplete` JSON report. Reports follow the catalog v1 envelope. `@package`, `@tags`, and `@changelog` are fixed logical roles for the exact files named at invocation, not filesystem paths; `/tags/N` uses zero-based tag ordinal, and `line:N` is a one-based Markdown line reference. Reports never include package names, prose, or raw tag payload. Findings sort by `(location.file, location.pointer, ruleId)` in JavaScript code-unit order; identical inputs produce identical stdout.

## Limits and non-goals

Each of the three files is limited to 1,048,576 bytes. At most 1,000 tag records and 1,000 release headings, JSON depth 16 (combined local JSON root depth 0), and 5,000 ms of evaluation. Each limit accepts exactly N and returns `incomplete` at N+1. The tool does not validate semantic release notes, inspect Git itself, resolve remote publication state, create tags/releases, or repair a changelog. A stale or incomplete tag export cannot prove repository state.

MIT licensed; see [LICENSE](./LICENSE).
