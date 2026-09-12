# @qwen-code/qwen-live

Standalone Live voice daemon: a realtime voice control plane that orchestrates
coding sessions through voice.

`qwen-live` connects three parties:

- **Live Host** (the macOS overlay app) over the Live Host WebSocket
  protocol v9 — writes `~/.qwen/live/daemon.json` for discovery, so an
  already-installed Host connects automatically.
- **A DashScope realtime voice model** (`qwen-omni` realtime) that owns the
  conversation: VAD, direct answers, and a tool surface for dispatching work
  to coding sessions.
- **Coding sessions** through a `BackendAdaptor`. Two adaptors are available:
  one drives `qwen serve` over REST/SSE, and one spawns any ACP-compatible
  agent (`qwen --acp`, `qodercli --acp`, `gemini --acp`, etc.) as a child
  process over JSON-RPC stdio. Multiple backends can coexist with per-session
  routing.

The live session itself is fully owned by this daemon (JSONL logs under
`~/.qwen-live/sessions/`); backend sessions are ordinary coding sessions
that keep running after a call ends.

Memory is enabled by default. Local libraries under `~/.qwen-live/memories/`
retain dialogue, selected user facts and optional visual observations across
calls. The orb's Settings → Memory section controls the feature, selected library, names and
consolidation model. See [Memory configuration and behavior](#memory).

## Quick Start

### 1. Install

Qwen Live requires Node.js 22.13 or newer for built-in SQLite/FTS5 support.

```bash
# From the qwen-code monorepo
cd qwen-code
npm install && npm run build
```

### 2. Run the setup wizard

```bash
node packages/qwen-live/dist/index.js init
```

The wizard will:

- First let you choose **简体中文 / English** with the **Left / Right** arrow
  keys and Enter. All following questions and fixed setup messages use that
  language; a fresh setup initially selects Simplified Chinese.
- Scan your PATH for installed coding agents (qodercli, qwen, gemini,
  claude, codex) and list what it found
- Let you pick a default backend and add additional ones
- Ask for your DashScope realtime API key
- Let you select the DashScope Realtime API name (the default is
  `qwen3.5-omni-plus-realtime`)
- Ask whether to enable Memory (default: yes), then ask for the DashScope
  consolidation model when enabled (default: `qwen3.7-plus`)
- Set a default working directory for coding sessions
- On macOS: check if the Live Host app is installed and offer to install it

When done, it writes `~/.qwen-live/config.json` and tells you to run
`qwen-live` to start.

### 3. Start the daemon

```bash
qwen-live
# → qwen-live listening on http://127.0.0.1:<port>
```

On macOS, open the Live Host app — it reads the discovery file and connects
automatically. Once the Host connection, selected-source permissions and
self-checks are ready, a newly launched Host starts one call automatically.
An existing call or an explicit start/stop/new/quit consumes that startup
intention; reconnects, renderer reloads and failed starts never loop into a
new call. Press `Command+E` to start or end a call manually (an explicitly
configured shortcut still takes precedence).

The setup panel and orb first appear at the bottom-right. Drag the setup
header or orb to move them; Host remembers the shared position across restarts
and clamps it to a visible display if monitors change. Hover the orb to reveal
microphone, voice output, Start/End call, Settings and Quit controls. They fade
one second after the pointer leaves, unless settings or keyboard focus need
them. Ending a call leaves a gray orb in place; it does not quit the app.

Settings presents Audio Source, Video Source and Capture Mode as peer groups,
followed by Memory. The selected mode shows its own explanation. It preserves focus,
drafts and camera preview while state changes, and closes on Escape or outside
interaction. Setup asks only for the selected source's permissions, so Camera
does not require screen recording or accessibility permission. The orb uses
compact visible bounds when dragged to an edge; opening Settings temporarily
fits the whole panel on screen, without replacing the saved resting position.
Camera selection shows a nearby preview by default. Its floating eye button
only hides/shows the preview; it does not stop camera input or frame delivery.
Selecting Screen or quitting retains the existing camera shutdown behavior.

**Open config.json ↗** at the top of Settings opens the connected standalone
daemon's actual configuration in the OS-associated JSON editor or IDE. This
respects the daemon's `QWEN_LIVE_DATA_DIR`, even when Host starts separately.
Save the file and restart Qwen Live to apply manual edits. Older daemons and
built-in `qwen serve` do not advertise this action. Missing, non-regular (including
symlink) files or editor failures show an error; the action never creates or
overwrites configuration.

**Language** is followed by Theme at the end of Settings. It switches the fixed Live interface
between English and Simplified Chinese and saves the selection in the top-level
`language` config field (`"en"` or `"zh-CN"`). Existing configs without the field
remain English. Language changes apply during a call without restarting media;
model prompts, responses, transcripts and user/device/library names are not
translated. A connected standalone daemon owns the saved preference. With a
legacy Host connection, the selection is saved only in Host's local preference.

Drag the Settings title bar to move the panel; it shares the orb's remembered
position. Opening Settings first fits the whole panel into the display work
area and waits for native positioning before showing it. Microphone animation
now amplifies small input peaks visually, with a bounded envelope and smooth
release; it does not change the recorded audio gain.

All fixed Live display translations are maintained as paired `en` / `zh-CN`
entries in [`src/i18n/messages.ts`](src/i18n/messages.ts). Edit both values there,
preserve matching `{placeholders}`, then rebuild Live and Host. Host compiles
this same public, browser-safe module into its bundle; no second dictionary or
runtime language-pack installation is needed. Technical diagnostics and raw
external error details retain their original language.

`Quit Host` gracefully shuts down the connected standalone Live daemon and
Host, including owned ACP processes, Memory work and discovery. It does not
terminate an independently running `qwen serve`. A legacy WebShell connection
only ends its Live call and closes Host. If shutdown is not confirmed, the
orb remains with an error and Quit can retry the same authenticated instance.
It never redirects a retry to a different discovered daemon.
Same-instance reconnects retain the authenticated shutdown target, independently
of the WebSocket. Quit always attempts the authenticated shutdown request. It
completes only with a matching receipt, or after a refused connection plus an OS
probe proves the original daemon PID no longer exists; a PID probe alone, HTTP
errors, resets and timeouts do not prove shutdown. Failed Quit keeps media stopped.
On cleanup failure the daemon retains only its authenticated shutdown control
endpoint and discovery, rejecting new work. A retry closes only the resources
that previously failed; successful cleanup steps are not repeated. Cleanup logs
identify the failed resource and bounded, credential-redacted causes. Signal-driven
process exit instead releases only its own discovery record even if cleanup fails;
it never removes a replacement daemon's record.

On other platforms: the Live Host app is macOS-only (it needs native
microphone, global shortcut, and screen capture). Linux/Windows users cannot
use voice features until a Host is available on their platform.

## Subagents

Hover or keyboard-focus the orb to reveal a side summary explicitly labelled
**Subagents** / **子智能体**. Click it for a compact list, then select a task for
details within that same frameless panel, with **Back** to the list. The view covers
Proactive monitors/reminders and tasks delegated by Live to a coding harness.
It shows the original request, actual status, latest activity, public
intermediate text, available plan/tool updates and final result. It does not
invent a completion percentage or expose thought chunks/raw tool payloads.

The compact summary shows dot/running and check/completed counts. The running
dot gently pulses only while connected with active tasks, and stays static with
system reduced motion. A waiting marker appears only when input is needed;
tooltips and accessible labels retain exact counts, including when large counts
are displayed as `999+`.

`Running` counts active tasks, including queued and waiting tasks. `Completed`
counts successful outcomes plus cancelled Proactive monitors, whose details
still say Cancelled. Cancelled timers/harness jobs, failed and interrupted
tasks remain distinct. `Needs you` only counts tasks waiting for user input or
approval, not failures or interrupted tasks. Monitor evaluations and repeat notifications do not
create extra tasks, and an instruction joined to a running job does not count
twice. Monitor notification delivery is shown separately from task completion.

Ending the voice call stops Proactive sampling and retains its terminal
records. Harness tasks keep running and updating this view without reopening
audio or the realtime model. Permission requests received while no voice call
is active remain pending and can be answered from the task details. The panel
shows only real backend requests and the scope of each offered Allow / Deny
choice; it never bypasses a sandbox or invents an approval for an ordinary
filesystem error. Requests without a confirmed task identity appear separately.
Their pending count also activates the summary's attention marker. Overlong
requests require review in the backend before approval; Live still offers Deny
when the backend supports it.
For supported Codex ACP sessions, Live selects the advertised **Ask for approval**
mode before sending work. Unsupported or failed mode selection is logged rather
than silently claiming manual approval is available. Existing backend sessions
and global permission settings are not changed.

Use **Stop** on a task row or in its details to stop that exact Harness task or
monitor. A pending cancellation says **Stopping…** until confirmed; an unknown
task identity or unsupported backend cannot fall back to stopping a different
task in the same session. Stop requests and confirmed outcomes are sent to Omni
as silent text context, queued while it is busy and retained across End call for
the next call in the same daemon run. **Close** only dismisses the panel.

Live imposes no active Harness/monitor count limit. Independent Harness work
uses separate sessions; adding instructions to an existing session retains its
steering/queue semantics. Backend quotas, per-session queue bounds and available
machine/API resources still apply.

The orb is never resized or moved to fit task windows. The side summary has a
roughly one-second hover grace period. Expanded lists and details stay open until
Close or Escape, including through blur, Settings, orb dragging and disconnection.
Only the collapsed summary hides during dragging; a subsequent hover reanchors
it inside the new display work area. Drag either expanded header to move the
panel; Back preserves its location, clamping the new size to the display.
Task updates do not move windows or task rows, and output follows the tail only
when you were already at the bottom. Closing the panel does not stop its task.

The final Host Settings option, **Theme**, follows **Language** and offers
System (default), Light mode and Dark mode. This Host-local preference applies
to all its surfaces without restarting media or changing daemon settings.

History belongs to the current daemon run, not a cross-restart task archive.
All active tasks retain bounded details, alongside the latest 32 ended tasks.
Previous / Next pages contain at most 32 tasks and 240 KiB per snapshot; selected
details are fetched separately. Omitted records/truncated output are labelled,
and totals still include omitted tasks. Original backend text may contain
sensitive work content, so the view is
local and only the authenticated Host receives it. New task updates are
capability-negotiated; older Hosts/daemons keep their existing behavior.

## Configuration

Configuration comes from `~/.qwen-live/config.json` (generated by `init`),
with environment variables (`DASHSCOPE_API_KEY`, `QWEN_LIVE_*`) as overrides.
Runtime saves (language, display and memory preferences) rewrite `config.json`
atomically through an exclusive temporary file plus rename and mark it
owner-only (`0600`) on macOS/Linux; Windows has no POSIX permission bits, so
there the file's isolation depends on the data directory's own ACLs.

```jsonc
{
  "language": "en",
  "realtimeApiKey": "sk-...",
  "realtimeModel": "qwen3.5-omni-plus-realtime",
  "memory": {
    "enabled": true,
    "dir": "",
    "defaultId": "default",
    "updater": { "model": "qwen3.7-plus" },
    "observer": { "enabled": false },
  },
  "visualInput": {
    "source": "screen",
    "screenDisplayId": "primary",
    "mode": "on-demand",
    "fps": 1,
    "cameraResolution": { "width": 1280, "height": 720 },
    "cameraSnapshotResolution": "native",
    "liveResolution": { "width": 1280, "height": 720 },
    "snapshotResolution": "native",
  },
  "proactive": {
    "enabled": true,
    "monitor": {
      "sessionRecycleEvals": 60,
    },
    "scheduler": {
      "evalIntervalSec": 2,
      "maxFailuresPerTask": 3,
      "repeat": {
        "cooldownSec": 3,
        "maxWaitTtsSec": 30,
        "clearBufferOnResume": true,
      },
    },
    "vision": {
      "fps": 1,
      "windowSizeSec": 10,
      "minEvalDurationSec": 0,
    },
    "audio": {
      "windowSizeSec": 60,
      "minEvalDurationSec": 0,
    },
  },
  "defaultCwd": "~/work/my-project",
  "backends": [
    {
      "name": "qodercli",
      "kind": "acp",
      "command": "/usr/local/bin/qodercli",
      "args": ["--acp"],
      "default": true,
    },
    {
      "name": "qwen",
      "kind": "acp",
      "command": "/usr/bin/qwen",
      "args": ["--acp"],
    },
  ],
}
```

See `src/config.ts` for the full list of options and validation rules.
Visual input has two independent settings. `source` is `screen` or `camera`;
`mode` is `on-demand` or `live-feed`. The defaults are Screen + On Demand,
1 FPS, a 1280×720 camera stream, 1280×720 Live Feed frames, and
native-resolution On Demand Screen and Camera assets. `cameraResolution`
controls the camera preview/Live Feed stream; `cameraSnapshotResolution`
independently controls Camera Appshot assets (`native` or a width/height pair).
`snapshotResolution` controls Screen snapshots. For example,
`"cameraSnapshotResolution": { "width": 1920, "height": 1080 }` requests an
asset fitted within that size without changing the 720p preview.
`qwen-live init` writes these defaults without asking extra questions, so they
can be edited directly afterward.

Proactive is enabled by default. It adds condition monitors, live narration,
and device-time reminders. Each perception task uses an independent,
text-only DashScope Realtime connection while reusing the foreground
Realtime endpoint, API key, and model. Monitor sessions send no voice setting
and output text only. Enabling Proactive exposes the tools; observation starts
only after a perception task is created. Triggered announcements wait for
foreground speech and Host playback to finish, then play one at a time in
FIFO order. Repeated monitors and narration continue observing while earlier
events wait or play, so multiple events from the same task can queue. Event
monitors retain their cooldown and false-edge rule for distinct occurrences;
narration retains novelty-sensitive updates. Each playback acknowledgement
retires only its own event. Cancelling or updating a task removes all of its
old queued events. The delivery ACK
timeout starts when foreground Realtime accepts the announcement and emits
`response.created`; this prevents a missing Host playback receipt from
blocking the FIFO forever. There is no Live-level monitor admission cap;
legacy `maxConcurrentTasks` settings are accepted but no longer enforced or
written by init. Vision and audio retain their own
`windowSizeSec` and `minEvalDurationSec`, including in a combined monitor and
after a Monitor connection is recycled. Task-list replies include remaining
timer duration, reminder content, monitor condition/focus, repeat state, and
the number of pending notifications. A user request may chain Proactive
tools, such as listing tasks and then cancelling one, without a new utterance.

Positive visual warm-up can use elapsed observation time for successful captures
slower than the requested FPS. A capture gap longer than three nominal frame
intervals (with a one-second tolerance floor) starts a fresh observation period;
old frames cannot warm a new isolated frame. The default zero warm-up still
accepts a single fresh frame.

The environment overrides are `QWEN_LIVE_VISUAL_SOURCE`,
`QWEN_LIVE_VISUAL_MODE`, `QWEN_LIVE_VISUAL_FPS`,
`QWEN_LIVE_CAMERA_RESOLUTION` (for example `1280x720`),
`QWEN_LIVE_CAMERA_SNAPSHOT_RESOLUTION` (`native` or `WIDTHxHEIGHT`),
`QWEN_LIVE_VISUAL_LIVE_RESOLUTION` (for example `1280x720`), and
`QWEN_LIVE_VISUAL_SNAPSHOT_RESOLUTION` (`native` or `WIDTHxHEIGHT`). FPS must
be between 0.1 and 10. Source and Mode can also be changed for the current call
from the Host orb; an orb change does not rewrite the configuration file.
Set `QWEN_LIVE_PROACTIVE_ENABLED=false` (or `0`) to disable Proactive entirely;
`true` and `1` enable it. The remaining Proactive parameters are configured in
`config.json`.

Unrecognized keys inside `visualInput`, `proactive` and `memory` are rejected;
a misspelled camera setting does not silently select the default Screen source.

For runtime diagnostics, start the daemon with:

```bash
qwen-live --debug
```

Debug output goes to foreground stderr and reports Host connection state, call
lifecycle, visual capture/frame acceptance, Proactive evidence gates/evaluations,
notification queue and playback transitions, and harness lifecycle events even
after a call ends. `realtime.protocol` records selected provider event types,
IDs, cancellation metadata and committed-input counts for timing diagnosis.
It does not print API keys, image payloads, raw audio, prompts or transcript contents.
Run the Electron Host separately with `--live-debug`, not `--debug` (Electron
reserves that flag). The Host switch does not enable daemon diagnostics.

For Monitor delivery, match the `frameHash` (first 16 SHA256 hex characters of
JPEG bytes) across Host capture, daemon capture/frame receipt, and
`proactive.monitor_image_sent`. Only successful socket writes increment the
per-commit image/audio counters in `proactive.monitor_commit`; audio totals
include protocol silence. `proactive.monitor_committed` confirms the provider
acknowledgement, and `proactive.monitor_action` classifies `wait`, `reply`,
`function_call` or `invalid` without printing the response text. Native display
and orb-position events are recorded by the Host switch, so capture loss can
be distinguished from geometry changes.

**Visual Monitor recordings:** daemon debug mode (also enabled by
`QWEN_LIVE_LOG_LEVEL=debug`) additionally saves actual Monitor requests under
`<OS temporary directory>/qwen-live-monitor-debug/`. Normal runs and audio-only
Monitors do not record media. Each visual Monitor gets a directory, including
combined audio/visual Monitors; WebSocket recycling stays in the same directory.
`proactive.monitor_debug_started` prints its absolute path. Each inference logs
`proactive.monitor_request_saved` with both Monitor and request directories:

```text
monitor-<creation-time>-<id>/
  monitor.json
  requests/000001/
    request.json
    image-0001.jpg
    input.wav
    response.json
```

JPEGs are the exact frames successfully sent to the model. The mono 16 kHz
PCM16 WAV contains the sent audio, including protocol silence. JSON retains
instructions, event order, audio offsets, frame hashes and the reference to the
preceding request in that transport; the response file records returned text,
parsed action or failure. Check preceding requests for the resident conversation
history. Queued/dropped frames are not presented as sent frames.

These are **sensitive recordings of real screen/camera content, task prompts and,
for audio/visual Monitors, microphone audio**. Connection credentials are omitted;
visible or spoken secrets inside media are not redacted. Directories/files are
**owner-only on macOS and Linux** (enforced 0700/0600 and rejected otherwise);
on Windows the store cannot check POSIX modes, so isolation is only whatever
ACLs the OS temporary directory inherits. Debug startup and new Monitor
creation keep only the ten most recently created Monitor directories; this is
not a ten-request or disk-size limit. Deletion is best-effort: an archive the
OS cannot delete (for example a file held open by another process on Windows)
is kept past this cap and reported as `proactive.monitor_debug_prune_failed`
until it can be removed. An evicted Monitor keeps running but
stops recording and logs skipped requests. Disk/permission failures or
exceeding the 32 MiB pending-write budget disable that recorder and log an
incomplete recording without stopping the call.
Long-running debug Monitors can consume significant disk space; disable debug
after diagnosis and do not share recordings without reviewing their contents.

For `qwen3.5-omni-plus-realtime` and `qwen3.5-omni-flash-realtime`, the initial
session explicitly requests mono PCM input at 16 kHz and output at 24 kHz via
`audio.input.format` / `audio.output.format`, as documented in the
[DashScope session API](https://help.aliyun.com/zh/model-studio/client-events#26a8302028sjm).
Older/custom models retain the legacy PCM fields and 24 kHz playback contract.
Host playback uses a default-device-rate AudioContext, not a forced 24 kHz
hardware clock. With current output-end-marker negotiation, each response is
continuously band-limited/resampled into device-rate buffers and scheduled at
integer sample boundaries, avoiding independent chunk-conversion spikes and
unnecessary gaps. The end marker flushes the short filter tail. Older peers
without end markers retain the legacy Web Audio conversion
and drain behavior. Bluetooth headset microphone activation can
still switch the device into hands-free mode; use a separate/built-in microphone
while keeping headphones as system output when listening to music or video.
Input mute releases capture devices without ending the call; Host's status bar
shows microphone/output mute states beneath the main call status.

### Supported backends

| Backend     | Kind        | ACP entry                                   | Notes                               |
| ----------- | ----------- | ------------------------------------------- | ----------------------------------- |
| Qoder CLI   | `acp`       | `qodercli --acp`                            | Hidden flag; uses Qoder's own login |
| Qwen Code   | `acp`       | `qwen --acp`                                | Native ACP mode                     |
| Gemini CLI  | `acp`       | `gemini --experimental-acp`                 | Official ACP support                |
| Claude Code | `acp`       | `npx @agentclientprotocol/claude-agent-acp` | Adapter-based                       |
| Codex       | `acp`       | `npx @agentclientprotocol/codex-acp`        | Adapter-based                       |
| qwen serve  | `qwen-code` | REST/SSE to `qwen serve` daemon             | Legacy; no ACP needed               |

Multiple backends can coexist — the voice model sees all sessions across
all backends in `session_list` and can route `handoff` to a specific one by
name.

## Memory

If the default Memory HTTP endpoint cannot be derived from `realtimeEndpoint`,
Live logs a warning and keeps daemon setup and local memory available. Model-backed
Memory features without their own valid endpoint stay unavailable; explicit
Memory endpoint settings remain independent. Correct the realtime endpoint and
restart to restore the shared default.

Memory records final dialogue text, lets the foreground model edit working memory with `omnibio`, consolidates selected facts after the call, and retrieves earlier dialogue or visual observations with `omniretrieve`.

### Setup and controls

`qwen-live init` asks whether to enable Memory (yes by default), then asks for the consolidation model (`qwen3.7-plus` by default). Remaining defaults are written without more questions. Existing configurations receive defaults at load time, so reinitialization is optional.

Open **Settings → Memory** on the orb to enable/disable Memory, enable optional **Visual memory**, choose a library, use **New** or **Rename**, and edit the **Consolidation model**. End the call before selecting/creating a library or changing its model. Renaming and switches remain available during calls. New creates and selects a library; OFF preserves the selection and stored data. Accepted changes are merged into the Live config file.

### Storage and lifecycle

By default each library lives in `~/.qwen-live/memories/<id>/` with private `meta.json` and `dialogue.db` files. Its stable id is independent of its display name. `memory.dir` can override the root; relative paths resolve under the Live data directory (`QWEN_LIVE_DATA_DIR`, normally `~/.qwen-live`). Node.js 22.13 or newer is required for SQLite/FTS5. Node versions that label SQLite experimental may print their built-in warning.

Final user transcripts and ordinary assistant replies become searchable segments, including interrupted replies. Synthetic Proactive notices, backend speech, repair turns and tool wrappers are excluded from user dialogue. Memory does not persist raw microphone audio or image frames.

The model selects reusable facts through `omnibio`. Edits to this ordered working-memory list are persisted immediately. At detachment/call end, the consolidation model classifies the final list into a long-term profile and time-sensitive recent items. It does not mine the entire raw transcript. Profile and recent items are frozen per attachment; working memory and retrieved context can change during the call.

Consolidation is serialized per library and deduplicated by session and working-memory version. Shutdown waits `shutdownWaitSec`, then abandons remaining requests. WM snapshots remain on disk, but abandoned jobs are not automatically replayed on restart. Runtime diagnostics report the outcome.

### Retrieval and visual memory

Dialogue retrieval combines Jieba search tokens, SQLite BM25 and optional embedding similarity. A failed or slow embedding request falls back to keyword search. Time ranges reweight candidates rather than excluding every older match; the unsegmented conversation tail can also be searched.

Visual memory defaults off and follows the selected Screen/Camera source. It observes the first available frame, then at the configured interval. Live Feed reuses current frames; On Demand privately captures a bounded frame without requiring a Proactive task or invoking the foreground Appshot tool. Only a cleaned description is persisted. Disabling visual capture preserves access to historical visual observations. Source/attachment changes invalidate late results.

Retrieved content is published through four memory data sections in the model instructions. Tool receipts report only source/counts. The follow-up response receives the newest instructions while persistent session configuration updates wait until the model is idle. Memory text grants no tool authority. Oversized edits are rejected before changing the model's numbered working-memory list.

### DashScope connection

Embeddings use the existing key and regional endpoint's `/compatible-mode/v1/embeddings`. Consolidation and visual observation use `/compatible-mode/v1/chat/completions`, ordinary text/image requests with no Realtime voice setting. The default consolidation model is `qwen3.7-plus`; `observer.model` inherits it unless explicitly set. Embeddings default to `text-embedding-v4`.

`updater.baseUrl` and `observer.baseUrl` optionally select another compatible endpoint; their `apiKeyEnv` names an environment variable, not a secret stored in config. Empty overrides reuse the existing DashScope connection. No private gateway is hardcoded.

Official references checked 2026-09-05:

- [Chat Completions](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)
- [Embeddings](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api)
- [Models](https://help.aliyun.com/zh/model-studio/models)

### Configuration defaults

Place this object under `memory` in `~/.qwen-live/config.json`. The optional Observer model is omitted so it follows the consolidation model.

```json
{
  "enabled": true,
  "dir": "",
  "defaultId": "default",
  "retrieve": {
    "topK": 3,
    "maxChars": 5000,
    "retrievedMaxChars": 6000,
    "useVector": true,
    "model": "text-embedding-v4",
    "timeoutMs": 400,
    "backfillTimeoutMs": 10000,
    "cacheSize": 1000,
    "minSim": 0.4,
    "vecLimit": 50,
    "ftsLimit": 50,
    "ftsAndTryThreshold": 20,
    "andBoost": 1.2,
    "timeRangeBoost": 2,
    "timeEdgeDays": 2,
    "rrfK": 60,
    "envMinGapSec": 600
  },
  "preload": {
    "ltmMaxPerField": 6,
    "ltmMaxChars": 800,
    "stmUpcomingGraceDays": 2,
    "stmMaxAgeDays": 90,
    "recencyLambda": 0.05,
    "upcomingWeight": 1.5,
    "ongoingWeight": 1,
    "urgentBoost": 1.5,
    "urgentDays": 3,
    "stmMaxItems": 20,
    "stmMaxChars": 1200
  },
  "updater": {
    "enabled": true,
    "model": "qwen3.7-plus",
    "baseUrl": "",
    "apiKeyEnv": "",
    "timeoutMs": 120000,
    "temperature": 0,
    "maxTokens": 2048,
    "maxWmEntries": 64,
    "shutdownWaitSec": 2
  },
  "observer": {
    "enabled": false,
    "baseUrl": "",
    "apiKeyEnv": "",
    "intervalSec": 60,
    "timeoutMs": 60000,
    "temperature": 0,
    "maxTokens": 400,
    "maxContentChars": 400,
    "maxFrameAgeSec": 15
  },
  "wm": {
    "maxEntries": 128,
    "maxEntryChars": 200
  },
  "segment": {
    "maxTurns": 4,
    "minTurnsBeforeGapCut": 2,
    "maxChars": 1000,
    "silenceGapSec": 60
  }
}
```

`retrieve.maxChars` bounds unrendered bodies and must not exceed `retrievedMaxChars`, the rendered section budget. Background embedding timeout must be at least the live-query timeout. Visual retrieval spreads observations by `envMinGapSec`; it returns fewer results rather than padding them with near-duplicate frames.

Run `qwen-live --debug` for state, counts, timing and failure diagnostics. These omit memory content and credentials. Detailed preload and consolidation audit records stay in the private library database.

## Host Bootstrap

The Live Host installer is built in. On macOS, `qwen-live init` checks if
the Host is installed and offers to download and install it (sha256 +
codesign + team identifier verification). The daemon also exposes HTTP
endpoints behind its Bearer token:

```bash
TOKEN=$(jq -r .token ~/.qwen/live/daemon.json)
PORT=$(jq -r .url ~/.qwen/live/daemon.json | sed 's/.*://')
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/live/setup"
```

## Protocol v9: Visual Input and Playback Identity

The daemon speaks Live Host protocol v9. Output audio carries an epoch and
`outputId`; the Host echoes both in `host.playback_started` and
`host.playback_completed`. This prevents receipts from cleared audio from
settling a newer playback stream in the same call. A Host that advertises
`outputAudioEndMarkerV1` receives an explicit end marker for each output id and
reports completion only after that marker and every scheduled frame have
drained. Consecutive response outputs may drain independently, but Qwen Live
reopens the Proactive FIFO only after all of them complete. Hosts without this
capability keep the legacy playback-drain behavior.

Standalone v9 daemons advertise an optional `visualInput` object during the
welcome handshake. `host.visual_settings` changes Source/Mode for the current
call, `host.visual_frame` carries bounded Live Feed JPEGs, and
`host.capture_visual` / `host.visual_capture_result` implement correlated On
Demand capture. The built-in `qwen serve` integration uses the same pair with
source `screen` while omitting the standalone Source/Mode controls.

In Live Feed mode the selected source continuously supplies recent frames to
the foreground Omni session. In On Demand mode the foreground model calls
`appshot` for one selected-source capture. An active visual Proactive task
also requests periodic private captures for its Monitor in On Demand mode;
the Source/Mode selection does not pause those monitors. The daemon
returns its metadata and asset handle through the original
`function_call_output` continuation; it does not append that snapshot to
Realtime, commit an audio buffer, or change VAD mode. Pixel-level inspection
uses the existing handoff path with the returned asset.

Screen Live Feed and visual Proactive monitors capture the **entire selected
display**, including the desktop, menu bar and Dock, excluding Live Host's own
windows. Choose **Display** under Video Source in Settings. The selection is
saved as `visualInput.screenDisplayId` in `config.json`: `primary` (default)
follows the system's primary display, or a display UUID selects that device.
An explicitly selected display that is disconnected fails without switching to
another display. Display changes discard stale captures and reset monitor visual
buffers. Both continuous and monitor frames use `liveResolution` (720p by
default), remain aspect-fitted and subject to the existing transport limits;
full-display coverage does not mean native pixel resolution. No new init prompt
is needed. Older Hosts must be updated to support full-display capture.

Foreground Screen Appshot and On Demand visual-memory observations keep the
original front-window capture. Appshot still requires Accessibility and Screen
Recording; the full-display operation needs only Screen Recording. Screen Live
Feed therefore does not require Accessibility. Camera behavior is unchanged.

Screen captures may also include Appshot accessibility metadata and a PNG
handoff asset. Camera source opens a preview/Live Feed stream at
`cameraResolution` (1280×720 by default). User Appshot requests take a separate
still image from that camera track using `cameraSnapshotResolution`; native
uses the available still-image resolution, with a video-constraint fallback
on devices without still-photo support. The preview settings are restored
after fallback capture. Unsupported native capture fails explicitly.
The camera JPEG asset keeps its independent snapshot resolution and is
limited to 8 MiB. Its transport preview, Live Feed frames, and private Monitor
frames remain limited to 190 KiB and fitted within 1920×1080. Private Monitor
captures do not take full-resolution still photos. Stop ends the call and its
monitors; the visible Camera source may keep a local preview open while idle.
The system prompt always follows the latest explicit Source and
Mode and never guesses or combines the unselected source. If the newly selected
source needs permission during an active call, the working source remains in
place until authorization succeeds, then the switch is applied atomically.

## Status

Incubating inside the qwen-code monorepo, tracking M1–M5 of the Live split
roadmap (issue #10118):

- **M1+M2** (merged): daemon, host stack, base tools, injector, permissions,
  steering, JSONL logs, Host installer
- **M4** (merged): AcpAdaptor, multi-backend routing, capability gating
- **M5** (merged in #10769): protocol v7 playback receipts and the interactive
  `qwen-live init` wizard
- **This extension**: protocol v9 visual input and fenced playback receipts,
  6 configurable Proactive tools, 2 Memory tools with local multi-library
  storage (both features enabled by default), and configurable desktop controls
- **M3** (blocked): session registry + cross-session messaging — depends on
  upstream #9576
- Built-in Live module retirement: deferred until the standalone daemon is
  stable in production

## Attribution

The Proactive and Memory implementations include TypeScript adaptations of
`qwen-omni-realtime-agent` v0.1.0 (`qwen_omni_realtime_agent/proactive` and
`qwen_omni_realtime_agent/memory`), Copyright 2026 Alibaba Group Holding Limited,
licensed under Apache-2.0. This port modifies those components for Qwen Live's
DashScope connection, tool authority, playback queue, local storage and Host
interface. Original copyright notices are retained in adapted source files.
