# web-shell boot retry: outlast a network-change abort storm

[English](2026-11-09-web-shell-boot-retry-storm-backoff.md) | [简体中文](2026-11-09-web-shell-boot-retry-storm-backoff.zh-CN.md)

Status: proposed

## Problem statement

The `web-shell E2E Smoke` lane goes red on the shared ARM64 self-hosted pool for
reasons no diff of the failing PR caused. The signature is a shard that loses
10–20 tests to visibility and navigation timeouts while its sibling shards, running
the same build artifact on other hosts, pass.

Run [42546153793](https://github.com/QwenLM/qwen-code/actions/runs/42546153793),
job `128934179292` (shard 4/4, runner `ecs-qwen-hz6-16`) is a fully instrumented
example: `11 failed | 10 flaky | 80 passed (19.5m)`, while shards 1–3 passed on
`ecs-qwen-hz1-21`, `ecs-qwen-hz2-31` and `ecs-qwen-hz3-2` in 12.6–14.7 minutes.

The failure is **not** a slow first paint. 41 of the 47 uploaded `error-context.md`
snapshots show the same terminal page:

```yaml
- heading "Web Shell 加载失败 / failed to load"
- paragraph: 'A required resource failed to load: unknown error (http://127.0.0.1:36657/main.tsx). …'
- button "重新加载 / Reload"
```

Once that panel is painted the boot is dead, so every later assertion waits out
its full budget. Raising visibility timeouts cannot fix it, which is why the
earlier raise of `expect.timeout` from 10 s to 20 s did not stop the lane bleeding.

## Current state

The mechanism, established from the 21 retry traces in that job:

1. Sibling containers on the shared host change its network interfaces. Chromium's
   network-change notifier fires and aborts **every in-flight request** with
   `net::ERR_NETWORK_CHANGED`. 19 of 21 traces carry that `_failureText`; a single
   test lost up to 648 `script` requests.
2. The smoke suite boots through the **vite dev server**, so one boot is roughly
   900–5500 module requests spread over several seconds — a wide exposure window.
3. `client/e2e/utils/bootRetry.ts` already reloads a boot killed this way, but it
   schedules the reload with `setTimeout(…, 0)` and allows `MAX_BOOT_RELOADS = 2`.
   In the traced test the three entry-module attempts started at `01:55:24.631`,
   `01:55:25.536` and `01:55:27.599`, while the abort storm covered
   `01:55:24`–`01:55:27`. **All three attempts were spent inside one storm.**
   Each `main.tsx` response was `200 OK`; what failed was its import graph, and a
   module script whose descendant import fails reports the error on the top-level
   element, which is why the watchdog names `main.tsx`.
4. With the budget spent, `client/index.html`'s boot watchdog paints its fallback.
   That box is explicitly terminal and sticky, and it uninstalls the watchdog.

Chromium treats this as
[wontfix](https://stackoverflow.com/questions/44678168/docker-and-chromium-neterr-network-changed)
and exposes no switch to disable the notifier, so the browser cannot be asked to
stop producing the aborts.

## Goals

- Let a boot survive an abort storm lasting several seconds, so a shard stops
  failing on host network churn it did not cause.
- Keep every existing assertion meaningful. The retry budget stays bounded and
  stays pinned by a test.

## Scope boundaries

- **Not** replacing the dev server with a built preview. That would shrink the
  exposure window far more, but the boot-retry scenarios exist precisely to
  exercise a dev-server module graph failing to load; removing `/main.tsx` removes
  their subject.
- **Not** raising visibility or per-test timeouts. The page is terminal, not slow.
- **Not** the dedicated network-isolated pool. That is
  [#15967](https://github.com/QwenLM/qwen-code/issues/15967) and remains the durable
  fix; this change is the in-repo mitigation that reduces how often the lane bleeds
  until that lands.

## Proposed solution

Change only `client/e2e/utils/bootRetry.ts` and the scenarios that pin its budget.

1. **Space the retries out.** Replace the zero-delay reload with a deterministic
   increasing backoff, `BOOT_RELOAD_BACKOFF_MS = [500, 1_500, 3_500]`. Successive
   attempts then land outside the window that killed their predecessor instead of
   queueing up behind it.
2. **Raise the budget to `MAX_BOOT_RELOADS = 3`** (four attempts). Three attempts
   provably fit inside one observed storm; a fourth, delayed by the ladder, lands
   after it. The budget is derived from the length of the backoff array, so the two
   have a single source.
3. **Cancel a pending reload when a new document commits.** A delay of up to 3.5 s
   opens a window the zero-delay version did not have: a test-driven navigation
   during the wait would otherwise be reloaded by the stale timer. The reload is
   dropped if the boot counter advances before the timer fires.
4. **Export both constants** so the scenarios derive their expected counts from the
   implementation rather than restating `3` as a literal.
5. **Give the "must not reload" assertions a quiet window.** The backoff defers a
   spurious reload by one first-level delay, so a document count read right at the
   `load` event would miss it. Those four assertions now wait
   `BOOT_RELOAD_BACKOFF_MS[0] + 500` first, which keeps the pins load-bearing under
   the backoff.

## Design decisions and rationale

- **Backoff before a bigger budget.** A larger budget alone still clusters the
  attempts: four immediate retries span about the same second as three. The
  spacing is what moves an attempt past the storm; the extra attempt is what gives
  the spacing somewhere to land.
- **These numbers.** Non-boot-retry specs assert visibility with the suite's
  `expect` budget of 20 s, measured from the `load` event the `goto` awaited. The
  ladder waits 5.5 s in total, leaving room for four short aborted boots inside
  that budget. A longer ladder would trade this flake for visibility timeouts.
- **No jitter.** The suite must stay deterministic; a randomised delay would make
  the new scenario's outcome depend on the draw.
- **The storm's length is anchored to the field, not derived from the ladder.**
  Deriving it from the backoffs would shrink the storm whenever the ladder shrank,
  so the case would keep passing while a real four-second storm stranded the boot
  again. It is a fixed 5 s, which the ladder must outlast; shortening the ladder
  therefore turns the case red instead of silently moving the goalposts.
- **Derive the pinned counts.** The two scenarios that assert the exact number of
  attempts now compute it from `MAX_BOOT_RELOADS`, and their quiet window from the
  largest backoff, so the constant and its pins cannot drift apart.

## Constraints

- The whole ladder must complete inside the 20 s `expect` budget used by specs that
  do not override it.
- The quiet window that proves "no further reload" must exceed the largest backoff,
  or it would expire before a scheduled reload became observable.
- The retry must keep keying on main-frame `script` requests of the current boot;
  the existing scenarios that exclude fetches, sub-frames and outgoing-document
  requests must stay green unchanged.

## Risks

- **Still bounded.** A storm longer than the ladder can still strand a boot. This
  reduces the rate; it does not make the lane immune, and #15967 is still required.
- **Backoff spends visibility budget.** On a host cold enough that a single boot
  approaches the budget, the added 5.5 s could surface as a visibility timeout
  instead. The 40 s budget the boot-retry scenarios use absorbs this; the general
  suite's 20 s is the binding case.
- **A genuinely broken entry module now takes longer to report**, by the same
  5.5 s, before the watchdog panel is asserted.

## Validation plan

- Add a scenario that reproduces the storm in-process: abort every main-frame
  `script` request for a fixed wall-clock window, then let the graph load. It
  asserts the shell mounts and no fallback panel remains. This pins the backoff and
  the budget together — removing either makes the attempts cluster or run out
  inside the window.
- **Mutation witness:** restore the zero-delay reload, and separately restore
  `MAX_BOOT_RELOADS = 2`; the new scenario must go red both times, while the
  unrelated scenarios stay green as a control.
- Re-run the boot-retry spec file repeatedly on `mobile-chromium` to show the
  result is stable.
- `npm run build`, `npm run typecheck`, `npm run lint`, and the web-shell unit
  suite.
- **Local gap to state explicitly:** this host cannot run the `mobile-webkit`
  project (missing `libx264` and friends), so WebKit coverage is left to CI.

## Acceptance criteria

- The new storm scenario passes repeatedly with the change and fails under both
  mutations.
- Every pre-existing boot-retry scenario still passes, with assertions unchanged
  apart from the budget counts now derived from the exported constant.
- Build, typecheck and lint are clean.
- Both language versions of this design stay aligned.

## Open questions

- Whether the ladder should later grow a fourth step depends on evidence from
  #15967's pool; it is deliberately not speculative here.
- The lane's residual failure rate after this change should be re-measured before
  deciding whether more in-repo mitigation is worth its latency cost.
