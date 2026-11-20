# pr-ui-verify: SSE admission row — PR #17663, head 1e86fc1d386a

Date: 2026-11-18 (Beijing). Clears closeout hold
`td-patrol-closeout-gap:17663:93b7b8f9:b` on the NEW head (the head advanced
via the review-fix commit 205b943ff4fb and the main-merge 1e86fc1d386a).

## Method

Real-runtime browser verification, not jsdom fixtures:

- Four REAL daemons, one per row state (see provenance below).
- One vite dev server per state (`QWEN_DAEMON_URL=http://127.0.0.1:<port>`,
  `npm run dev -- --port <vite> --host 127.0.0.1`), page opened with
  `/?token=<daemon token>`; the dialog's data is the live daemon's
  `/daemon/status`, proxied.
- Playwright (headless Chromium, en locale): open the dialog via the rail's
  More → Daemon Status, stay on the default Overview tab, scroll the
  Transport card into view, assert the row's DOM text, screenshot.
  `pageerror` collected: zero across all four states.
- Driver: `.qwen/e2e-tests/sse-unified-admission-occupancy/ui-row-states.mjs`
  (re-runnable; `--only <states>` filter).

## Per-claim verdicts

| State | Daemon provenance | Row DOM text (verbatim) | Verdict | Screenshot |
| --- | --- | --- | --- | --- |
| paired `6 / 204` | local bundle at head (default cap 204), port 4195, 6 REST event streams held open by the driver while the dialog rendered | `SSE admission (used / cap)6 / 204` | PASS | [paired.png](https://raw.githubusercontent.com/wenshao/qwen-code/assets-pr17663/pr17663-r2/paired.png) |
| cap-only `204` | bundle built at base commit `b2bdf590191a` (has #17502 cap, predates #17554 occupancy), port 4197 | `SSE admission (used / cap)204` (exact adjacent-span text; no `/ 204` pair anywhere in the dialog) | PASS | [cap-only.png](https://raw.githubusercontent.com/wenshao/qwen-code/assets-pr17663/pr17663-r2/cap-only.png) |
| `0 / unlimited` | local bundle at head with `--max-sse-connections 0`, port 4198 | `SSE admission (used / cap)0 / unlimited` | PASS | [unlimited.png](https://raw.githubusercontent.com/wenshao/qwen-code/assets-pr17663/pr17663-r2/unlimited.png) |
| no row | globally installed `qwen` 0.28.0 (predates #17502; `/daemon/status` has no `maxSseConnections` key), port 4196 | row absent; dialog text contains no `SSE admission` | PASS | [no-row.png](https://raw.githubusercontent.com/wenshao/qwen-code/assets-pr17663/pr17663-r2/no-row.png) |

Field provenance checked per daemon before the browser run
(`/daemon/status`): paired `{cap:204, streamOccupancy:true}`; cap-only
`{cap:204, streamOccupancy:false}`; unlimited `{cap:null,
streamOccupancy:true}`; no-row `{maxSseConnections key absent}`.

The paired screenshot also shows `REST SSE streams 6` beside the row —
the aggregate occupancy (6) equals the REST count here because all six
held streams are REST; the unit suite pins the non-REST surfaces and the
`total` vs `byListener.primary` discrimination separately.

## Environment disclosures

- The cap-only binary was built in a detached scratch worktree at
  `b2bdf590191a`. Its `web-templates` export-html size gate fails on this
  host's Node 22.22.2 (2,140,080 > 2,140,000 bytes; CI's Node passes) — the
  scratch worktree's budget constant was raised by 100 bytes ONLY to
  produce the verification binary; no PR tree was touched.
- Verification artifacts: one scratch session per daemon under
  `/tmp/sse-uni-e2e/r2/ws-a` (untitled placeholders, safe to delete) and
  one real BTW side-question model call from the G5 API run (D1). Daemons
  and dev servers are torn down after the run.
- The LAN-side deep-health listener pair is not browser/E2E-runnable on
  this host (`local-control enable` → 409 `no_lan_interface`, office
  network); covered by the behavior unit test driving the real
  LocalControlService with loopback-pinned LAN selection (see plan G3).

## Result

4/4 visible claims PASS on head `1e86fc1d386a`, zero page errors.
## Addendum r3 — re-bound to head 23675ccc128e (2026-11-18)

All four states re-verified at head `23675ccc128e` (round-3 fixes + PR1
round-3 merge `a7b50eb`); web-shell sources byte-identical to the r2 head.
4/4 PASS, zero page errors; screenshots + manifest on fork branch
`assets-pr17663` dir `pr17663-r3/` (raw 200 image/png each). G5 API suite
re-ran 13/13 at the same head (access-log lines carry the new daemon pid).
Posted as an issue comment on #17663 clearing the closeout hold at this head.

## Addendum r4 — re-bound to head 82a5aa07f0ac (2026-11-18)

Four states re-verified at `82a5aa07f0ac` (#17662, carrying this PR's content
after the merges); web-shell byte-identical to 23675ccc128e. 4/4 PASS, zero
page errors; screenshots + manifest on fork branch `assets-pr17663` dir
`pr17663-r4/`. G5 13/13 at same head. Posted as an issue comment on #17663.
