# Qwen Live (Realtime Voice)

Qwen Live is an experimental realtime voice conversation in the Web Shell. You
speak, and a Realtime (speech-to-speech) model such as
`qwen3.5-omni-plus-realtime` answers out loud — no push-to-talk, no typing.
When a request needs tools or deeper work, the Realtime model hands the task
off to the Qwen Code agent, and the agent's progress streams back into the
still-active call. You can keep speaking to steer or interrupt the work.

Qwen Live is not dictation: the Realtime model owns the conversation and
decides when backend execution is useful. For speech-to-text prompt input, see
[Voice Input](./voice-input.md).

## Requirements

- A daemon with the Web Shell enabled (`qwen serve` without `--no-web`) and
  the ACP HTTP surface enabled (on by default; `QWEN_SERVE_ACP_HTTP=0` or the
  `hosted-harness` profile disables it).
- Open the Web Shell over `https` or `localhost` — the browser tab is the
  microphone and speaker, and browsers only grant microphone access in a
  [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).
  For LAN or remote access, configure
  [TLS](../qwen-serve.md#https--tls-for-mobile--cross-device-access).
- A DashScope Realtime API key, or a configured
  [`realtimeOnly` model route](../configuration/model-providers.md#live-voice-routes)
  whose `envKey` supplies the key.
- A trusted primary workspace.

The browser endpoint works on every platform. The native macOS
[Qwen Live Host](#native-macos-host-optional) app is an optional extra.

## Setup

Open the **Live** section in the Web Shell sidebar. Its settings page shows
the **Qwen Live** card (marked Experimental):

1. Turn on **Enable Qwen Live**.
2. **Realtime endpoint** — the OpenAI-compatible base URL of your key's region
   or dedicated domain, for example
   `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`. Left empty, Live
   uses Beijing (`https://dashscope.aliyuncs.com/compatible-mode/v1`); a key
   from another region is rejected with `401`. When a `realtimeOnly` route is
   selected as the Realtime model, this field follows the route's `baseUrl`
   instead.
3. **DashScope Realtime API key** — paste a key, or skip this field by
   picking a configured `realtimeOnly` route as the **Realtime model** in
   step 4; the route then supplies both the endpoint (derived from its
   `baseUrl`) and the key (read from its `envKey`), and this row shows that
   the key comes from the selected model. A key pasted here is saved in clear
   text in your user settings file. To keep it out of settings, export the
   variable in the daemon's environment and select a `realtimeOnly` route
   whose `envKey` names it as the Realtime model: the route reads the daemon
   environment first, then falls back to the clear-text `env` block of
   `settings.json`, so a key left in that block is still stored in settings.
4. **Realtime model** — pick one of your configured `realtimeOnly` routes, or
   choose **Other model id…** to enter any Realtime model id. The default is
   `qwen3.5-omni-plus-realtime`.
5. **Voice** — the output voice name of the selected model (default `Tina`).
   It is checked with the provider while Live is on.
6. **Save**. Model and voice changes apply to the next call.

Route-based configuration is declared in user- or system-level settings only —
a project's `.qwen/settings.json` cannot add or redirect a Live route. See
[Live Voice routes](../configuration/model-providers.md#live-voice-routes) for
the `modelProviders` shape and the `experimental.liveVoice.*` keys.

## Start a call

Click the Live button in the composer toolbar and choose **Talk in this
browser**, then allow microphone access. The call panel shows:

- the connection state — _Listening_, _Thinking_, _Speaking_;
- a microphone level meter, and mute controls for microphone and speaker;
- a **Captions** toggle for the conversation text.

Headphones give the best result: they keep the reply out of the microphone.

### Share your screen

Use **Share screen** in the call panel to stream a screen or window to the
model, then ask about what it shows. Qwen can also ask to see your screen
during a call ("Qwen asked to see your screen") — share one to let it look.
Keep the page and the call open while screen sharing is active.

### Task handoff

Self-contained questions are answered directly by the Realtime model. When you
ask for something that needs execution — reading files, running commands,
editing code — Live hands the task to the agent as a normal turn in a
persistent Live session, with the usual tool surface and permission prompts.
Answer permission requests in the Web Shell as usual; the voice conversation
stays active while the agent works, and new speech steers or interrupts the
same turn.

### One microphone at a time

Only one endpoint holds a Live call. If another Web Shell tab is already
connected, the panel offers **Take over in this tab**. A native Host always
supersedes a browser tab, and a browser tab can never displace a native Host.

## Native macOS Host (optional)

By default Live runs entirely in the browser. On macOS you can opt into the
native **Qwen Live Host** app, which adds a system-wide global shortcut
(default `Command+E`) and Appshot screen capture:

1. Start the daemon with `QWEN_SERVE_LIVE_NATIVE_HOST=1`.
2. Enable Qwen Live in the Live section; the card downloads, verifies, and installs the
   signed Host app.
3. Grant the macOS permissions it requests: Microphone, Accessibility, and
   Screen Recording. Live stays unavailable until every permission is ready.

Without the environment variable, an already-installed Host app cannot
connect. See [Qwen Live (experimental)](../qwen-serve.md#qwen-live-experimental)
in the daemon guide for the deployment details.

## Troubleshooting

- **`401` on start** — the API key belongs to a different region than the
  endpoint; set the endpoint to your key's region or dedicated domain.
- **"Live Voice is turned off, or this workspace is not trusted"** — enable
  Qwen Live in the Live section and use a trusted primary workspace.
- **Microphone could not be opened** — check the site permission and the OS
  microphone permission for your browser; use `https` or `localhost`.
- **No Live button** — the daemon must serve the Web Shell (no `--no-web`)
  with the ACP HTTP surface enabled (`QWEN_SERVE_ACP_HTTP=0` and the
  `hosted-harness` profile disable it), and advertise Live support; older
  daemons may lack the browser endpoint.

## Related

- [Voice Input](./voice-input.md) — speech-to-text dictation.
- [Model Providers — Live Voice routes](../configuration/model-providers.md#live-voice-routes)
- [Daemon mode — Qwen Live](../qwen-serve.md#qwen-live-experimental)
