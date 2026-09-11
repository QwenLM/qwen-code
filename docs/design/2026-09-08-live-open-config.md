# Open the active Live configuration from Settings

## Problem and scope

The Host Settings panel edits selected preferences but cannot open the complete
standalone Live configuration. The daemon loads `config.json` under its own
resolved data directory; a separately launched Host cannot infer that directory
from its environment. This change adds one native-editor action, without a new
editor preference, config editor, live reload, or wire-protocol version.

## Design

The standalone daemon adds its absolute `configPath` to the existing private
discovery record. The Host validates this optional field (absolute path,
`config.json` basename, bounded length, no NUL) and includes it in the discovery
identity. The connection exposes the path only after the matching nonce welcome
and while the socket is ready. Older daemons and built-in `qwen serve` omit the
field and do not acquire standalone configuration authority.

The renderer receives only `canOpenConfig`, not a filesystem path or contents.
A no-argument `openConfig()` preload action reaches a trusted-sender IPC handler.
The main process rejects inactive renderers, unavailable connections and Quit,
checks the advertised target is a regular non-symlink file, then uses Electron
`shell.openPath`. The operating system's JSON-file association selects the IDE
or text editor. No shell command is composed and renderer arguments cannot
select a file. Missing, inaccessible or unsafe targets and native-open failures
produce localized errors without exposing filesystem errors or file contents.
No config is created or overwritten.

Settings gains a compact, right-aligned `Open config.json ↗` action at the top
of its scrollable content, separate from the draggable header. An adjacent
status/hint explains the default editor and restart requirement, reports errors,
and identifies unsupported connections. Pending opens are deduplicated; the
existing Settings geometry, language/theme order, focus trap and drag behavior
remain unchanged. All English and Chinese display text stays in the shared Live
message catalog. Opening a file never stops the call or changes preferences.

## Affected components

- Standalone daemon/discovery: publish the authoritative configuration path.
- Host discovery/connection: validate and scope the optional capability.
- Host main/preload/public API: privileged open action and boolean availability.
- Settings, shared message catalog and Host/Live READMEs: discoverable bilingual
  action, status and usage documentation.
- Focused discovery, connection, native IPC, renderer and localization tests.

## Verification and open questions

Use isolated discovery records, a local WebSocket fixture, the native IPC test
harness and a built-renderer browser fixture. Do not open the user's real config
in tests, read its secrets or start real media/provider sessions. Verify legacy
connections, custom directories, nonce/renderer rejection, missing/unsafe files,
open failures, bilingual pending/error states and unchanged drag bounds.
Native editor choice is controlled by the user's OS association; actual editor
launch is not required for the deterministic regression suite. No blocking
design questions remain.
