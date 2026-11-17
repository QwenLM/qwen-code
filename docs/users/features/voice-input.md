# Voice Input

Qwen Code can transcribe your speech into prompt text. In the Web Shell, a
microphone button in the composer records your voice, transcribes it with an
ASR model, and inserts the transcript into the composer for you to review
before sending. The interactive terminal also offers dictation with the `Space`
key (see [Keyboard shortcuts](../reference/keyboard-shortcuts.md)), with one
difference: terminal tap mode submits the prompt when recording stops (see
[Dictate a prompt](#dictate-a-prompt)).

Voice input is dictation, not a conversation: it produces text for the current
prompt. For a realtime spoken conversation with the agent, see
[Qwen Live](./qwen-live.md).

## Requirements

- A daemon with the Web Shell enabled (`qwen serve` without `--no-web`).
- A transcription model selected in [`voiceModel`](../configuration/settings.md#voicemodel).
  Supported ASR model ids, by transport:
  - `qwen3-asr-flash` (with optional dated snapshots) — batch transcription
    over an OpenAI-compatible Chat Completions endpoint such as DashScope.
  - `qwen3-asr-flash-realtime`, the `fun-asr-*realtime` family, and the
    `paraformer-realtime-*` family (for example `fun-asr-realtime`,
    `paraformer-realtime-v2`) — streaming transcription over a DashScope-style
    WebSocket derived from the route's `baseUrl` (`/api-ws/v1/realtime` or
    `/api-ws/v1/inference`). The endpoint must serve these WebSocket paths; a
    generic OpenAI-compatible HTTP gateway cannot serve them. Audio is captured
    at 16 kHz, so 8 kHz-only models (such as `fun-asr-flash-8k-realtime`) do not
    match the capture rate.
- Voice dictation enabled with `general.voice.enabled: true`.
- A [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts):
  open the Web Shell via `localhost` / `127.0.0.1` or over HTTPS. Browsers block
  microphone access on plain HTTP over a LAN IP — see
  [HTTPS / TLS](../qwen-serve.md#https--tls-for-mobile--cross-device-access).
- Microphone permission for the site in your browser (and for the browser in
  your operating system's privacy settings).

The daemon, secure-context, and browser-permission requirements above apply
to the Web Shell. The interactive terminal runs dictation locally without a
daemon, but still needs a selected voice model and `general.voice.enabled`.

## Setup

### 1. Add and select a voice model

If you do not have a voice-capable route yet, add one via **Settings → Models
→ + Add Model → Custom Provider**, with **Model purpose** set to **Voice
transcription** (the Model purpose field exists only for the Custom Provider
preset): enter the provider's OpenAI-compatible base URL and API key, then the
ASR model id. This registers a voice-only route and keeps your current
conversation model; it does **not** select the transcription model yet. The
API key entered here is stored in clear text in the settings `env` block.

Then select the transcription model by any of these paths:

- Type `/model --voice` in the composer to open the voice model picker, or
  `/model --voice <model-id>` to set one directly.
- The **Voice Model** row in Settings opens the same picker.
- Set `voiceModel` in `settings.json` (see the
  [settings reference](../configuration/settings.md#voicemodel)).

For DashScope, the voice route's `baseUrl` is the OpenAI-compatible root
`https://dashscope.aliyuncs.com/compatible-mode/v1`: the batch model calls
Chat Completions there, and the streaming models derive their WebSocket from
the same host. The image generation API root (`.../api/v1`, taught by the
[Image Generation](./image-generation.md) guide) is **not** a voice base URL
and breaks both transports.

The route's `baseUrl` must be HTTPS. Loopback endpoints (`http://localhost`,
`http://127.0.0.1`, `http://[::1]`) are allowed, and a trusted managed HTTP or
private-network endpoint can be exempted by listing its exact complete URL in
`security.allowedInsecureVoiceBaseUrls` (honored only from user, system, or
system-defaults scope; see the
[settings reference](../configuration/settings.md)). Metadata, link-local,
and transition-range addresses, and hostnames that resolve to loopback, stay
blocked even when listed.

### 2. Enable dictation

Set `general.voice.enabled` to `true` in your user or workspace
`settings.json`:

```json
{
  "general": {
    "voice": {
      "enabled": true,
      "mode": "hold"
    }
  }
}
```

The terminal's [`/voice`](./commands.md) command manages the same settings
(`/voice hold`, `/voice tap`, `/voice off`, `/voice status`).

Once enabled, the microphone button appears in the composer toolbar. In a
multi-workspace daemon, each trusted workspace resolves its own voice model and
settings; untrusted secondary workspaces do not offer voice input.

## Dictate a prompt

- **Hold mode** (default): press and hold the microphone button, speak, then
  release to stop.
- **Tap mode** (`general.voice.mode: "tap"`): click once to start recording,
  click again to stop.

While recording, the button shows a live waveform and elapsed time; with a
streaming ASR model, interim transcript text also appears next to it. When you
stop, the final transcript is inserted into the composer — edit it if needed,
then send as usual. If nothing was recognized, a "No speech detected" notice
offers a retry; transport and permission errors are shown inline with a retry
action.

In the interactive terminal, hold mode likewise inserts the transcript without
sending. Tap mode behaves differently: it stops and **submits** the prompt —
on the second `Space` press, or automatically after sustained silence when the
audio backend supports silence detection (the native recorder and SoX do; the
`arecord` fallback does not, so there tap mode records until you press `Space`
again) — so tool execution and permission prompts can start right away.

## Tuning transcription

All settings live under `general.voice` (see the
[settings reference](../configuration/settings.md) for defaults):

| Setting                          | Effect                                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `general.voice.mode`             | `"hold"` (hold to talk) or `"tap"` (tap to start, tap again to stop).                                                                                                         |
| `general.voice.language`         | Preferred spoken language, e.g. `"english"` or `"chinese"`. Empty auto-detects.                                                                                               |
| `general.voice.keytermsFile`     | Path to a keyterms file (one term per line, `#` comments) that adds domain terms to the recognition bias list. User/system scope only; contents are sent to the ASR provider. |
| `general.voice.refineTranscript` | Clean up the transcript with the fast model before inserting it (default on). Interactive terminal only; the Web Shell inserts the ASR transcript unchanged.                  |

On every `qwen3-asr-*` dictation, a built-in developer vocabulary (terms such
as `Qwen`, `MCP`, `grep`, `TypeScript`) is sent to the ASR provider to bias
recognition; your keyterms file adds terms on top. The file defaults to
`.qwen/voice-keyterms.txt` when present, is read only in trusted workspaces,
and applies only to Qwen ASR models. The `keytermsFile` setting is honored
only from user/system settings (a workspace value is ignored), and the file's
contents are sent to the provider along with the built-in list.

In the interactive terminal, transcript refinement removes filler words and
fixes recognition errors while preserving meaning. It falls back to the raw
transcript on failure and is skipped when no fast model is configured. The Web
Shell does not refine transcripts.

## Troubleshooting

- **No microphone button** — `general.voice.enabled` is off, or the daemon does
  not advertise the voice feature (for example when the ACP HTTP surface is
  disabled with `QWEN_SERVE_ACP_HTTP=0`).
- **"Microphone needs a secure context"** — open the Web Shell via
  `localhost`/`127.0.0.1` or configure [TLS](../qwen-serve.md#https--tls-for-mobile--cross-device-access).
- **"Microphone blocked"** — allow the microphone for the site (address-bar
  camera/lock icon) and for the browser in your OS privacy settings.
- **"No voice model is configured for this workspace"** — select a model with
  `/model --voice` or the Settings picker.
- **"must use an https baseUrl" / "must not use a private-network baseUrl"** —
  the voice route's endpoint is cleartext HTTP or on a private network. Use
  HTTPS or a loopback address, or add the endpoint's exact complete URL to
  `security.allowedInsecureVoiceBaseUrls` (user, system, or system-defaults
  scope only). Metadata, link-local, and transition-range addresses, and
  hostnames that resolve to loopback, stay blocked even when listed.
- **"Streaming voice transcription requires native audio capture"
  (terminal)** — the streaming ASR models need the native recorder.
  Install/rebuild `@qwen-code/audio-capture`, or switch `voiceModel` to
  `qwen3-asr-flash` for batch transcription.
- **Remote deployments** — the voice WebSocket needs an explicit
  `--allow-origin` entry in some proxy setups; see
  [Daemon mode](../qwen-serve.md).

## Related

- [Qwen Live](./qwen-live.md) — realtime voice conversations.
- [Model Providers](../configuration/model-providers.md) — provider routes and
  credentials.
- [Settings reference](../configuration/settings.md) — `voiceModel` and
  `general.voice.*`.
