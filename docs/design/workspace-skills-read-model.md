# Workspace skills read model

## Problem

`GET /workspace/skills` currently delegates to the ACP child. The child status
handler refreshes both the extension and skill caches before returning a
response. Web reconnects therefore turn a read-only status query into a full
extension scan and skill parse.

## Design

The fix is staged:

1. Make the ACP status handler read only an already committed `SkillManager`
   cache. A cold cache — or a config with no `SkillManager` at all — returns
   `initialized: false`; it never scans or parses in response to a status
   request. Explicit mutation and refresh commands remain the imperative
   refresh paths.
2. Keep the extension half of the snapshot self-healing with a `stat`-only
   validity check. Skills have a watcher; extensions do not, so a read verifies
   that the extension directory entries, their manifests, the enablement file,
   and the store's activation state are where the last refresh left them, and
   refreshes the extension and skill caches only when they moved. This preserves
   the pre-change behavior for extension install / enable / disable run outside
   the daemon, at one `readdir` plus one `stat` per entry plus two, instead of a
   directory scan and a full manifest and skill parse. Skipped in safe and bare
   mode, which deliberately never populate the extension cache at all.
3. Retain the last initialized child or daemon-local fallback snapshot in the
   workspace facade. Concurrent cold reads share one request, and a generation
   guard prevents an invalidated in-flight result from being cached or from
   extending the freshness window of a snapshot committed after it. The facade
   revalidates against the child's in-memory snapshot every five seconds so
   child watcher updates remain visible without request-triggered discovery.
4. Split explicit refreshes into settings and content reasons. Settings changes
   only notify derived consumers; content changes refresh each distinct
   `SkillManager` once before publishing session command updates.
5. Extension reconciliation refreshes the bootstrap extension and skill
   snapshots as well as session runtimes. Multi-session refreshes nominate one
   bootstrap refresh per ACP connection, retry through a successful session if
   the nominated session has disappeared, and use a child-side single-flight
   to coalesce overlapping requests from older parents.
6. Invalidate the daemon snapshot before and after an imperative refresh. The
   first invalidation prevents a pre-mutation snapshot from being reused; the
   second prevents a read that raced with the refresh from surviving after the
   mutation completes.

The child route remains available for older daemon parents. New child versions
serve it from memory, so an old parent is safe even if it continues querying on
every reconnect.

## Invariants

- A child status read performs no skill parse, no manifest parse, and no
  settings-file load. It may `readdir` the extensions directory and `stat` a
  bounded set of paths — one per entry plus two — and refreshes only when that
  set moved.
- Once either the child or the daemon-local fallback has published an
  initialized snapshot, repeated HTTP status reads perform no filesystem work
  beyond that bounded check.
- Extension state stays eventually consistent with out-of-band mutations
  without a watcher, because the check is cheap enough to run on a read.
- Revalidation can never fail a read: every part of it, including the mode
  check, is inside the error boundary.
- The daemon-local fallback may perform one cold enumeration when no child has
  ever published a snapshot; this preserves pre-first-prompt autocomplete
  without reintroducing repeated scans.
- Cache refresh publishes a complete replacement; readers never observe a
  cache being constructed.
- A missing committed cache is represented explicitly and does not trigger
  lazy initialization.
- Mutation-triggered refresh is independent from status reads.

## Known gaps

Skill enablement is read from the child's in-memory `LoadedSettings` rather than
re-loaded per request. `SettingsWatcher` keeps the User and Workspace scopes
current, so the common paths — the daemon's own toggle, a `/skills` toggle in a
terminal, a hand edit — are covered. Two narrow cases are not: the System and
SystemDefaults scopes have no watcher, so a policy change to the locked-skill
list is not reflected until an explicit refresh; and an untrusted workspace does
not watch the Workspace scope at all. Both were previously self-healing because
every read reloaded settings from disk.

## Compatibility

The cached read API is additive. Existing callers of `listSkills()` keep its
lazy-load behavior. Existing HTTP and ACP response shapes remain compatible;
refresh-result fields are additive.
