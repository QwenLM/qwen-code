# Workspace skills read model

## Problem

`GET /workspace/skills` currently delegates to the ACP child. The child status
handler refreshes both the extension and skill caches before returning a
response. Web reconnects therefore turn a read-only status query into a full
extension scan and skill parse.

## Design

The fix is staged:

1. Make the ACP status handler read only an already committed `SkillManager`
   cache. A cold cache returns `initialized: false`; it never scans in response
   to a status request. Explicit mutation and refresh commands remain the only
   imperative refresh paths.
2. Retain the last initialized child or daemon-local fallback snapshot in the
   workspace facade. Concurrent cold reads share one request, and a generation
   guard prevents an invalidated in-flight result from being cached. The facade
   revalidates against the child's in-memory snapshot every five seconds so
   child watcher updates remain visible without request-triggered discovery.
3. Split explicit refreshes into settings and content reasons. Settings changes
   only notify derived consumers; content changes refresh each distinct
   `SkillManager` once before publishing session command updates.
4. Extension reconciliation refreshes the bootstrap extension and skill
   snapshots as well as session runtimes. Multi-session refreshes nominate one
   bootstrap refresh per ACP connection, retry through a successful session if
   the nominated session has disappeared, and use a child-side single-flight
   to coalesce overlapping requests from older parents.
5. Invalidate the daemon snapshot before and after an imperative refresh. The
   first invalidation prevents a pre-mutation snapshot from being reused; the
   second prevents a read that raced with the refresh from surviving after the
   mutation completes.
6. Cache conditional responses in the TypeScript SDK. Express generates the
   representation ETag, and cross-origin clients may send `If-None-Match` and
   read `ETag`.

The child route remains available for older daemon parents. New child versions
serve it from memory, so an old parent is safe even if it continues querying on
every reconnect.

## Invariants

- A child status read performs no extension refresh, skill refresh, skill
  parse, or settings-file load.
- Once either the child or the daemon-local fallback has published an
  initialized snapshot, repeated HTTP status reads perform no filesystem work.
- The daemon-local fallback may perform one cold enumeration when no child has
  ever published a snapshot; this preserves pre-first-prompt autocomplete
  without reintroducing repeated scans.
- Cache refresh publishes a complete replacement; readers never observe a
  cache being constructed.
- A missing committed cache is represented explicitly and does not trigger
  lazy initialization.
- Mutation-triggered refresh is independent from status reads.
- Conditional HTTP responses validate the exact serialized snapshot, and the
  SDK reparses cached JSON so callers cannot mutate the cached representation.
- Cached SDK response bodies are not exposed by reference to callers.

## Compatibility

The cached read API is additive. Existing callers of `listSkills()` keep its
lazy-load behavior. Existing HTTP and ACP response shapes remain compatible;
ETag and refresh-result fields are additive.
