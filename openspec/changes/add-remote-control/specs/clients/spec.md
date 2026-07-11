# clients — spec delta

## ADDED Requirements

### Requirement: `qwen rc` terminal client renders the standard TUI

The terminal client `qwen rc` SHALL render the same chat surface, input
box, status line, and approval prompts as the upstream qwen-code TUI.
Visual parity with vanilla `qwen` is the success criterion; rendering
divergences are bugs.

#### Scenario: User cannot tell `qwen rc` from `qwen` at a glance

- **GIVEN** an existing user familiar with the upstream TUI
- **WHEN** they run `qwen rc` against a local daemon
- **THEN** layout, colors, key bindings, and slash-command behavior
  match vanilla `qwen` for the in-session experience
- **AND** the only visible additions are a presence indicator (other
  clients attached) and a detach hint in the footer

### Requirement: `qwen rc` is a strict client of the daemon

`qwen rc` SHALL communicate with the daemon exclusively over the
documented HTTP+SSE (or WS) wire protocol. It MUST NOT bypass the
protocol to read agent state directly even when running on the same
host.

#### Scenario: Local and remote behave identically

- **GIVEN** a daemon `D` running on the local host
- **WHEN** `qwen rc` runs on the same host
- **THEN** every state read or write goes through HTTP/SSE
- **AND** there is no in-process shortcut from `qwen rc` to `D`'s
  internals

### Requirement: Terminal client detach-on-exit

`qwen rc` SHALL detach (close its SSE stream) without ending the
session when the user exits with `Ctrl-D` or `:detach`. Ending the
session SHALL require an explicit `:end` (or equivalent slash command)
which posts `/session/:id/end`.

#### Scenario: Ctrl-D detaches

- **GIVEN** an attached `qwen rc`
- **WHEN** the user presses `Ctrl-D`
- **THEN** the SSE stream closes
- **AND** the daemon retains the session
- **AND** the next `qwen rc attach` resumes the same session

#### Scenario: `:end` terminates the session

- **WHEN** the user types `:end` in the input
- **THEN** the client posts `/session/:id/end`
- **AND** other clients receive a `session_died` event with reason
  `ended_by_client`

### Requirement: Local-only slash commands handled in the client

Slash commands that depend on local-only state (`/mcp`, `/plugin`,
`/resume`) SHALL be handled inside the terminal client and MUST NOT be
forwarded to the daemon. Slash commands with cross-client effects
(`/compact`, `/clear`, `/context`, `/usage`) SHALL be sent to the
daemon and broadcast via the `ui_command` event.

#### Scenario: `/mcp` does not appear on other clients

- **GIVEN** a `qwen rc` and a web client both attached to session `S`
- **WHEN** the terminal user runs `/mcp`
- **THEN** only the terminal renders the picker
- **AND** the web client receives no event for the command

#### Scenario: `/clear` is broadcast

- **WHEN** the terminal user runs `/clear`
- **THEN** the daemon emits a `ui_command` event with
  `command: "clear"`
- **AND** the web client clears its rendered transcript while keeping
  the underlying session intact

### Requirement: Web client is a static bundle served from the daemon

The web client SHALL be a static HTML+JS bundle served by the daemon
under `/ui/`. It MUST NOT require a separate backend tier. It MUST
function from a phone browser on a modern (≤2 years old) version of
Safari or Chrome.

#### Scenario: Pairing-first flow

- **GIVEN** a user opens the daemon URL with no stored token
- **WHEN** the web client loads
- **THEN** the UI presents only a code entry field (and a QR scan path
  on mobile if supported)
- **AND** the rest of the UI is rendered only after successful
  redemption

#### Scenario: Token persisted to localStorage namespaced by origin

- **WHEN** redemption returns a token
- **THEN** the web client stores it under
  `localStorage["qwen-rc:<origin>:token"]`
- **AND** subsequent loads from the same origin skip pairing if the
  token validates

### Requirement: Web client supports mid-scope feature set

The web client SHALL render at minimum:

- live transcript with assistant text and tool-call cards
- input box for prompts, with cancel button while a prompt is in flight
- approve/deny buttons on `permission_request` events (idempotent;
  losing the vote is rendered as "approved/denied by <client>")
- slash-command palette listing supported commands and their effects
- read-only file tree of the workspace root (lazy expand, max depth 4)
- inline diff viewer for `permission_request` payloads describing file
  edits (syntax-highlighted, no in-place editing)
- presence indicator listing currently-attached clients (by name, not
  by IP)
- audit-events feed visible to `read` and above (filtered to actions
  the viewer has scope to see)

#### Scenario: Diff viewer renders before approval

- **GIVEN** a `permission_request` event with `data.toolCall.name =
"edit_file"` and a `diff` payload
- **WHEN** the web client receives it
- **THEN** the user sees a syntax-highlighted unified diff with
  before/after context
- **AND** the approve/deny buttons are disabled until the user has
  scrolled past the visible diff (mobile only; desktop has no scroll
  gate)

### Requirement: Web client reconnects after sleep or transient outage

The web client SHALL reconnect to the SSE stream after network loss or
browser-tab visibility resumption, using `Last-Event-ID` to replay
missed events.

#### Scenario: Tab returns from background

- **GIVEN** the browser tab was backgrounded for 30 minutes
- **WHEN** the user returns to the tab
- **THEN** the client detects the dropped SSE
- **AND** reconnects with `Last-Event-ID: <last seen>`
- **AND** missed events render in order before live events resume

#### Scenario: Replay truncated triggers full refresh

- **WHEN** reconnect returns `412 Precondition Failed`
- **THEN** the client discards in-memory state
- **AND** re-fetches the transcript via a daemon endpoint (or starts
  fresh if no resume endpoint is available)
- **AND** shows a non-intrusive banner "Session resync — earlier
  history not available"

### Requirement: Approvals from any client are visible everywhere

When any attached client wins the first-responder race on a
`permission_request`, every other attached client (regardless of
scope) SHALL receive the corresponding `permission_resolved` event and
render the outcome with the resolving client's name.

#### Scenario: Phone approves; laptop renders the resolution

- **GIVEN** the laptop and the phone are both attached
- **WHEN** the phone posts the approve vote first
- **THEN** the laptop's approve/deny buttons transition to a disabled
  "Approved by Phone (<clientName>) at <time>" state
- **AND** the daemon does NOT accept a competing late vote

### Requirement: No third-party telemetry

The terminal and web clients SHALL NOT make outbound requests to any
host other than the configured daemon, including for fonts, analytics,
or icon assets. All assets MUST be bundled.

#### Scenario: Network panel shows only daemon traffic

- **GIVEN** the web client is loaded against daemon at `D`
- **WHEN** the user inspects the browser network panel
- **THEN** every request URL has `D` as its origin
