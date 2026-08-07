# OpenTelemetry Session Lifecycle

## Status

Implemented in issue #8589.

## Scope

Qwen Code already records the application session ID as `session.id` and maps
it to `gen_ai.conversation.id` on GenAI LLM and agent spans. This design adds
the OpenTelemetry General Session lifecycle events without removing the
existing Qwen-specific telemetry fields or event names.

The implementation follows the Development-status General Session semantic
conventions at:

<https://opentelemetry.io/docs/specs/semconv/general/session/>

The GenAI conversation mapping follows:

<https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md>

## Event representation

The standard lifecycle events are emitted as OpenTelemetry LogRecords with
the required `event.name` attribute:

| Event           | Required attributes | Emission point                                           |
| --------------- | ------------------- | -------------------------------------------------------- |
| `session.start` | `session.id`        | Initial `Config` initialization and every session switch |
| `session.end`   | `session.id`        | Session switch and telemetry shutdown                    |

The existing `qwen-code.config` / `cli_config` and RUM `session_start` events
remain unchanged for backward compatibility. The standard records are
additive and are emitted through the configured OpenTelemetry logs pipeline.

## Session continuation

`Config.startNewSession()` is used for both replacing the current conversation
(`/clear`, `/new`) and resuming a persisted conversation. A persisted
`sessionData` argument identifies the latter continuation case. On a
continuation, the new `session.start` record includes
`session.previous_id`; replacement sessions do not claim continuation.

The outgoing session is ended before the new session starts. Telemetry
shutdown ends the currently active session before shutting down the SDK.

## Compatibility and safety

- `session.id` remains on existing spans and logs.
- `gen_ai.conversation.id` remains the session correlation field for GenAI
  spans.
- `session.previous_id` is emitted only when the application has an explicit
  persisted continuation, and it is never equal to the new `session.id`.
- Cold-start resumptions (`--resume`, `--continue`, `--fork-session`) do not
  carry `session.previous_id`; startup lineage, including the fork source, is
  left to a follow-up.
- Session event emission is best-effort through the existing OTel logger and
  does not block session switching or shutdown.
