# Voice Input

Qwen Code can transcribe your speech into prompt text. In the Web Shell, a
microphone button in the composer records your voice, transcribes it with an
ASR model, and inserts the transcript into the composer for you to review
before sending. The interactive terminal offers the same dictation with the
`Space` key (see [Keyboard shortcuts](../reference/keyboard-shortcuts.md)).

Voice input is dictation, not a conversation: it produces text for the current
prompt. For a realtime spoken conversation with the agent, see
[Qwen Live](./qwen-live.md).

## Requirements

- A daemon with the Web Shell enabled (`qwen serve` without `--no-web`).
- A transcription model selected in [`voiceModel`](../configuration/settings.md#voicemodel).
  Supported ASR model ids are `qwen3-asr-flash` (with optional dated snapshots),
  `qwen3-asr-flash-realtime`, `fun-asr-realtime`, and `paraformer-realtime`,
  served through an OpenAI-compatible endpoint such as DashScope.
- Voice dictation enabled with `general.voice.enabled: true`.
- A [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts):
  open the Web Shell via `localhost` / `127.0.0.1` or over HTTPS. Browsers block
  microphone access on plain HTTP over a LAN IP — see
  [HTTPS / TLS](../qwen-serve.md#https--tls-for-mobile--cross-device-access).
- Microphone permission for the site in your browser (and for the browser in
  your operating system's privacy settings).

## Setup

### 1. Add a voice model

Any of these paths selects the transcription model:

- **Settings → Models → + Add Model**, with **Model purpose** set to
  **Voice transcription**. Enter the provider's OpenAI-compatible base URL and
  API key, then the ASR model id. Adding a voice model keeps your current
  conversation model.
- Type `/model --voice` in the composer to open the voice model picker, or
  `/model --voice <model-id>` to set one directly.
- The **Voice Model** row in Settings opens the same picker.
- Set `voiceModel` in `settings.json` (see the
  [settings reference](../configuration/settings.md#voicemodel)).

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

## Tuning transcription

All settings live under `general.voice` (see the
[settings reference](../configuration/settings.md) for defaults):

| Setting                          | Effect                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `general.voice.mode`             | `"hold"` (press and hold) or `"tap"` (click to toggle).                                                |
| `general.voice.language`         | Preferred spoken language, e.g. `"english"` or `"chinese"`. Empty auto-detects.                        |
| `general.voice.keytermsFile`     | Path to a keyterms file (one term per line, `#` comments) that biases recognition toward domain terms. |
| `general.voice.refineTranscript` | Clean up the transcript with the fast model before inserting it (default on).                          |

Keyterms default to `.qwen/voice-keyterms.txt` when that file exists. The file
is read only in trusted workspaces and applies only to Qwen ASR models
(`qwen3-asr-*`).

Transcript refinement removes filler words and fixes recognition errors while
preserving meaning. It falls back to the raw transcript on failure and is
skipped when no fast model is configured.

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
- **Remote deployments** — the voice WebSocket needs an explicit
  `--allow-origin` entry in some proxy setups; see
  [Daemon mode](../qwen-serve.md).

## Related

- [Qwen Live](./qwen-live.md) — realtime voice conversations.
- [Model Providers](../configuration/model-providers.md) — provider routes and
  credentials.
- [Settings reference](../configuration/settings.md) — `voiceModel` and
  `general.voice.*`.
