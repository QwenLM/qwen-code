# GitHub channel: conditional requests for polling

[English](2026-11-09-github-channel-conditional-requests.md) | [简体中文](2026-11-09-github-channel-conditional-requests.zh-CN.md)

Status: proposed. Implements #16691. Baseline: `main` at `56ea1bc3fbb`.

## Problem statement

The GitHub channel sends no conditional headers. Every poll pays full primary
rate-limit price even when nothing changed. At the default 60-second poll with
`DEFAULT_PR_WATCH_LIMIT = 30`, the PR state watch alone issues about 1,800
requests per hour — over a third of a 5,000/hour budget spent confirming that
nothing happened.

GitHub does not count a `304` against the primary rate limit when the request
was correctly authorized. The channel also ignores the `X-Poll-Interval` header
that the notifications endpoint returns.

## Current state

Verified against the baseline above:

- `GithubAdapter.ts` constructs Octokit with `auth`, `baseUrl` and an optional
  `request.agent`. There is no ETag handling anywhere in the channel.
- The single `hook.wrap('request', …)` only calls `recordRateLimitBudget`, added
  by #16701. It is the success-path budget choke point.
- `watchOnePr` issues one `pulls.get` per watched PR per poll, wrapped in
  `githubApi(…, 3, (err) => !isWatchFailFastError(err))`.
- The notifications lane calls
  `octokit.paginate(listNotificationsForAuthenticatedUser, { since, per_page: 100 })`.
  `since` is `cursor.lastProcessedAt − 1s`, so it is **stable while idle** and
  only advances when new notifications are committed.
- `githubApi` retries any thrown error unless `shouldRetry` says otherwise. A
  `304` reaching it would be treated as a retryable failure.
- CI re-checks are time-based (`CI_RECHECK_INTERVAL_MS`,
  `CI_PENDING_RECHECK_INTERVAL_MS`, `CI_NONE_GRACE_MS`). The code already
  documents that GitHub does not advance `updated_at` on check activity.
- `PollingChannelBase.pollInterval` is a protected getter, clamped to
  `[MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS]`, defaulting to 60,000 ms.

### Measured behavior of the stack

These were probed against the installed dependencies and the live API, not
inferred from documentation.

| Probe                                                                               | Result                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@octokit/request` fetch-wrapper on `304`                                           | Hard-coded `throw new RequestError("Not modified", 304, …)`, inside `plugin-request-log`'s own `hook.wrap`.                                                       |
| Catching `304` in an adapter-registered `hook.wrap` and returning a cached response | Works; `rest.pulls.get` resolves normally, and `paginate` follows the cached `link` across an all-`304` page sequence.                                            |
| Side effect of that catch                                                           | `plugin-request-log` is inner, so its `.catch` still runs `octokit.log.error("GET … - 304 …")` before rethrowing. Default Octokit `log.error` is `console.error`. |
| Live `GET /notifications?per_page=1`, `200`                                         | Returns `link: <…page=2>; rel="next", <…page=298>; rel="last"`, `etag`, `x-poll-interval: 60`.                                                                    |
| Same URL with `If-None-Match`, `304`                                                | Returns `etag`, `x-poll-interval: 60`, `x-ratelimit-remaining`, `cache-control`, `vary` — and **no `link` header**.                                               |
| `@octokit/request` and `request.agent`                                              | The installed fetch-wrapper never reads `request.agent`; it forwards only `method`, `body`, `redirect`, `headers`, `signal`, `duplex`.                            |

The `304`-has-no-`link` result is the load-bearing finding. Serving a `304` with
its own headers would make `paginate` stop after page 1 and silently drop the
remaining 297 pages of notifications.

## Goals

- Unchanged `pulls.get` and notifications responses cost no primary rate limit.
- Honour `X-Poll-Interval` for the notifications endpoint.
- No change to what is observed, how events are decided, or when CI re-checks
  fire.

## Scope boundaries

- Conditional headers are applied only to `pulls.get` and the notifications
  list. Checks, comments, reviews and every write are untouched.
- The cache is in-memory and per-connection. It is not persisted; the first
  poll after a restart is a full `200`.
- #16692 (GraphQL batching) stays deferred. The triage on both issues chose this
  issue for the watch path.
- The inert `request.agent` proxy option is a pre-existing condition. This
  change neither fixes nor worsens it: the injected `fetch` forwards to
  `globalThis.fetch` with the identical init.

## Proposed solution

### Transport layer

Octokit is constructed with `request.fetch` set to an adapter method that owns
the conditional exchange:

1. Only `GET` requests whose URL matches `pulls.get` or the notifications list
   participate. Everything else is forwarded untouched.
2. The cache key is the full request URL, including the query string, so a
   moved `since` cursor is a different entry rather than a false hit.
3. On a cache hit the request carries `If-None-Match`.
4. A `200` with an `ETag` stores the body and the `Link` header before the
   response is returned.
5. A `304` with a cache entry is answered with a synthetic `200` whose body is
   the cached body, whose headers are the **fresh `304` headers**, and whose
   `Link` is the **cached `Link`** when the `304` omits it.
6. A `304` without a cache entry cannot happen on a request this layer made
   conditional; it is forwarded unchanged rather than guessed at.

The existing `hook.wrap('request', …)` budget recorder is left as it is. It sees
the synthetic `200` carrying the fresh `x-ratelimit-*` headers, so budget
awareness from #16701 keeps working without modification.

### Poll interval

`GithubAdapter` overrides the protected `pollInterval` getter to return the
larger of the base interval and the last observed `X-Poll-Interval`, which is
read from response headers in the existing request hook.

### Watch and CI

`watchOnePr` is not changed. A `304` delivers a body byte-identical to the
previous `200`, so `headChanged` is false, `prUpdatedAt` equals the retained
value, and the time-based CI conditions continue to fire on their own schedule.

## Design decisions and rationale

### Interception happens at `request.fetch`, not at `hook.wrap`

The issue's triage suggested treating `304` as cached-body reuse in the request
hook. That works, but the probe shows `plugin-request-log` sits inner to any
adapter-registered wrap and logs every `304` at `error` level before rethrowing.
At the default poll that is roughly 1,800 `console.error` lines per hour of pure
noise. Octokit offers no way to register a wrap inner to its built-in plugins.

Converting the `304` at the transport boundary means no layer above ever learns
there was a `304`: no error log, no retry interaction, no `githubApi` involvement.

### The cache stores the HTTP body, not the derived watch state

`PrWatchEntry` persists enough fields to reconstruct an observation, and the
issue suggested reusing them. Reconstructing a PR-shaped object instead would
couple the cache to the exact set of fields `watchOnePr` reads today
(`head.sha`, `updated_at`, `mergeable`, `mergeable_state`, `state`, `merged`,
`title`). Two of those — `merged` and a non-null `mergeable` — are not persisted
at all. Caching the response body avoids the mapping entirely and cannot drift
when the watch later reads a new field.

### `Link` is carried over from the cache, and only `Link`

The measured `304` omits `Link`. Rebuilding the synthetic response from the
cached headers wholesale would risk stale `content-encoding` and
`content-length`; taking only `Link` is the minimal carry-over that keeps
pagination correct. Every other header comes from the fresh `304`, so
`x-ratelimit-*` and `x-poll-interval` are never served stale.

### `X-Poll-Interval` slows the whole poll loop

The base class exposes one interval for the whole poll, and the watch pass runs
before the notifications lane. Honouring the header by raising that interval
therefore also slows the watch. The alternative — skipping only the
notifications fetch — needs an early return through the middle of `pollOnce`,
past its cursor and deferral machinery, which is a larger and riskier change.

At the default 60-second poll the header is also 60, so nothing changes. Only
operators who configured a faster poll are affected, and GitHub is explicitly
asking them to slow down. The consequence is documented rather than hidden.

### The cache is bounded and connection-scoped

A moved `since` cursor mints new keys, so an unbounded map would grow for the
life of the process. The cache evicts oldest-first past a fixed entry cap and
declines to store bodies above a fixed size; a declined URL simply stays
unconditional, which is the pre-change behavior. The cache is cleared on
disconnect so a reconnect never serves a body cached under a previous
credential.

## Files affected

| File                                                 | Change                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/channels/github/src/GithubAdapter.ts`      | Conditional `fetch`, cache, `X-Poll-Interval` capture, `pollInterval` override. |
| `packages/channels/github/src/GithubAdapter.test.ts` | Collocated tests, including a transport-level wire oracle.                      |
| `docs/users/features/channels/github.md`             | Document the behavior and the poll-interval consequence.                        |

No config descriptor change: the feature has no new operator-facing option.

## Constraints and risks

- **Correctness of `Link` carry-over is the primary risk.** A regression here
  drops notifications silently rather than failing loudly. It needs a test
  that would go red if the carry-over were removed.
- **ETag authority.** The design trusts GitHub's `ETag` to change whenever the
  representation changes, including when a lazily computed `mergeable` settles.
  If GitHub ever served a stale `ETag` across a real change, the watch would
  miss it. This is the same trust every conditional-request client places in
  the platform.
- **Budget accounting.** A `304` still returns `x-ratelimit-remaining`; the
  synthetic response must carry the fresh value, not the cached one, or the
  #16701 gate would reason from a stale budget.

## Validation plan

- Unit tests in `GithubAdapter.test.ts` covering: conditional header sent on
  the second poll; `304` served from cache without reaching `githubApi` retry;
  a `200` after a changed `ETag`; cache keying on the full URL including
  `since`; cache cleared on disconnect; entry and body-size bounds.
- A regression test that drives a multi-page notifications sequence entirely
  through `304`s and asserts every page is still returned — the mutation
  witness for the `Link` carry-over.
- A test that holds the PR body constant across polls and asserts the CI
  re-check still fires when its interval elapses.
- A transport-level test using a real Octokit with an injected `fetch`, counting
  actual requests, so the assertions cannot be satisfied by a mocked
  `paginate`.
- `npm run build`, `npm run typecheck`, and the focused package test file.

## Acceptance criteria

- A quiet watched PR costs one `200` followed by `304`s, and the `304`s do not
  advance the primary rate limit.
- A multi-page notifications list is returned in full when every page answers
  `304`.
- CI re-checks fire on their existing schedule during a `304`-only sequence.
- No `304` produces an error-level log line.
- The poll interval never runs faster than the last `X-Poll-Interval`.
- Existing watch, notification and budget tests stay green.

## Open questions

- Whether the entry cap and body-size cap should be operator-configurable.
  Proposed: no, keep them internal constants until a deployment shows otherwise.
- Whether to extend conditional requests to the comment and review lanes once
  this lands. Proposed: measure first; both are already cursor-gated and are
  not the dominant cost.
