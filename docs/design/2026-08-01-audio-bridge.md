# Audio bridge for user attachments

## Context

Qwen Code already transcribes ACP audio content blocks through the configured
`voiceModel` when the primary model does not support audio. Interactive and
headless `@` attachments do not use that path: file processing replaces an
unsupported audio file with a placeholder before the CLI can transcribe it.

## Design

Extract the ACP-only conversion into a shared CLI audio-bridge service. The
service accepts normalized prompt parts, keeps audio unchanged when the active
primary model supports it, and otherwise replaces every audio part with an
untrusted machine transcript produced by `voiceModel`. Missing configuration,
oversized audio, empty transcripts, request failures, and cancellation never
forward raw audio to a text-only primary model.

Interactive and headless `@` resolution preserve unsupported audio through
attachment processing — mirroring ACP — and run the shared bridge before the
existing vision bridge. The bridge then enforces its 10 MiB per-audio limit;
when no batch-capable `voiceModel` is selected, it owns the fail-closed outcome
(unavailable marker plus notice). ACP direct audio blocks use the same service
and keep their existing agent-message disclosure; when the bridge skips for an
audio-capable target, the inline-media clamp owns oversized audio again. A
bridge notice identifies the voice model whenever audio left the machine,
including failed or empty responses.

The existing `voiceModel` setting and `/model --voice` command remain the sole
configuration surface. Voice dictation behavior is unchanged.

## Scope

This change covers user-supplied ACP audio blocks and interactive/headless
`@audio` attachments. Audio nested in tool results, channel-specific attachment
plumbing, video, and realtime dictation are unchanged.
