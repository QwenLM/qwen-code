# WebShell Live Voice

## Status

This document defines the implementation contract for Codex-style live voice
in Qwen Code WebShell.

- Implementation base: `origin/main` at
  `9461aa860df6d8d1f68d0c58275d115659843d6b`.
- Reference behavior: Codex Desktop `26.721.41059`, build `5848`.
- Realtime model: `qwen3.5-omni-plus-realtime`.
- Initial native platform: macOS.
- Browser-only fallback: intentionally unsupported.

The existing WebShell voice button remains dictation. Live Voice is a separate
feature with a separate protocol and lifecycle.

## Product contract

After installing Qwen Live Host and granting every required permission, a user
can press a configurable ordinary global shortcut from any application or
macOS Space to start or resume a voice conversation. The default is
`Command+Q`, matching the verified Codex installation. The conversation is
backed by a normal Qwen Code session in a daemon-managed, projectless
Conversations workspace. The user can ask the conversation to inspect the
current screen, use normal Qwen Code tools, or create independent worker
sessions for longer tasks.

Live is available only when all of the following are true:

- Qwen Live Host is installed, running, authenticated to the local daemon, and
  protocol-compatible.
- Microphone is granted to the signed Live Host.
- Accessibility and Screen Recording are granted to the supported CuaDriver
  identity used by Qwen Code.
- microphone capture, audio output, global-shortcut registration, and Appshot
  self-checks pass.
- the Realtime provider, credential, endpoint, and model pass a live readiness
  check.

Missing or revoked permission, a disconnected Host, a protocol mismatch, or an
unavailable provider makes Live unavailable. WebShell must not call browser
`getUserMedia`, fall back to dictation, or offer a reduced Live mode without
Appshot. If readiness is lost during a call, audio stops safely while the
Coordinator and worker sessions remain available.

Input Monitoring is intentionally not requested. The shortcut uses Electron's
`globalShortcut` API with an ordinary accelerator, exactly as the verified
Codex Live shortcut does. Bare-modifier monitoring and the Appshot
`DoubleCommand` helper are unrelated to Live and are not part of this product.

Codex itself grants Accessibility and Screen Recording on demand when the
optional screen-context tool is called. Qwen keeps those two CuaDriver grants
as installation-time hard gates because this product explicitly requires the
full Appshot-capable experience and has no reduced Live mode. This is an
intentional product difference, not an inferred Codex requirement.

`general.liveVoice.enabled` is a restart-time hard gate. When it is false, the
daemon does not advertise `realtime_voice`, publish Host discovery, create the
Conversations runtime, preheat the ACP child or CuaDriver tools, or
probe/connect the Realtime provider. The Host remains disconnected and does
not start audio or CuaDriver permission monitors until it discovers an enabled
daemon.

Live also requires the daemon's ACP HTTP/WebSocket transport because
`/live/host` shares that authenticated upgrade boundary. Starting with
`QWEN_SERVE_ACP_HTTP=0` applies the same boot-time hard gate even when the Live
setting is true: no capability, REST route, Host route, discovery record, or
Conversations runtime is published.

## Verified baseline

### Existing Qwen Code behavior

- `/voice/stream` is one-way browser microphone to ASR. A final transcript is
  inserted into the composer; it is not automatically submitted and there is
  no model audio output.
- `/capabilities` advertises `voice_transcribe`, not Live. Global `qwen` 0.20.0
  returned 404 for `/live/status` in the isolated pre-change dry run.
- `POST /workspaces` already supports daemon-owned managed scratch workspaces,
  but each one consumes a workspace runtime and is process-local. A new scratch
  runtime per voice call would leak runtimes and hit the workspace limit.
- `POST /session` and the daemon bridge support thread-scoped sessions,
  source metadata, parent lineage, session cwd relocation, event replay, and
  normal prompt FIFO ordering.
- `create_sub_session` already creates independent sibling sessions. Its
  `first-turn` mode collects a bounded result, while `sent` currently drains
  completion without notifying the parent.
- background task completion already has the required parent-session semantics:
  a persisted system notification, WebShell rendering, and an automatic model
  turn.
- CuaDriver already exposes permission checks, application/window discovery,
  accessibility text, and per-window PNG capture through `computer_use`.
- `packages/desktop` is an intentionally isolated Bun/Electron product. Its
  Session manager and UI must not be imported into the root workspace, but its
  signing pipeline and transparent always-on-top window patterns are reusable
  inside that isolated build domain.

### Verified Codex Live behavior

The reference build was inspected from its installed signed application and
runtime logs rather than inferred from the Qwen implementation:

- Live uses a configurable Electron `globalShortcut`; the inspected binding is
  `Command+Q`. It does not request Input Monitoring.
- The separately running bare-modifier monitor belongs to Appshot. Its
  `DoubleCommand` means simultaneous left and right Command, not a double tap.
- Live UI and the global overlay remain inside the Codex application. The
  separate Computer Use application only owns screen capture and accessibility
  work; it never renders a thread or owns Realtime.
- The global shortcut resumes the most recent compatible projectless Live
  thread and creates one only when no compatible thread exists. Stopping ends
  the audio transport, not the thread.
- Screen context is an optional, on-demand dynamic tool in Codex. A handoff is
  routed through the persistent voice thread's normal agent turn, which can
  create a separate task through the existing task/session mechanism.

Qwen's browser surface cannot itself own a macOS global shortcut, remain alive
in the background, or provide reliable low-latency system audio. Therefore the
small signed Host below is required. It substitutes only for those missing
native capabilities; WebShell remains the sole session UI and navigation
authority.

### Real Realtime API result

On 2026-07-27 the API key configured for the `qwen3.8-max-preview` provider was
used, without exposing it to a client, to connect to:

```text
wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime
```

The real service successfully completed:

- `session.created` and `session.update`/`session.updated`;
- 16 kHz mono PCM input and accurate transcription;
- 24 kHz PCM output with `response.audio.delta`, `response.audio.done`, and
  `response.done`;
- `semantic_vad` speech start, stop, automatic commit, and automatic response;
- a narrow `delegate_to_coordinator` function call and a final response after
  `function_call_output`.

The current generic WebRTC signalling URL returned 404 and the local provider
configuration has no Bailian Workspace ID. The first implementation therefore
uses the verified server-side WebSocket transport. The endpoint remains
configurable so a workspace-scoped WebRTC transport can be added only after a
real SDP and media-track test passes.

The current selected chat model is not necessarily the provider whose key can
call Realtime. Live credential resolution therefore reads user settings and
the daemon environment only, selects an explicit configured provider entry,
and never accepts project settings or project environment overrides for this
process-global capability. It must not silently use the currently selected
model.

## Architecture

```mermaid
flowchart LR
    U["User"]
    H["Qwen Live Host.app<br/>global shortcut, overlay, microphone, speaker"]
    D["qwen serve<br/>Live state and authenticated host transport"]
    R["Realtime Gateway<br/>Qwen WebSocket adapter"]
    M["qwen3.5-omni-plus-realtime<br/>VAD, interruption, speech"]
    C["Projectless Coordinator<br/>normal Qwen Code session"]
    A["Appshot recipe<br/>computer_use and CuaDriver"]
    W["Worker sessions<br/>create_sub_session"]

    U <--> H
    H <--> D
    D <--> R
    R <--> M
    M -- "delegate_to_coordinator" --> R
    R <--> C
    C --> A
    C --> W
    W -- "background notification" --> C
```

The Realtime model never receives shell, filesystem, computer-use, or worker
management tools. It receives one narrow routing function,
`delegate_to_coordinator`. Calling it authorizes routing only; its model-written
arguments are never treated as a user request. All approvals, sandboxing,
screen inspection, conversation rotation, tools, and worker creation happen in
a normal Qwen Code session from the uniquely correlated final input transcript.

## Native Live Host

### Packaging boundary

Create a dedicated app under `packages/desktop/apps/live-host`. It is built and
signed in the existing desktop isolation domain but has its own product and
bundle identity:

```text
Qwen Live Host.app
com.alibaba.qwen-code.live-host
```

It must not start or reuse the Desktop workspace server, Session manager, or
main renderer. It must never load the daemon WebShell, attach bearer headers to
a page, or create a session browser window. Its only UI is a small transparent
overlay and a settings/status surface for installation and permissions. It
runs as an accessory app, stays alive without visible windows, and can be
enabled as a login item.

The preload API is deliberately narrow: toggle, new conversation, stop,
input/output mute, permission action, and state subscription. Model
credentials, daemon bearer tokens, session navigation, and direct Realtime
access are never exposed to the renderer.

### Global shortcut

The daemon includes the configured accelerator in every protocol status. The
Host registers it with Electron `globalShortcut.register`, reports the
registration result as a self-check, and fails closed if registration is
rejected or conflicts with another application. Changing the shortcut requires
a daemon restart, matching the rest of `general.liveVoice`.

The initial default is `Command+Q`. The Host owns one registration and one
`toggleLive()` path, replaces the registration idempotently when a new daemon
configuration is received, and unregisters it on exit. There is no native
keyboard helper, event tap, bare-modifier recognition, or Input Monitoring
request.

### Audio and overlay

Microphone capture happens only in the installed Host. The Host converts input
to 16 kHz mono signed PCM and sends binary audio frames to the daemon. It plays
24 kHz signed PCM returned by the daemon and drops queued output immediately on
barge-in or stop.

Initialize, recheck, capture, and dispose share one generation-aware lifecycle
queue. Dispose invalidates capture, output, and device listeners synchronously,
then closes old contexts before a replacement initialize or capture may run.
Queued work from an older Host/daemon generation is discarded.

The overlay is frameless, transparent, always on top, visible on all Spaces,
and shown without stealing focus. It displays readiness, listening/thinking/
speaking state, recent transcript, mute controls, and stop. It never opens or
embeds session content. Empty transparent regions are click-through; every
interactive control explicitly opts back into pointer handling.

### Appshot responsibility

The Host does not implement a second screen-capture stack. Qwen Code continues
to use the pinned CuaDriver identity for Accessibility and Screen Recording.
The Live installation/status workflow starts that driver and surfaces the
three required grants (Host microphone, CuaDriver Accessibility, and CuaDriver
Screen Recording) as one readiness checklist. This avoids two competing CUA
bundle identities and duplicate TCC grants.

The Host accepts permission results only when the pinned driver's status wire
attributes them to `source.attribution: "driver-daemon"`. Caller-attributed,
standalone, IDE/terminal, and source-less results cannot satisfy the hard gate,
even if their permission booleans are true.

## Daemon Live service

Live is process-global rather than workspace-scoped. A `LiveCoordinator` owns:

- at most one authenticated Host connection;
- at most one active call epoch and audio owner;
- the call state machine;
- the Realtime gateway;
- the active/resumable Coordinator locator;
- Host and CuaDriver readiness;
- process-global status consumed by bounded WebShell polling.

The existing `/voice/stream` and `WorkspaceVoiceCoordinator` are unchanged.

### Routes

```text
GET    /live/status
POST   /live/start
POST   /live/new
POST   /live/stop
POST   /live/mute
WS     /live/host
```

`/live/host` uses the same no-server WebSocket upgrade boundary as `/acp` and
`/voice/stream`: loopback-only deployment assumptions, bearer validation when
configured, strict path/host/origin checks, frame and queue limits, heartbeat,
and deterministic close codes. The handshake includes protocol version, Host
version, bundle identity, instance nonce, permissions, and self-checks. A
second Host is rejected while the current lease is healthy.

Protocol v3 Host input frames contain an eight-byte big-endian call epoch
followed by the bounded PCM16 payload. The capture generation freezes that
epoch before audio enters IPC, and the daemon discards any frame whose epoch no
longer owns the active call. This prevents queued audio from an old call from
crossing an HTTP `/live/new` boundary.

Protocol v3 removes Input Monitoring and Host-driven session navigation and
adds the configured ordinary accelerator to `LiveStatus`. Protocol v2 Hosts
are rejected instead of being optimistically adapted.

The daemon maintains one richer process-global status for WebShell, including
Coordinator and worker locators. Before every Host welcome or state message it
projects that value onto the narrower `LiveHostStatus` wire type. Session IDs,
workspace paths, Coordinator metadata, and worker locators therefore never
cross into the native Host renderer or its IPC state.

`GET /live/status` returns only non-secret state:

```ts
type LiveStatus = {
  available: boolean;
  state:
    | 'unavailable'
    | 'idle'
    | 'starting'
    | 'listening'
    | 'thinking'
    | 'speaking'
    | 'stopping'
    | 'error';
  blocker?:
    | 'host_missing'
    | 'host_disconnected'
    | 'host_version'
    | 'microphone_permission'
    | 'accessibility_permission'
    | 'screen_recording_permission'
    | 'audio_input'
    | 'audio_output'
    | 'global_shortcut'
    | 'appshot'
    | 'provider_config'
    | 'provider_unreachable';
  shortcut: string;
  callId?: string;
  coordinator?: { workspaceCwd: string; sessionId: string };
};
```

### Discovery

The daemon publishes a mode-0600 process-global Host locator at
`~/.qwen/live/daemon.json`, independent of `QWEN_RUNTIME_DIR` and
`advanced.runtimeOutputDir`, so a Finder- or Login Item-launched Host can find
it without inheriting CLI environment variables. The record contains the
loopback URL, protocol version, daemon PID, instance nonce, and bearer token
when one is required. Writes are atomic. A daemon cannot replace a live owner;
it may reclaim only a stale record. An enabled waiting daemon retries ownership
on one low-frequency timer and takes over after the owner removes its record;
shutdown cancels that retry and removes a record only when the nonce and PID
still identify that daemon. PID reuse is conservative: because the locator has
no independent authenticated nonce-liveness endpoint, any live process with the
recorded PID delays reclamation rather than risking replacement of a live
daemon. The runtime-local record may remain for diagnostics, but the stable
locator is authoritative for the Host. Tokens never appear in URLs, renderer
state, logs, or process arguments.

The Host coalesces overlapping locator reads and generation-gates their
results. A read started before monitor shutdown cannot reconnect the Host or
overwrite a newer discovery state after restart.

## Realtime gateway

### Configuration

Add settings separate from dictation:

```json
{
  "general": {
    "liveVoice": {
      "enabled": false,
      "model": "qwen3.5-omni-plus-realtime",
      "providerModel": "openai:qwen3.8-max-preview",
      "endpoint": "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
      "voice": "Tina",
      "shortcut": "Command+Q"
    }
  }
}
```

`providerModel` uses the existing auth-type/model selector semantics. It must
resolve to exactly one configured provider entry; duplicate matching model IDs
are rejected as ambiguous instead of guessed from the current model or base
URL. The daemon resolves that entry's required `envKey` from the frozen daemon
environment or user-level `settings.env`, validates that the provider is a
supported DashScope/Bailian route, and substitutes only the upstream Realtime
model.
`voiceModel` remains dedicated to ASR dictation.

The endpoint override is advanced configuration. The first implementation
accepts only TLS endpoints on supported DashScope/Bailian hosts; it has no
private-network or non-TLS development escape hatch.

The daemon snapshots the complete Live configuration and credential source at
startup. The restart-time `enabled` gate, capability advertisement, provider
resolution, endpoint, voice, and shortcut all read that same immutable
snapshot; a partially hot-reloaded Live service is not allowed.

### Upstream session

The adapter sends a `session.update` that configures:

- 16 kHz PCM input and 24 kHz PCM output;
- input transcription;
- `semantic_vad` with automatic response and interruption;
- text and audio output;
- a concise Live frontend prompt;
- one narrow `delegate_to_coordinator` routing function.

Every completed meaningful user turn delegates to the Coordinator. The
uniquely correlated final input transcript is the authoritative verbatim
request; model function arguments are ignored except for provider correlation
identifiers. A missing, reused, conflicting, or ambiguous transcript fails
closed. Tool output is the Coordinator's authoritative response. Realtime then
produces the natural spoken answer. Upstream tool requests are correlated by
call ID and call epoch; stale results are persisted to the Coordinator but
never spoken into a newer call.

The provider currently supports autonomous `tool_choice` only; it can choose to
answer a user turn directly even when instructed to delegate. Therefore all
text and audio from the initial user-response phase are authority-gated and
suppressed until an approved narrow function is observed. If a completed
response contains no approved function, the adapter may synthesize exactly one
`delegate_to_coordinator` request from the uniquely associated, bounded final
input transcript. Its result returns through the same trusted Coordinator
update path, never as a fabricated provider `function_call_output`. Missing,
empty, reused, or ambiguous transcript correlation fails closed. Duplicate
representations of the same provider call ID are idempotent; conflicting or
multiple approved calls in one response are rejected.

If a connection closes after a final input transcript exists but before its
delegation reaches the Coordinator, the call fails explicitly unless the
daemon can transfer that exact turn into a replacement connection with
exactly-once ownership. It must never return to `listening` while silently
dropping the utterance.

Transcript fallback also has a trusted model-control escape hatch for an
explicit request to reset the current Live conversation. Each delegation gets
a random nonce in bridge-only model context. Only an `end_turn` whose complete
Coordinator text exactly matches that nonce-bearing control rotates Live; a
wrong nonce, surrounding text, or any other stop reason is ordinary output.
The adapter never classifies the user's language itself. The internal control
assistant message remains in the old Coordinator's raw transcript; it is not
forwarded to Realtime or spoken. Avoiding that record would require a broader
private ACP tool/control channel and is outside this fallback's scope.

The adapter handles VAD start/stop, input transcript deltas/finals, output text
and audio deltas, function argument deltas/finals, response completion, rate
limits, provider errors, reconnect, and cancellation. A VAD speech-start event
while output is playing first tells the Host to clear playback, then cancels
the upstream response.

An upstream connection reaching its scheduled maximum age is rotated only at
an observed idle boundary: no speech or uncommitted input, response, delegated
turn, or authorized follow-up response may still be pending. A bounded drain
deadline fails the call explicitly instead of truncating an unknown tail.
An explicit stop keeps the same Host call epoch in `stopping` until the
Coordinator confirms the drain outcome. With no observed speech, or with an
empty final transcript, it closes without committing an empty buffer or
creating a Conversation. Otherwise it waits up to 30 seconds for the exact
final transcript for every committed input item to be admitted to the
Coordinator session. Commit, final transcript, untrusted provider response,
and prompt-admission state are tracked per provider input item rather than by
one call-wide boolean. This matters when item A is already admitted while item
B is committed but its final transcript is still in flight: completion of A
cannot close the socket or erase B. A deadline or fatal Realtime error becomes
a visible WebShell error; each final transcript that was not yet delegated is
submitted exactly once to the session, while an already admitted prompt is
never submitted again. Committed speech for which no final transcript can be
recovered records an explicit stop-failure turn; uncommitted noise does not
create an empty Coordinator.

An explicit `new` action during an active call is serialized through the same
stop drain. The old call remains in `stopping` until its exact pending input is
persisted, then and only then may the replacement epoch start. A persistence
failure prevents replacement, and an explicit stop cancels a queued
replacement. A Coordinator-requested conversation reset uses the same handoff
without awaiting the new call from inside the delegating turn, avoiding a
self-deadlock on that turn's drain.
Network-unreachable readiness is re-probed by one slow background timer only
while Live is enabled, a Host has completed its handshake, and no call is
active. A successful probe clears the temporary override. Configuration
failures are not retried in a loop. Authentication, model, and endpoint
rejections are terminal `provider_config` failures. Network errors, 429s, and
retryable 5xx responses use bounded backoff and provider `retry_after` when
available; no category is converted into an unbounded retry loop.

## Projectless Coordinator lifecycle

### Conversations workspace

Do not create one managed-scratch runtime per call. The daemon owns one durable
Conversations workspace:

```text
~/Documents/Qwen Code/Conversations/
```

It is created with mode 0700, registered as a daemon-managed trusted runtime,
and restored on daemon startup. Each materialized Live conversation gets a
deterministic server-generated child directory derived from the session ID,
such as:

```text
~/Documents/Qwen Code/Conversations/conversation-<sha256(session-id)>/
```

The browser and Host never submit an arbitrary cwd. Session cwd relocation is
allowed only to the expected owned, mode-0700, non-symlink direct child of the
Conversations root. Resume derives and revalidates the same directory from the
persisted session ID, then reapplies the relocation before accepting a prompt.
If a resumed Coordinator already has an active prompt, it was relocated before
that prompt began, so resume does not queue a redundant cwd change behind the
active turn. No client-provided path or separate mutable mapping is trusted.

The fixed Conversations root may be nested under a broad primary workspace
such as the user's home directory. This is an intentional exception only for
the exact daemon-owned `live-conversation` runtime. User-selected and scratch
runtimes retain the normal no-nesting admission rule, and all Live catalog,
session, filesystem, bridge, and relocation operations resolve the exact owned
runtime instead of falling back to the primary runtime.

Generic runtime entry points cannot be used to smuggle work into the Live
runtime. REST and ACP new/fork, scheduled-task, channel, keepalive, and ordinary
workspace-management paths reject the `live-conversation` runtime. The only
allowed load/resume path is for a compatible Coordinator or its direct worker,
as proven by persisted source and parent-lineage metadata. Before accepting a
prompt, the daemon derives and materializes the exact deterministic directory
from the persisted session ID and applies the managed relocation. An already
active entry must already report that exact directory. Unknown or incompatible
lineage, root-level or symlinked directories, relocation mismatches, and active
cwd mismatches fail closed and never fall back to the primary runtime. The cwd
relocation itself is runtime state, not a separately persisted trust claim.

### Provisional and resume behavior

Starting audio creates only a provisional call. The first meaningful user
utterance atomically creates the directory and a thread-scoped Coordinator.
Stopping before that leaves no visible session or directory.

For compatibility with the current WebShell catalog, the first implementation
stores the session as the normal/default source type with a versioned
`sourceId` prefixed by `realtime_voice:p1:h1:a1:`. The three version components
cover the Live prompt, handoff protocol, and Appshot recipe. This preserves Live
provenance while keeping the conversation visible in existing overview/resume
queries. A future catalog API that accepts multiple source types can migrate to
a dedicated `realtime_voice` source type without hiding sessions.

The global shortcut resumes the most recently active compatible Live
Coordinator.
Compatibility includes the Live prompt version, handoff protocol version, and
Appshot schema version. An explicit “new conversation” action skips resume.
Resume reuses the persistent Coordinator and waits for the user to speak; it
never greets proactively. The Realtime frontend starts with a fresh transport
and does not receive old conversation text. Continuity comes from the normal
Coordinator history on the next delegated turn, avoiding a second divergent
conversation-memory copy.

Stopping Live closes only the Realtime/audio call. The Coordinator and workers
remain normal sessions.

While a Live call owns a materialized Coordinator or worker, ordinary close,
delete, and archive mutations are rejected. REST returns HTTP 409 with
`live_session_active`; ACP returns `INVALID_REQUEST` with the same error kind
and session ID. This prevents deleting a transcript or worker that the active
audio call can still address. Once Live has stopped and released the call,
those normal mutations proceed unchanged.

## Coordinator and workers

The Coordinator receives the spoken request as the normal persisted user
message. A trusted bridge-only model context carries the structured
`<realtime_delegation>` instructions below; clients cannot supply this context,
and it is not echoed into the transcript. Its Live instruction says:

- answer ordinary questions and quick tool checks in the current session;
- use `computer_use` only for explicit deictic screen requests;
- use `create_sub_session` when the user explicitly asks for a new task/session
  or when independent long-running work is appropriate;
- return the exact trusted nonce control only when the user explicitly resets
  or switches the current Live voice conversation;
- return a concise speakable result while leaving detailed artifacts in the
  session or worker.

“Capture screen context” is a constrained Coordinator recipe over the existing
CuaDriver: discover the frontmost non-Host window and call
`get_window_state` for its accessibility tree and PNG. A target-window capture
does not include the separate Live overlay window. Ordinary conversation does
not poll or capture the screen.

The “explicit screen request” decision is a trusted Coordinator instruction,
not a daemon-side natural-language classifier. The enforceable boundaries are
that Realtime has no CUA tool, screen content is marked untrusted, and normal
Qwen tool approval/sandbox rules remain in force. Prompt-injection behavior is
therefore a required real E2E case instead of an overclaimed lexical hard gate.
While a Host is connected, the daemon periodically re-probes the Conversations
runtime's ACP channel and required Appshot tools. A lost channel or disabled
tool makes Appshot unavailable and stops an active call when the next bounded
probe completes. The production cadence is five seconds and each probe has a
five-second timeout, so the nominal detection bound is ten seconds plus event
loop scheduling delay. Recovery must pass the same probe before Live becomes
ready again.

For `create_sub_session` in `sent` mode, reuse the bounded first-turn collector
and add a parent-scoped background-notification bridge method. The ACP child
enqueues the existing task-notification shape into the parent Session so it is
persisted, rendered by WebShell, and consumed by a normal automatic Coordinator
turn. The notification includes the child session locator and a bounded result
or error. If the same Live call epoch is still active, its concise update may
be returned to Realtime; otherwise it remains in session history.

Worker discovery for the Host overlay trusts only a completed
`create_sub_session` tool result emitted on the Coordinator subscription and
accepts only the tool's exact, single bounded display locator. Any appended
text or second URI fails closed. Session-like URIs in assistant text, screen
content, tool arguments, failed calls, background notifications, or results
from another tool never register a worker. Before publication, the daemon
reads the child transcript and requires its persisted parent lineage to equal
the active Coordinator. The resulting locator uses the exact owned Live
runtime.

## WebShell

WebShell adds a Live control separate from the current dictation microphone.
It reads the process-global `LiveStatus` with visibility-aware bounded polling,
shows permission/provider blockers, and enables start only when `available` is
true. It never opens a browser microphone. Session navigation remains entirely
inside the existing WebShell: Coordinator and worker buttons dispatch the same
workspace-qualified navigation event used by other WebShell surfaces.

The active-call surface shows state, transcript, Coordinator, and worker links.
Opening a link loads the supplied `{workspaceCwd, sessionId}` locator. Worker
links must not rely on a bare `qwen-session://<id>` when the target may be in a
different runtime.

Screen-aware requests use the same frontmost-window CuaDriver recipe whether
Qwen or another application is foreground. WebShell does not publish page state
or credentials into the Live protocol.

## Failure and security rules

- API keys stay in daemon memory and are redacted from logs and errors.
- Audio and Appshot payloads have explicit frame, image, text, and queue caps.
- Only one call epoch owns input and output. Reconnect cannot create a second
  audio owner or duplicate Coordinator.
- Permission revocation, Host exit, CuaDriver exit, or protocol mismatch stops
  the active call and fails closed.
- Audio device changes invalidate both input and output readiness before any
  recheck. Only a completed renderer self-check can restore readiness.
- Overlay renderer failures fail closed and permit at most three rebuilds per
  Host process. A load-crash loop does not reset that budget; restarting the
  Host creates a new recovery budget.
- Disabled Live performs no Conversations, ACP/Appshot, CuaDriver, or provider
  startup work.
- Initial provider text/audio has no speaking authority. Only an approved
  narrow tool result or trusted Coordinator update can reach Host playback.
- Upstream reconnect preserves the Coordinator identity but does not replay old
  output audio or duplicate a delegation.
- Appshot is explicit and pull-only. There is no continuous screen stream.
- Conversation directories are generated and containment-checked by the
  daemon. Symlinks may not escape the Conversations root.
- Host and daemon version skew fails closed on exact protocol equality. A
  future rolling-compatibility requirement must introduce explicit min/max
  negotiation rather than optimistic feature detection.

The signed installed Host and its TCC grants are product and packaging
requirements. The daemon authenticates the Host at the same-user boundary with
the mode-0600 discovery bearer and instance nonce; it cannot remotely attest a
macOS code signature from a WebSocket peer. The protocol must not claim stronger
identity proof without an XPC/Unix-peer attestation design.

## Delivery slices and real validation gates

1. **Protocol and provider**: unit-test the Realtime adapter with a fake server,
   then repeat the real handshake, audio, semantic VAD, output audio, and narrow
   tool-call test using the configured qwen3.8 provider credential.
2. **Daemon and Coordinator**: use a protocol test Host to verify hard gating,
   provisional materialization, resume/new, real model prompt completion, and
   no API key leakage.
3. **Signed Host**: build/install the app; verify signing, exact bundle
   identity, the product pair's three TCC grants (Host microphone plus CuaDriver
   Screen Recording and Accessibility), audio input/output, ordinary global
   shortcut, shortcut-conflict handling, and fail-closed revocation behavior.
   Confirm the package contains no keyboard monitor and the process never
   creates a WebShell/session window.
4. **Appshot and workers**: run real foreground-window capture and real
   `create_sub_session` cases, including completion return to the parent.
5. **WebShell and full acceptance**: build/typecheck/focused tests, run the local
   bundled daemon with the real Realtime model, and use Computer Use to execute
   every case in `.qwen/e2e-tests/web-shell-live-voice-alignment.md` across
   Chrome, Finder/editor, full-screen, and multiple Spaces.

No slice is considered complete solely from mocks. Each gate records the exact
binary/SHA, Host bundle version, model, provider route, event sequence, and
redacted evidence.
