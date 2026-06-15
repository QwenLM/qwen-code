# Voice input — no gateway-side work (by design)

`add-voice-input` is an **entirely client-side** feature: audio is captured in the
browser and transcribed by the browser's built-in Web Speech API. It never
reaches the daemon or the gateway.

The spec's only daemon-facing requirement is a **negative** one:

> The daemon SHALL NOT receive any indication that a prompt was composed via voice
> input. No new audit fields, no new SSE events, no header on the submitted prompt
> request.

This is **already satisfied** and requires no code: `POST /rc/session/:id/prompt`
(`createPromptRoute`, mounted in `server.ts`) records no input-method marker, and
the audit row for a prompt has no `inputMethod`/voice field. A voice-composed
prompt is byte-for-byte identical to a typed one on the wire.

**Action for the gateway: none.** This note exists so a future pass does not
re-investigate voice-input as a "missing" spec — the gateway requirement is the
absence of a marker, and that invariant holds. If a voice marker is ever added to
the prompt route or its audit, it would _violate_ this spec.
