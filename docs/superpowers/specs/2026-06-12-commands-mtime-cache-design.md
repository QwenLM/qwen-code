# Cycle 78 — Command loader mtime cache (cheap-poll without a full parse)

Proposal: `add-custom-slash-commands`. Cycle 20 reads + YAML-parses both command
roots on EVERY `CommandLoader.load()` ("always fresh, no watcher"). Cycle 35
added `X-Commands-Revision` + conditional-GET 304, but its D6 noted: a 304 still
runs the full `load()` — it saves only serialization/transfer, NOT the disk read

- parse. This cycle adds the deferred **mtime cache** so an unchanged poll skips
  the `readFile` + `parseFrontMatter` of every file.

## Deviation note

Gateway-side loader; no daemon change.

## Mechanism (`commands/loader.ts`)

`load()` first computes a cheap **directory signature** — for each root (user +
workspace) `readdir` then `stat` each `*.md` for its `mtimeMs` + `size`,
concatenated with the file set + the resolved workspace dir. If the signature
equals the last load's, return the cached `LoadedCommand[]` directly (skipping
every `readFile` + YAML parse). Otherwise read + parse + merge as today, then
cache `{signature, commands}`.

- The signature uses `mtimeMs` (high-resolution on Linux) + `size` + the file
  set + the workspace dir path, so an add/remove/edit/workspace-change all flip
  it. `readFile`/`parseFrontMatter` are the expensive parts skipped on a hit; the
  `readdir` + `stat`s are cheap.
- Signature computation mirrors `readDir`'s fail-soft posture: an unreadable root
  contributes a sentinel (never throws), so the cache and the read path always
  agree on "missing root → nothing".

## Decisions

1. **Staleness window (documented):** an edit that preserves BOTH the file's
   byte-size AND its `mtimeMs` would be missed until the next size/mtime change.
   In practice a human edit changes the size and `mtimeMs` (sub-ms on ext4), so
   this is negligible; a content hash would be exact but would require reading
   the content — defeating the purpose. This trades the cycle-20 "always parse
   fresh" property for cheap polls, as the cycle-35 D6 anticipated. The invoke
   route also benefits (and shares the same tiny window).
2. The cached array is returned **by reference** (callers — the list route's
   `.map`, the invoke route's `.find` — treat it read-only and never mutate).
   This lets a test prove a cache hit via reference equality.
3. The `warnedCollisions` / `warnedParseFailures` dedup sets are unchanged and
   still load-bearing: on a cache MISS (something changed) a still-broken file is
   re-parsed but not re-audited. On a cache HIT the parse is skipped entirely, so
   no audit fires — strictly fewer redundant passes, same once-per-lifetime
   outcome. No audit-behaviour change.

## Fail-safe commit order

Single self-contained commit (the cache is internal to `load()`; the route + the
ETag revision are unchanged). Behaviour is identical to before on the first load
of any state; subsequent unchanged loads return the same data faster. Worst case
of a bug is a stale listing (suppress-of-freshness), never a wrong scope/leak —
and the existing fresh-instance tests + new invalidation tests guard it.

## Verification

vitest: cache hit returns the SAME array reference while files are unchanged;
adding a file invalidates (new reference + the new command appears); removing a
file invalidates; editing a file's content (size change) is reflected; the
existing collision/parse_failed dedup tests still assert count==1; a fresh loader
instance always reads fresh (existing tests). typecheck/lint/build. e2e
unchanged (the GET /rc/commands e2e still 200s; the loader is in that path).

## Deferred

`fs.watch`-based invalidation (push, not poll); a content-hash exact signature;
surfacing the revision/mtime in the listing; the 1-second-granularity caveat on
coarse filesystems.
