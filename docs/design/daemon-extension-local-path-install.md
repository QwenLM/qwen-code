# Daemon Extension Local Path Installation

## Problem

The CLI can install an Extension from a path on the daemon host, but the daemon
REST install routes reject the same source. Callers that already placed an
Extension on the daemon filesystem must therefore start a terminal command
instead of using the asynchronous Extension operation API.

## Design

Allow an existing daemon-local path in the `source` field of both install
contracts:

- `POST /workspace/extensions/install` remains the primary-workspace
  compatibility route and installs with user activation.
- `POST /extensions/install` remains the process-global V2 route and uses its
  existing explicit user or workspace activation request.

No new route or SDK method is needed. `DaemonClient.installExtension()` and
`DaemonClient.installUserExtension()` already send the shared
`ExtensionInstallRequest.source` field and poll the existing operation model.
The accepted source set becomes Git, GitHub, npm, or a path that exists on the
daemon host and is classified as `local` by the existing source parser.

Local installation keeps the current CLI semantics: the Extension manager
copies the source into managed Extension storage rather than linking it. A
directory or a supported local archive path therefore uses the same parsing,
conversion, consent, staging, commit, and cleanup logic already exercised by
the CLI. The REST contract accepts only absolute local paths. This avoids
resolving a relative path against the daemon process working directory and
prevents an existing local `owner/repo` directory from shadowing a remote
GitHub shorthand.

Advertise `extension_local_path_install` so clients can distinguish daemons
that accept local paths from older daemons that reject them. The capability
covers both install routes; clients must still preflight
`extension_management_v2` before using the V2 route.

## Security and failure behavior

- Existing bearer authentication, strict mutation gating, workspace trust,
  client identity validation, explicit consent, operation admission, and
  runtime reconciliation remain unchanged.
- The path is resolved and read by the daemon host, not the SDK caller.
- Relative local paths are rejected; callers must send an absolute path in the
  daemon host's path syntax.
- A missing path is rejected before the legacy compatibility route queues an
  operation. V2 preparation reports source parsing failures through the
  existing operation status contract.
- Local sources do not accept URL credentials, `ref`, or `autoUpdate`.
  Existing npm registry and activation validation remains authoritative.
- Installed metadata records the local source path, matching CLI behavior.

## Test plan

- Verify the primary-workspace route queues an existing local path and prepares
  it as `type: "local"`.
- Verify the V2 route queues the same source and preserves its explicit initial
  activation.
- Verify missing local paths, explicit consent, client identity, workspace
  trust, and unsupported remote source behavior remain unchanged.
- Verify `/capabilities` advertises `extension_local_path_install`.
- Install a minimal Extension from an absolute temporary directory through the
  daemon, poll the operation to success, and confirm the installed catalog
  entry.
