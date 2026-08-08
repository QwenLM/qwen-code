# Web Shell voice mode

## Goal

Make the Web Shell voice control honor the workspace voice mode already returned by the daemon.

## Behavior

| Mode   | Start                | Finish                | Cancel                 |
| ------ | -------------------- | --------------------- | ---------------------- |
| `hold` | Primary pointer down | Matching pointer up   | Pointer cancel         |
| `tap`  | Click while idle     | Click while recording | Click while connecting |

The control captures the active pointer so releasing outside the button still finishes a hold. Keyboard-generated clicks retain the existing toggle behavior in either mode.

Once microphone access is ready, audio produced while the socket connects is buffered locally. The socket receives `start`, the buffered audio, and then a deferred `stop`, so releasing during connection does not discard captured speech.

The mode is loaded with the existing workspace voice status and refreshed through the existing settings-version signal. A status request remains fail-closed: the control stays hidden until the current workspace reports that voice is enabled.

## Scope

This change only affects Web Shell input interaction. It does not change the daemon settings contract, transcription transport, model selection, or TUI voice behavior.
