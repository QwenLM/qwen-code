# Lightweight JSONC settings editor

## Context

The ACP runtime statically imports the settings and trusted-folders writers. Both writers currently depend on `comment-json`, whose parser cluster contributes 304,770 bytes to the ACP startup closure. Those modules are parsed and evaluated before the ACP child can answer `initialize`, even though most startups do not write either file.

Issue #7264 candidate 6 proposes loading that parser lazily or replacing it with a lighter parser. The write APIs and their callers are synchronous, and standalone distributions do not ship arbitrary JavaScript dependencies outside the bundle, so a runtime `require()` or dynamic import would either widen the API or break first use. `jsonc-parser` is already present in the development dependency graph, has a small bundle footprint, and offers synchronous parse and path-edit APIs.

## Goals

- Remove `comment-json` and `esprima` from the ACP static startup closure.
- Preserve synchronous settings and trusted-folders write APIs.
- Preserve comments and the existing file's indentation, line endings, final newline, and UTF-8 BOM during ordinary updates.
- Preserve merge, sync, and exact-subtree replacement behavior.
- Keep the trusted-folders lock, disk re-read, validation, permission, atomic-write, notification, and lock-release boundaries unchanged.
- Reject malformed or non-object JSONC without overwriting it.

## Non-goals

- Changing settings migrations or trusted-folder semantics.
- Making configuration writes asynchronous.
- Reformatting all configuration files.
- Replacing the separate strict trusted-folders load path.
- Adding a general-purpose JSONC abstraction for other packages.

## Design

Rename the legacy camel-case utility to a kebab-case JSONC editor module. The module keeps the existing file-level update API and `applyUpdates` helper, and adds two synchronous in-memory operations:

1. Parse JSONC as a top-level object while collecting and rejecting every parser error. A leading UTF-8 BOM is temporarily removed before parsing.
2. Apply merge, sync, or exact-subtree updates to the parsed value, compute the changed object paths, and apply those paths to the original text with `jsonc-parser.modify()`.

Objects are diffed recursively so unchanged comments and layout remain untouched. Arrays and scalar values are replaced atomically. Before deleting a property, an inline comment on the same line is removed with that property; otherwise `jsonc-parser` can attach the comment to the preceding property. The complete output is parsed again and compared with the intended value before any caller writes it.

Duplicate object keys need explicit handling because `jsonc-parser` evaluates the last value while `modify()` targets the first matching property. Before applying object-path updates, earlier duplicate properties along those paths are removed so the effective last property remains. Comments owned by removed duplicate occurrences are removed with them. This avoids returning success while leaving the effective value unchanged.

New files continue to use two-space JSON. Existing files retain detected tabs or spaces, LF or CRLF, final-newline state, and a leading BOM.

`trustedFolders` reuses the in-memory parser and editor after taking its existing lock and re-reading the file. It still validates the disk state and proposed state, writes through `atomicWriteFileSync()` with mode `0o600`, `forceMode: true`, and `noFollow: true`, updates memory only after the write succeeds, and releases the lock in `finally`.

`jsonc-parser` becomes a direct CLI production dependency and `comment-json` is removed. Source imports use the public package entry so unbundled compiled output remains directly runnable by Node. The esbuild configuration aliases that entry to the package's ESM build because the Node-oriented bundle otherwise selects its UMD entry, whose relative CommonJS requires do not survive the split ESM bundle. The fast-path bundle guard forbids `comment-json`, `esprima`, and the `jsonc-parser` UMD build in the ACP static closure.

## Failure handling

- Parser errors or a non-object root abort before writing.
- Values that cannot be represented as JSON abort before writing.
- A mismatch between the edited document and the intended value aborts before writing.
- Settings writes preserve the existing `false` return and stderr diagnostics on parse or validation failure.
- Trusted-folders writes preserve their throwing behavior so callers never update in-memory state after a failed authoritative write.
- Filesystem, lock, permission, and atomic-write failures keep their existing behavior.

## Alternatives considered

### Dynamic `import('comment-json')`

Rejected because the public write path is synchronous and has synchronous migration, UI, ACP, and daemon callers. Converting the call graph to async is wider than this optimization.

### Lazy `createRequire()`

Rejected because esbuild would leave the dependency outside the bundle while standalone archives do not include arbitrary JavaScript packages in `lib/node_modules`. A packaged first write could fail at runtime.

### Always rewrite with `JSON.stringify()`

Rejected because it would discard user comments and formatting during normal settings updates.

### Custom tokenizer

Rejected because `jsonc-parser` already provides the required parse tree and edit primitives with a substantially smaller, maintained implementation.

## Validation

- Focused unit tests cover existing behavior plus malformed input, non-object roots, trailing commas, nested and inline comments, deleted-property comments, merge/sync/replace semantics, prototype-pollution keys, duplicate keys, CRLF, tabs, final newline, BOM, no-op writes, and output validation.
- Trusted-folders tests cover locked disk merge, invalid input and output, comment preservation, exact sync, permission-preserving atomic writes, failed writes, and lock release.
- The bundle-guard tests and a generated esbuild metafile prove that neither `comment-json` nor `esprima` is in the ACP static closure.
- CLI build, typecheck, lint, and focused tests must pass.
- The control and candidate release bundles ran on the established 2-vCPU host with one discarded warmup, 30 alternating paired cold starts, and 30 alternating paired preheated starts. The candidate reduced cold `channel.initialize` P50 by 35.39 ms, process-to-first-session P50 by 38.00 ms, and process-to-first-session-complete P50 by 48.51 ms. It won 28 of 30 cold pairs for each primary metric, with paired-mean 95% bootstrap intervals entirely below zero.
- The already-preheated process-to-session-complete path was statistically neutral. Concurrent first sessions, legacy single-session mode, telemetry enabled, and telemetry disabled all completed successfully, produced the expected telemetry, and left no residual process.
- Candidate peak process-tree RSS was about 10.8 MiB higher during initialization, but a separate 10-pair follow-up sampled the same processes after a 10-second idle period. The paired steady-state median delta was 0.55 MiB with a bootstrap interval spanning zero, showing that the peak difference was transient initialization and garbage-collection timing rather than a persistent footprint increase.
- The exact ACP static closure decreased from 12,449,869 to 12,145,099 bytes, a reduction of 304,770 bytes (2.45%), with no `comment-json`, `esprima`, or `jsonc-parser` UMD input.
