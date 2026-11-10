# WeChat (Weixin) Channel Configuration in Web Shell

[English](2026-11-09-web-shell-weixin-channel.md) | [简体中文](2026-11-09-web-shell-weixin-channel.zh-CN.md)

Status: proposed

## Problem statement

The WeChat (`weixin`) channel works from the terminal but cannot be configured
from the Web Shell at all. An operator using the browser UI has no way to
discover the platform, no way to log in, and no way to create the channel
instance. The only supported path is a shell on the daemon host:

```bash
qwen channel configure-weixin   # QR login, prints a URL to stderr
qwen channel start my-weixin    # after hand-editing ~/.qwen/settings.json
```

This is the largest remaining usability gap in the channel management surface:
every other consumer-facing IM platform except Telegram is configurable in the
browser, and the two enterprise WeChat variants (`wecom`, `wecom-callback`)
already are.

## Current state

Verified against the working tree at the time of writing.

| Layer               | File                                                                   | State                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin              | `packages/channels/weixin/src/index.ts`                                | Declares no `management`, so the catalog reports `manageable: false`.                                                                                                                                     |
| Catalog             | `packages/cli/src/commands/channel/channel-registry.ts:467`            | `manageable: management !== undefined`; unmanageable types ship an empty `fields` array.                                                                                                                  |
| Web Shell allowlist | `packages/web-shell/client/components/channels/channel-platform.ts:19` | `SUPPORTED_CHANNEL_TYPES` omits `weixin`; `channel-platform.test.ts:35` asserts it is filtered out.                                                                                                       |
| Login               | `packages/channels/weixin/src/login.ts`                                | `startLogin` returns only the QR id and writes the scannable URL to `process.stderr`; `waitForLogin` is a blocking loop (default 480 s) that also writes progress to stderr and accepts no `AbortSignal`. |
| Credentials         | `packages/channels/weixin/src/accounts.ts`                             | One process-global `account.json` under `~/.qwen/channels/weixin/` (overridable with `WEIXIN_STATE_DIR`), written `0600` via an unguessable temp name plus rename.                                        |
| CLI command         | `packages/cli/src/commands/channel/configure.ts`                       | The only consumer of `startLogin` / `waitForLogin` besides their own test.                                                                                                                                |
| Daemon              | `packages/cli/src/serve/routes/`                                       | No WeChat login route exists.                                                                                                                                                                             |

Two constraints follow from this table and shape the whole design.

**The credential is process-global, not workspace-scoped.** `account.json` lives
in the daemon's home directory and is shared by every `weixin` instance in every
workspace. Channel management routes, by contrast, are workspace-scoped and
gated on workspace trust.

**The login helpers are terminal-shaped.** They print instead of reporting, and
the poll loop cannot be cancelled. Neither is usable from a daemon route without
changes to the channel package.

## Goals

- WeChat appears in the Web Shell channel platform list and opens the standard
  channel editor.
- An operator can complete QR login entirely in the browser: start, see the QR,
  see scan/confirm progress, and end up with stored credentials.
- The editor shows whether WeChat is logged in, and offers logout.
- The terminal command keeps its current behavior and output.
- The bot token never reaches the browser.

## Non-goals

- Detecting an expired live session (`errcode -14`) and surfacing it as a channel
  runtime state. Today `monitor.ts` logs and pauses for 30 s; changing that
  propagates through the adapter and the runtime state contract and is a
  separate piece of work.
- Multiple simultaneous WeChat accounts. The credential store holds one account;
  this design does not change that.
- Telegram, QQ Bot, or email support in Web Shell.
- A new serve capability tag (see "Capability gating" below).

## Proposed solution

### 1. Channel package: report login progress instead of printing

`packages/channels/weixin/src/login.ts`

- `startLogin(apiBaseUrl)` returns `{ qrcodeId, qrcodeUrl? }` rather than a bare
  string, and no longer writes to stderr. `qrcodeUrl` is the response's
  `qrcode_img_content` — the value the operator scans.
- `waitForLogin` accepts `signal?: AbortSignal` and
  `onEvent?: (event: WeixinLoginEvent) => void`, and replaces every
  `process.stderr.write` with an event. The event union is
  `{ type: 'qrcode'; qrcodeId; qrcodeUrl? }`, `{ type: 'scanned' }`, and
  `{ type: 'expired' }`. `qrcode` fires only when the loop mints a replacement
  after an expiry — the caller already holds the initial one from `startLogin`.
  `scanned` fires on every poll reporting a scan, preserving the previous
  terminal output.
- The existing retry budget, the 480 s default deadline, the 1 s poll cadence,
  and the `LoginResult` shape are unchanged. The budget is checked before
  minting, so three consecutive expiries produce two refreshes and then
  terminate. The loop checks `signal` and settles as cancelled when it is
  aborted; both the poll fetch and the idle sleep detach their abort listeners
  on every exit.

`packages/channels/weixin/src/index.ts`

Add `management` so the catalog marks the type manageable:

- `groupPolicy` — `enum`, required, default and only option `disabled`. The iLink
  Bot is direct-message only (`WeixinAdapter.connect` hardcodes `isGroup: false`),
  so offering the other three policies would let an operator configure a mode
  that can never fire.

**No `baseUrl` field.** `connect()` replaces the configured root with the one
stored at login, and both login paths always store one, so an editor field for
it would promise an override that cannot reach a request. Exposing it needs the
adapter's precedence fixed first; until then the knob stays out rather than
lying. Narrowing `groupPolicy` also needs the settings validator to forgive an
unchanged stored value, exactly as its number branch already does — otherwise an
operator who configured a wider policy in `settings.json` before this change
could not save an unrelated edit.

No `requiredConfigFields`: the token comes from `account.json`, not from channel
config, so the editor must not render a credential input for it. The shared
`privatePolicy`, `allowedUsers`, `sessionScope`, and `operators` fields are
appended by `managementFieldsWithSharedControls` as for every other channel.

### 2. CLI command: keep the terminal experience

`packages/cli/src/commands/channel/configure.ts` adapts to the new signatures and
does its own printing, reproducing today's stderr lines from the emitted events.
No user-visible change to `qwen channel configure-weixin`.

### 3. SDK: shared response types

`packages/sdk-typescript/src/daemon/types.ts` gains two interfaces, exported from
`src/daemon/index.ts` — the `@qwen-code/sdk/daemon` subpath every consumer in
this change imports, following the sibling subscription types, which are not
re-exported from the package root either:

- `DaemonWeixinAccountStatus` — `{ enabled: boolean; configured: boolean; userId?: string; savedAt?: string }`
- `DaemonWeixinLoginFlow` — `{ id: string; status: 'waiting' | 'scanned' | 'ready' | 'expired' | 'error'; qrText?: string; qrcodeUrl?: string; errorCode?: string }`

Neither type carries a token field. Defining them once in the SDK lets the route
and the browser import the same contract; `routes/subscription-auth.ts` and
`routes/daemon-update.ts` already import their view types this way.

### 4. Daemon: a process-global login flow route

New file `packages/cli/src/serve/routes/weixin-auth.ts`, exporting
`registerWeixinAuthRoutes(app, mutate, options?): () => void` (the returned
function disposes in-flight flows). It mirrors `registerSubscriptionAuthRoutes`
route for route, including that file's ownership comment: process-global account
credentials belong to the daemon's home, never a workspace runtime.

`options.apiBaseUrl` defaults to the package's `DEFAULT_BASE_URL` and exists only
as a test seam: it lets the route tests point the flow at a loopback fake iLink
server. Production wiring passes nothing, and no request body field can override
it — an operator-supplied upstream URL would turn the login flow into an SSRF
primitive.

| Method | Path                     | Gate                       | Behavior                                                                                |
| ------ | ------------------------ | -------------------------- | --------------------------------------------------------------------------------------- |
| GET    | `/auth/weixin`           | authenticated              | Local account status only. No upstream call.                                            |
| POST   | `/auth/weixin/flows`     | `mutate({ strict: true })` | Start a flow, return `201` with the initial view, run `waitForLogin` in the background. |
| GET    | `/auth/weixin/flows/:id` | authenticated              | Current flow view; `404` once the flow is gone.                                         |
| DELETE | `/auth/weixin/flows/:id` | `mutate({ strict: true })` | Abort and drop the flow, `204`.                                                         |
| POST   | `/auth/weixin/revoke`    | `mutate({ strict: true })` | Cancel all flows, `clearAccount()`, `204`.                                              |

Flow lifecycle:

- At most 4 concurrent flows; the fifth request gets `429` with
  `code: 'too_many_flows'`, matching the subscription route's cap pattern.
  A client that disconnects before the mint answers cannot cancel what it never
  learned the id of, so the route drops that flow itself (`res` closed before
  the response finished) — otherwise a page refresh mid-login would hold a slot
  for the flow's whole deadline.
- Starting a flow calls `startLogin`, renders `qrcodeUrl` to `qrText`, and stores
  the view. A response that carries a QR id but no scannable URL is treated as a
  failed mint (`502 qr_unavailable`, slot released) rather than a live flow: with
  neither a QR nor a link, a live flow gives the operator nothing to act on and
  renders no retry action. The mint also carries a 30 s timeout, because a hung
  upstream would otherwise hold both a slot and the request open indefinitely.
  `onEvent` updates the view in place: a `qrcode` event replaces
  `qrText`/`qrcodeUrl` (the QR refreshed after expiry), `scanned` moves the status
  to `scanned`.
- On `LoginResult.connected`, the route calls `saveAccount` with the same fields
  the CLI writes, then sets status `ready`. The token is used for the save and
  never placed in the view. A failed write is `error` with
  `errorCode: 'credentials_error'`, kept distinct from an upstream failure
  because the operator has to fix the daemon's home directory.
- A terminal view is retained for 60 s so a polling client can observe it, then
  dropped by an `unref`'d timer, as the subscription route does.
- `expired` (retry budget exhausted) and `error` are terminal views carrying a
  stable `errorCode`; upstream error text is not echoed verbatim.
- The dispose function aborts every controller and clears every timer.

QR rendering reuses the daemon's existing approach in
`routes/workspace-local-control.ts:withUiData`: a dynamic `import('qrcode-terminal')`,
`setErrorLevel('Q')`, `generate(url, { small: true })`. It is best-effort — a
rendering failure leaves `qrText` undefined and the flow still carries
`qrcodeUrl`, so the operator can open the URL directly. `qrcode-terminal` is
already a `packages/cli` dependency.

Wiring: `packages/cli/src/serve/server.ts` registers the routes next to the
subscription auth routes and calls the dispose function on shutdown.

### 5. Web Shell: allowlist, login panel, and labels

- `channel-platform.ts` — add `weixin` to `SUPPORTED_CHANNEL_TYPES` and to the
  returned type union; add `weixin: 'WX'` to `PLATFORM_MARKS`. Update
  `channel-platform.test.ts`, which currently asserts the opposite.
- New `weixin-auth-api.ts` — a thin REST helper over
  `createDaemonRestRequest(baseUrl, token, client)`, following
  `components/local-control-api.ts`. This is the established pattern for a
  process-global route called from the browser; it deliberately avoids adding a
  `WorkspaceDaemonClient` method, because the route has no workspace segment.
- New `WeixinLoginPanel.tsx` — presentational plus a polling effect. Shows
  account status; a "Log in with QR code" action that starts a flow and renders
  `qrText` in a `<pre>` using the same styling as `LocalControlQrButton`; status
  text for waiting / scanned / ready / expired / error; a refresh action that
  starts a new flow; and a logout action. The poll loop is self-rescheduling and
  keyed on the flow id, not on the status: the daemon reports `waiting`
  repeatedly until the operator scans, so a timer re-armed only on a status
  change would fire once and freeze. It stops on a terminal status and on
  unmount, and retries after a transient request failure (clearing the error on
  the next success) so one network blip cannot strand a panel that renders no
  refresh button while the flow is non-terminal. The api object is held in a
  ref so a host re-render cannot restart the timer. On unmount it cancels a flow
  that is still live: the daemon keeps such a flow — and its upstream polling —
  alive without a browser, so closing the editor would otherwise leak slots
  until four abandoned attempts made every real login answer `429`. The window
  where the start request is still in flight is covered too: the unmount
  cleanup has no id yet, so the resolved response cancels the flow it created
  instead of silently dropping it.
- `ChannelEditorDialog.tsx` — render the panel at the top of the credentials
  section when `descriptor.type === 'weixin'`. The login API arrives as an
  optional prop, matching how every other daemon call in this dialog is injected
  (`listPairingRequests`, `approvePairingRequest`, …); `ChannelsManagerPage`
  constructs it from `useWorkspace()`. This keeps the dialog testable without a
  workspace provider.
- `FIELD_LABEL_KEYS.weixin` plus EN and ZH catalog entries for `groupPolicy`,
  each with a `.description`. The Russian catalog is intentionally
  partial and falls back to EN, so it needs no entries.
- Saving is not blocked on login state. Config and credential are independent,
  and an operator may legitimately pre-configure a channel; the panel states
  plainly that starting requires a logged-in account.

### Capability gating

No new serve capability tag. The panel probes `GET /auth/weixin` and treats
`404` as "this daemon does not support WeChat login", exactly as
`LocalControlQrButton` treats a `404` from `/web-shell/pairing`. This avoids
churning `CONDITIONAL_SERVE_FEATURES`, the pinned table in
`docs/developers/qwen-serve-protocol.md`, and `capability-parity.ts` for a route
that is already behind the `channel_management` UI gate.

## Design decisions and rationale

**Process-global routes, not workspace-scoped.** The credential file is global.
A workspace-scoped route that wrote it would let one trusted workspace replace
the account used by every other workspace's channels — a cross-workspace side
effect from a route whose contract promises to stay inside the resolved runtime.
`registerSubscriptionAuthRoutes` already carries this exact reasoning in a
comment and uses `/auth/...` paths with no workspace segment. We follow it.

**Background flow with a poll endpoint, not client-driven upstream polling.**
`waitForLogin` is already a loop with a refresh budget and a deadline. Running it
once in the daemon and exposing its progress keeps the retry semantics in one
place and means a browser tab cannot multiply upstream requests by polling fast.
The subscription flow route uses the same shape.

**Strict mutation gate on start, cancel, and revoke.** These spend upstream
requests or destroy a credential. The channel pairing reads already use
`mutate({ strict: true })` for the same reason.

**Token never in a response.** `saveAccount` consumes it inside the route. The
view types have no token field, so a future edit cannot accidentally add one
without changing the shared contract. A route test asserts the serialized body
does not contain the token, mirroring
`workspace-channel-management.test.ts:939`.

**Single-option `groupPolicy`.** Declaring it with only `disabled` is honest
about the platform and still satisfies `assertManagementDescriptor`, which
requires the default to be one of the options. Omitting it would make the shared
layer inject all four policies and let an operator enable group modes that the
adapter can never produce.

**No new capability tag.** See above; the 404 probe is an existing, tested
pattern and keeps the contract-test surface unchanged.

## Files affected

| File                                                                             | Change                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/channels/weixin/src/login.ts`                                          | Return the QR URL; events instead of stderr; `AbortSignal`.  |
| `packages/channels/weixin/src/login.test.ts`                                     | Update to the new signatures; add abort and event coverage.  |
| `packages/channels/weixin/src/index.ts`                                          | Add `management` and `envResolvableConfigFields`.            |
| `packages/cli/src/commands/channel/configure.ts`                                 | Print from events; preserve output.                          |
| `packages/sdk-typescript/src/daemon/types.ts`                                    | Two new interfaces.                                          |
| `packages/sdk-typescript/src/daemon/index.ts`                                    | Export them.                                                 |
| `packages/cli/src/serve/routes/weixin-auth.ts`                                   | New route module.                                            |
| `packages/cli/src/serve/routes/weixin-auth.test.ts`                              | New route tests.                                             |
| `packages/cli/src/serve/server.ts`                                               | Register and dispose.                                        |
| `packages/web-shell/client/components/channels/channel-platform.ts` (+ test)     | Allowlist, union, mark.                                      |
| `packages/web-shell/client/components/channels/weixin-auth-api.ts`               | New REST helper.                                             |
| `packages/web-shell/client/components/channels/WeixinLoginPanel.tsx` (+ test)    | New panel.                                                   |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx` (+ test) | Render the panel; new optional prop.                         |
| `packages/web-shell/client/components/channels/ChannelsManagerPage.tsx` (+ test) | Wire the API.                                                |
| `packages/web-shell/client/i18n.tsx` (+ test)                                    | EN and ZH keys.                                              |
| `docs/users/features/channels/weixin.md`                                         | Document the Web Shell path.                                 |
| `docs/developers/qwen-serve-protocol.md`                                         | Describe the new routes in the channel management narrative. |

## Constraints and risks

- **Upstream contract is unverified against a live tenant.** The iLink endpoints
  and response fields are taken from the existing adapter code. No real WeChat
  login is performed by the automated tests; they use a loopback fake iLink
  server. A manual scan against the real platform remains a release checklist
  item.
- **One account per daemon.** Logging in from the browser replaces the account
  used by every running `weixin` channel. Running channels keep their old token
  until restart, because `WeixinAdapter.connect` reads the account once. The
  panel must say that a re-login requires restarting affected channels.
- **QR material is login material.** Anyone who scans the rendered QR binds
  their own WeChat to this bot. The flow view is only served to authenticated
  callers, and flows are short-lived and capped.
- **Global route, no workspace trust gate.** Operator authority is the gate, as
  for the subscription routes. This is a deliberate consequence of the
  credential's scope, not an oversight.
- **Login state can go stale.** The panel reads `account.json` through the route
  on each status fetch; it does not cache across dialog openings.

## Validation plan

Unit and component tests:

- `login.test.ts` — QR URL returned; events emitted for initial QR, scan, and
  refresh; abort settles the loop; retry budget still ends in `expired`.
- `weixin-auth.test.ts` — status reflects `account.json`; start returns a view
  with `qrText`; polling advances waiting → scanned → ready; ready persists the
  account; the serialized body never contains the token; cancel aborts; revoke
  clears the account and cancels flows; the flow cap returns 429; dispose aborts
  everything; a QR rendering failure still yields a usable flow.
- `channel-platform.test.ts` — `weixin` is now available and marked.
- `WeixinLoginPanel.test.tsx` — renders each status; polls and stops on terminal
  status and on unmount; refresh starts a new flow; logout calls revoke; copy
  resolves in both EN and ZH.
- `ChannelEditorDialog.test.tsx` — the panel appears only for `weixin`; saving
  still works while logged out.
- `configure` — terminal output unchanged.

End-to-end plan and results live in `.qwen/e2e-tests/web-shell-weixin-channel.md`.

Repository gates: `npm run build`, `npm run typecheck`, `npm run lint`,
`npm run format`, plus the focused suites above run from their own package
directories.

## Acceptance criteria

1. With `channel_management` available, the Web Shell platform list includes
   WeChat and opens the standard editor.
2. From a logged-out state, an operator can start login, see a scannable QR, and
   reach `ready` without touching a terminal; `account.json` is written `0600`.
3. The editor shows the logged-in account and can log out; after logout the
   status returns to logged-out.
4. No HTTP response body on any of the new routes contains the bot token.
5. `qwen channel configure-weixin` produces the same output as before.
6. Cancelling a flow or shutting down the daemon leaves no running poll loop.
7. EN and ZH both render the new labels and panel copy without falling back to
   raw keys.

## Open questions

- Should a successful re-login offer to restart running `weixin` channels
  automatically? This design only informs the operator; restarting is a channel
  action they already have.
- Should the expired-session (`errcode -14`) state eventually surface in the
  channel card? Tracked as a non-goal here; worth a follow-up issue.
- A private iLink deployment still cannot be reached from the browser login:
  the mint always uses `DEFAULT_BASE_URL`, and `connect()` then prefers the root
  stored at login over any configured one. That is why no `baseUrl` field is
  exposed. Supporting it means fixing the adapter's precedence and giving the
  global login route a root to mint against — worth revisiting if such a
  deployment ever needs the browser path.
- A flow whose client vanishes _after_ the `201` — a page reload, rather than a
  closing dialog — is still not reaped: the id is lost, so no `DELETE` can reach
  it, and it polls upstream until its deadline. The cap now counts only live
  flows, and both the unmount and the pre-response disconnect are covered, but a
  liveness sweep keyed on the last poll would close the remaining window.
