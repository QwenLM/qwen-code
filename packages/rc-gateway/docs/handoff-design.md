# Terminal → mobile handoff (design)

**Goal.** Work in the terminal qwen TUI locally; when you step away, pick the
**same** conversation up in the mobile web UI (or a bridge), and hand it back.
Terminal-first is the point — the browser is the away-from-keyboard surface, not
a replacement for the TUI.

**Status.** Design only. This proposes the first substantial change outside
`packages/rc-gateway/` (the TUI), so it is written down and decided before any
core edit. Sized against the real code (see citations).

---

## The key realization: the daemon already supports handoff

`qwen serve` (the daemon the rc-gateway already drives) is built for exactly this.
Verified in the code, not assumed:

- **One session, many clients.** `POST /session` with `sessionScope:'single'`
  (the default) **attaches** to the workspace's existing session instead of
  creating a new one; every attach is registered as a distinct `clientId`
  (`httpAcpBridge.ts` spawnOrAttach ~2486–2663, SessionEntry.clientIds ~308–410).
- **Sessions survive a client leaving.** When a client's SSE closes the session
  is **not** reaped while other clients remain attached; only the spawn-owner's
  disconnect _with zero attaches_ reaps it (`killSession requireZeroAttaches`,
  detachClient ~3715–3838). → If one always-on client (the gateway) stays
  attached, the session never dies just because the terminal detached.
- **Catch-up on attach.** SSE `/session/:id/events` honors `Last-Event-ID` and
  replays missed frames from a per-session ring (~8000 frames), and there is a
  `resume` path that replays prior turns — so a phone attaching mid-conversation
  sees the history (DaemonClient.subscribeEvents/resumeSession).
- **Permissions are already multi-client.** A tool-approval request is broadcast
  to every attached client's event stream; the **first** valid vote wins and a
  `permission_resolved` is broadcast to all; later votes get 404 (requestPermission
  ~513–560, resolvePending ~1530–1561). This _is_ the handoff approval model.

So the daemon layer needs **no changes**. Handoff is "terminal detaches, phone
attaches" — operations the daemon performs today.

## Where the work actually is

Three components, very unequal in size:

| Component                  | Change                                                               | Size             | Boundary            |
| -------------------------- | -------------------------------------------------------------------- | ---------------- | ------------------- |
| **Daemon** (`qwen serve`)  | none                                                                 | —                | upstream, untouched |
| **Gateway** (`rc-gateway`) | attach to an external daemon instead of spawning its own             | **small**        | **in our boundary** |
| **Terminal TUI**           | render a _daemon-hosted_ session instead of its own in-process agent | **medium–large** | core (new diff)     |

### 1. Gateway: attach-mode (small, ours)

Today the gateway **always spawns** its own daemon: `startDaemon({port})` in
`daemonSupervisor.ts:72–107` (called once at `cli.ts:193`), mints a
`QWEN_SERVER_TOKEN`, health-polls, returns `{ daemon, stop }`. Everything
downstream is a **stateless proxy** — the gateway never creates sessions, it just
`listWorkspaceSessions()` + proxies prompt/vote/events by id (confirmed: no
`createOrAttachSession` call anywhere in `rc-gateway/src`).

Change: give `startDaemon` an **attach branch** — when handed an existing daemon
URL + token, build a `DaemonClient` against it and return a handle whose `stop()`
is a **no-op** (don't kill a daemon we didn't spawn). The health-poll already
works against a running daemon. That's the whole gateway-side change; every route
keeps working because they only ever call `daemon.<method>()`.

This is independently useful and shippable on its own (point the gateway at a
hand-started daemon), and it's the hook the launcher (below) uses.

### 2. Terminal TUI: daemon-client rendering mode (the real feature)

Today the TUI runs a **private in-process agent**: `Config.getGeminiClient()` →
`useGeminiStream` calls `geminiClient.sendMessageStream(...)`, executes tools
**in-process** via `useReactToolScheduler`, and answers permission **locally** via
a `confirmationDetails.onConfirm()` callback (AppContainer ~1394/1603/1621,
useGeminiStream ~1373–1627, 1842, 2050–2366). It is tightly coupled to the
in-process client — there is no seam to swap a remote backend in.

The clean strategy (per the exploration's own recommendation): a **parallel
`useDaemonStream` hook** that reproduces the existing UI **output contract**
(`addItem`, `pendingHistoryItem`, tool-call display, the permission prompt) but is
sourced from a **DaemonClient** session over loopback HTTP/SSE — the same
transport the gateway uses. The in-process `useGeminiStream` stays untouched for
normal `qwen`; the new hook powers an opt-in "attached" mode.

What inverts in this mode (and why it's correct for handoff):

- **Tools run in the daemon, not the TUI.** The daemon executes shell/file ops and
  _requests_ permission; the TUI only **renders** `tool_call`/`tool_call_update`
  and **sends a decision** (`respondToSessionPermission`). Same machine, so effects
  are identical — and this is _mandatory_ anyway, because the phone can't execute
  local tools; the daemon must own execution for any client to drive it.
- **Permission flow flips** from imperative callback to "receive `permission_request`
  event → render → POST a vote." First-responder-wins across terminal **and**
  phone falls out of the daemon's existing broadcast model.
- **Streaming/thought/finished rendering is mostly reusable** — daemon
  `session_update` frames are a projection of the same core event stream the UI
  already renders.

This hook is the cost center. It is **bounded** (one new hook + the mode plumbing,
not a rewrite of the TUI) and **upstream-shaped** (it's how qwen-code would build
`qwen attach`), so it can be proposed upstream rather than carried as a permanent
fork burden.

### 3. Launcher: one command (small glue)

`qwen --remote-control` (opt-in flag; normal `qwen` is untouched):

1. spawn one `qwen serve` daemon (it owns the `QWEN_SERVER_TOKEN`);
2. start the **gateway in attach-mode** against it (the gateway is the always-on
   attached client that keeps the session alive across terminal detach);
3. create/attach the workspace session and run the **TUI in daemon-client mode**
   against it;
4. print the `/ui` URL + pairing code so the phone can join.

On terminal exit the daemon + gateway keep running iff you want the session to
remain reachable from the phone; on full teardown everything stops. Because the
launcher spawns the daemon and the **gateway** attaches (not as spawn-owner), the
terminal can come and go without reaping the session.

## The handoff flow (concrete)

1. `qwen --remote-control` in your project. Daemon + gateway up; TUI renders the
   shared session; banner prints `…/ui/` + pairing code.
2. You work in the terminal exactly as normal.
3. Step away → open `/ui` on your phone → it attaches to the **same** session;
   `Last-Event-ID`/resume replays the conversation so far.
4. You continue on the phone. A tool wants approval → the request shows on **both**
   surfaces; you tap approve; `permission_resolved` broadcasts; the terminal
   reflects it. First responder wins.
5. Back at the desk → the terminal is still attached (or re-attach); keep going.

## Phasing

- **Phase 1 — Gateway attach-mode** ✅ **shipped**. The gateway can now attach to
  an externally-started daemon instead of spawning its own, so the terminal's
  `qwen serve` and the gateway share one daemon (and its sessions). `startDaemon`
  gained an `attach` branch (no spawn; `stop()` is a no-op — never kill a daemon we
  did not start), surfaced as `--attach-daemon <url> --daemon-token <tok>` (or
  `QWEN_RC_DAEMON_URL` / `QWEN_RC_DAEMON_TOKEN`). Unit-tested (attach shares the
  daemon, never spawns, `stop()` doesn't kill; unreachable → throws without
  spawning) and smoke-verified end-to-end (the full gateway boots attached and
  serves `/rc/health`).

  **Try it:**

  ```bash
  # 1. Start a daemon yourself with a known token:
  QWEN_SERVER_TOKEN=devtok qwen serve --hostname 127.0.0.1 --port 4180 --require-auth
  # 2. Point the gateway at it (it will NOT spawn its own, and won't kill it on exit):
  qwen-rc serve --attach-daemon http://127.0.0.1:4180 --daemon-token devtok
  ```

  Mobile/web clients then see that daemon's sessions. (Making the _terminal TUI_
  drive that same daemon session is Phase 2.)

- **Phase 2 — `useDaemonStream` daemon-client TUI mode** (the core feature).
  **Specced** in [phase2-daemon-tui.md](./phase2-daemon-tui.md) — the parallel hook
  that renders a daemon-hosted session in the rich TUI, the three inversions
  (streaming source / tool-call projection / permission round-trip), the opt-in
  `--attach-daemon` wiring, and the "grows" slicing. Built behind an opt-in flag;
  `useGeminiStream` stays the default path untouched. The hook logic + a live
  loopback `qwen serve` round-trip are **verifiable in the sandbox** (the daemon
  boots here — the old "WSL timeout" was a supervisor bug, not the environment);
  only the **interactive TUI/handoff feel** needs a real terminal + phone.
- **Phase 3 — `qwen --remote-control` launcher + handoff polish** (small glue once
  1 & 2 exist).

## Risks / open questions

- **Feature parity in daemon-client mode.** Model-switch, slash commands, etc. must
  work attached. Some are daemon-backed (model endpoint, `available_commands_update`);
  some are client-local. Parity is the main scope risk — hence start with a focused
  subset (text + tool approval + model switch) and grow.
- **Fork divergence.** Phase 2/3 are real core diffs. Mitigation: build Phase 2 as a
  clean parallel hook so it's upstream-proposable.
- **Spawn-owner reap subtlety.** The launcher must spawn the daemon and let the
  _gateway_ be a persistent attacher, so a terminal detach can't trip the
  zero-attaches reap.
- **Decisions (locked by the user):** (a) Phase-2 scope — **grows**: a focused first
  subset (text + tool approval + model switch), expanding toward parity. (b)
  **Opt-in** — default `qwen` untouched; the daemon-client path is flag-gated. (c)
  **Fork-first**, with the hook shaped to be upstream-proposable later.
