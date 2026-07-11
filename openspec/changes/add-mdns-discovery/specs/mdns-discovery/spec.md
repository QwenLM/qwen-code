# mdns-discovery — spec delta

## ADDED Requirements

### Requirement: Advertisement registration

The daemon SHALL register an mDNS / DNS-SD service of type
`_qwen-rc._tcp.local.` when ALL of the following are true:

1. The HTTP server is bound to at least one non-loopback address.
2. The `--no-mdns` CLI flag is NOT set.
3. The `QWEN_RC_NO_MDNS` environment variable is NOT set to `1`.

The service registration SHALL use the HTTP server's listening
port. The TXT record SHALL contain the keys `version`, `name`,
`workspace`, and `tlsRequired` exactly. No other keys SHALL be
advertised.

#### Scenario: Loopback-only suppresses advertisement

- **GIVEN** `qwen serve --host 127.0.0.1` with no other flags
- **WHEN** the daemon starts
- **THEN** no `_qwen-rc._tcp.local.` service is registered
- **AND** the startup banner notes that mDNS is suppressed for a
  loopback-only bind

#### Scenario: Non-loopback advertises by default

- **GIVEN** `qwen serve --host 0.0.0.0 --port 7070`
- **WHEN** the daemon starts
- **THEN** a service of type `_qwen-rc._tcp.local.` is registered
  with port `7070`
- **AND** the TXT record contains exactly the four keys: `version`,
  `name`, `workspace`, `tlsRequired`

#### Scenario: `--no-mdns` overrides

- **GIVEN** `qwen serve --host 0.0.0.0 --no-mdns`
- **WHEN** the daemon starts
- **THEN** no service is registered
- **AND** the startup banner notes that mDNS was disabled by flag

#### Scenario: Env var overrides

- **GIVEN** `QWEN_RC_NO_MDNS=1 qwen serve --host 0.0.0.0`
- **WHEN** the daemon starts
- **THEN** no service is registered

### Requirement: TXT record schema

The TXT record SHALL carry these keys with these constraints:

- `version`: integer string matching the daemon's
  `remoteControl.version` capability value (currently `1`).
- `name`: 1–63 ASCII characters; default
  `<hostname>-<workspace-basename>`. Operator-overridable via
  `--mdns-instance-name`.
- `workspace`: 1–63 ASCII characters; default = basename of the
  daemon's workspace cwd. Operator-overridable via
  `--mdns-workspace-name`. The advertised value SHALL NEVER
  contain `/`, `\`, or be an absolute path.
- `tlsRequired`: literal string `"true"` or `"false"`.

The daemon SHALL NOT include in TXT records: absolute paths, owner
identifying information, token state, pairing-code presence, scope
listings, audit count, or session ids.

#### Scenario: Path traversal in TXT rejected at startup

- **GIVEN** the operator passes `--mdns-workspace-name ../etc`
- **WHEN** the daemon starts
- **THEN** the daemon refuses to start with a clear error
- **AND** no advertisement is registered

#### Scenario: Workspace value is basename only

- **GIVEN** the daemon's cwd is `/home/evan/projects/secret`
- **AND** no `--mdns-workspace-name` override
- **WHEN** the advertisement is registered
- **THEN** the TXT `workspace` value is `secret`
- **AND** the TXT record contains no full path

### Requirement: Operator override for workspace name

The daemon SHALL accept `--mdns-workspace-name <s>` to override the
default TXT `workspace` value. The override SHALL be subject to the
same character constraints (1–63 ASCII, no `/` or `\`).

#### Scenario: Override applies

- **GIVEN** `qwen serve --host 0.0.0.0
--mdns-workspace-name app-public`
- **WHEN** the advertisement is registered
- **THEN** the TXT `workspace` value is `app-public` regardless of
  the actual cwd basename

### Requirement: Goodbye on shutdown

The daemon SHALL register a SIGINT/SIGTERM handler that calls the
mDNS library's `unpublish` (Goodbye) sequence and waits up to
500 ms for Goodbye packets to be sent before process exit.

#### Scenario: Browse no longer shows daemon after SIGTERM

- **GIVEN** an observing host has just listed the daemon via
  `qwen rc daemons discover`
- **WHEN** the daemon receives SIGTERM and exits cleanly
- **AND** the observing host re-runs `qwen rc daemons discover`
  within 2 s
- **THEN** the daemon is not listed in the result

### Requirement: Browse helper

The CLI SHALL expose a browse function reachable via `qwen rc
daemons discover [--timeout <duration>] [--format json|table]`. The
helper SHALL:

- subscribe to `_qwen-rc._tcp.local.` for the given timeout
  (default 5 s)
- collect responses and dedupe by service name
- normalize each to a structured record with `name`, `host`,
  `port`, `version`, `tlsRequired`, `workspace`
- return them sorted by host then port

#### Scenario: Returns multiple daemons

- **GIVEN** two daemons advertising on the same LAN with distinct
  names
- **WHEN** the helper runs with `--timeout 3s`
- **THEN** the result contains exactly two entries (one per name)
- **AND** entries are sorted by host then port

#### Scenario: Empty when nothing advertises

- **GIVEN** no daemons advertising
- **WHEN** the helper runs with `--timeout 1s`
- **THEN** the result is empty
- **AND** the command exits 0 (not an error)

### Requirement: Discover CLI output

The `qwen rc daemons discover` table output SHALL include columns
`NAME`, `HOST`, `PORT`, `VERSION`, `TLS`, `WORKSPACE`. A trailing
summary line SHALL report the count and elapsed time.

`--format json` SHALL emit a JSON array of `{ name, host, port,
version, tlsRequired, workspace }` objects with no surrounding
text, suitable for scripting.

#### Scenario: Table format

- **WHEN** the operator runs `qwen rc daemons discover`
- **THEN** the first output line is the column header
- **AND** subsequent lines are one daemon per row
- **AND** the last line matches `^N daemons? found in .+s$`

#### Scenario: JSON format

- **WHEN** the operator runs `qwen rc daemons discover --format json`
- **THEN** the output is parseable as a JSON array
- **AND** every element contains the six documented fields

### Requirement: Capability advertisement

`GET /capabilities`'s `remoteControl` block SHALL include:

```jsonc
{
  "mdns": {
    "advertising": true | false,
    "instanceName": "<string, only when advertising>"
  }
}
```

`advertising` SHALL be `true` when the daemon has actually
registered a service; `false` when suppressed for any reason.

#### Scenario: Capability reflects effective state

- **GIVEN** the daemon is running with `--no-mdns`
- **WHEN** any token GETs `/capabilities`
- **THEN** the response's `remoteControl.mdns.advertising` is
  `false`
- **AND** `instanceName` is absent

- **GIVEN** the daemon is running with default flags on a
  non-loopback bind
- **WHEN** any token GETs `/capabilities`
- **THEN** the response's `remoteControl.mdns.advertising` is
  `true`
- **AND** `instanceName` matches what was registered with the mDNS
  library

### Requirement: Discovery does not bypass auth

mDNS advertisement and discovery SHALL NOT carry, hint at, or
expose any authentication material. Clients that discover a daemon
via `qwen rc daemons discover` SHALL still perform the standard
pairing flow defined by `add-remote-control`'s `pairing-auth`
spec before any session interaction.

#### Scenario: Discovered daemon still requires pairing

- **GIVEN** a client has discovered daemon `D` via mDNS
- **WHEN** the client opens a connection without a paired token
- **THEN** all session and audit endpoints return `401 Unauthorized`
- **AND** the client must run the pairing flow to obtain a token
