# Bounded extension loading

[English](extension-load-concurrency.md) | [简体中文](extension-load-concurrency.zh-CN.md)

## Problem and scope

The full extension refresh awaits each extension before starting the next.
Installed collections with many skills therefore accumulate filesystem latency
across extensions. This change addresses that serial outer loop on current main.

Catalog and detail reads already avoid unnecessary resource loading. Preserve
those paths, activation policy, cache publication, startup behavior, and every
individual resource loader's validation and error handling. Do not introduce
retry policy, recovery state, refusal ledgers, or nested resource concurrency.

## Design

In `ExtensionManager.loadExtensionsFromExtensionsDir`, load at most four
directory entries per batch. Await all results in that batch, then consume them
in the original directory order. Append non-null extensions; if a load rejects,
rethrow the first error in directory order without starting another batch.

Four is a fixed, conservative bound on simultaneous extension loads in one scan.
It is not a process-wide file-descriptor limit. Individual loaders retain their
existing scheduling. A batch barrier keeps implementation small and ensures
in-flight sibling loads finish before a failed scan leaves the store's read
transaction. A slow entry can delay the next batch; this is an intentional
tradeoff against a queue or new concurrency abstraction.

Result order must remain stable: runtime cache insertion uses last-name-wins
semantics, while detail selection uses the last matching entry. Null results
continue to mean the existing loader skipped an entry. Rejections that escaped
the old loop, including the initial directory stat, must still reject the scan.
The failing batch may start entries the serial scan would not reach, and warning
emission can interleave; no result from a rejected scan reaches cache publication.

## Affected paths

Only the outer loop in `packages/core/src/extension/extensionManager.ts` changes
production behavior. Its consumers are full refresh, catalog snapshot, detail
snapshot, and `loadExtensionsFromDir`. Name-filtered refresh and direct named
loads retain their existing behavior. Regression coverage belongs with the
extension manager tests.

## Validation and acceptance

- Controlled pending loads prove that more than one and at most four entries
  start concurrently, and that completion order cannot reorder the result.
- A rejected load waits for its in-flight siblings, preserves the original
  error, and starts no later batch.
- Real filesystem fixtures retain valid resource contents, skip malformed
  manifests, and preserve existing catalog, detail, activation, and cache tests.
- Compare full refresh duration against the unchanged main implementation with
  identical isolated fixtures and multiple runs. Record fixture size, medians,
  and environment; a synthetic warm-cache measurement is not a production SLA.
- Build, typecheck, bundle, focused tests, and an isolated CLI smoke check pass.

## Open questions

None. Further parallelism or changes to existing error policy require separate
evidence and a separate change.
