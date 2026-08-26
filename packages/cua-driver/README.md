# Qwen CUA Driver

Qwen Code's vendored distribution of the cross-platform Cua Driver runtime.
It provides native desktop and browser automation over MCP, a one-shot CLI,
and in-process Python and TypeScript SDKs.

This tree is based on upstream `cua-driver-rs-v0.20.0`. The upstream snapshot
is recorded in [`.vendored-from`](.vendored-from); Qwen-owned differences are
documented in [`.vendored-patches.md`](.vendored-patches.md) and
[`docs/relative-coordinates-design.md`](docs/relative-coordinates-design.md).

## Install

macOS and Linux:

```bash
CUA_DRIVER_RS_VERSION=0.20.1 \
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cua-driver/scripts/install.sh)"
```

Windows PowerShell:

```powershell
$env:CUA_DRIVER_RS_VERSION = "0.20.1"
irm https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cua-driver/scripts/install.ps1 | iex
```

Expected: qwen-cua-driver 0.20.1.

The released product uses Qwen-owned identities throughout:

- executable: `qwen-cua-driver` / `qwen-cua-driver.exe`
- macOS app: `/Applications/QwenCuaDriver.app`
- bundle identifier: `com.qwencode.cua-driver`
- state home: `~/.cua-driver`
- Windows task: `qwen-cua-driver-serve`

Source builds install as the separate `qwen-cua-driver-local` product. The
Qwen executable, app, service, and local-build identities are distinct from
upstream CuaDriver. The release state home remains `~/.cua-driver` for
compatibility with existing Qwen releases, so installing both release
distributions for the same user is not supported: they can share or overwrite
that state directory.

## Agent integration

Run the MCP server directly:

```bash
qwen-cua-driver mcp
```

Register it with Qwen Code:

```bash
qwen mcp add cua-driver qwen-cua-driver mcp
```

Other MCP clients can use the same executable and arguments. Shell-oriented
automation can call tools through `qwen-cua-driver call`.

## 0.20 runtime and SDK surface

The 0.20 base includes the SDK-owned runtime and versioned C ABI, generated
Python and TypeScript UniFFI bindings, typed browser automation, permission
modes, runtime-owned consent adapters, transport-owned implicit lifecycle
sessions, per-action target selection, capability manifests across permission
profiles, snapshot-bound element tokens, closed action results, `verify_state`,
foreground-focus verification, native menu and clipboard operations, window
framing, and semantic cursor themes. Browser approval tokens are retired;
existing-profile access now requires a trusted launch grant, bounded manifest,
or embedding-host authorization.

Python applications import `cua_driver`. TypeScript applications import the
Qwen-owned `@qwen-code/cua-sdk` package. Both use the same
in-process native runtime; MCP remains the agent-facing boundary implemented by
`qwen-cua-driver`.

The stable C ABI is declared in
[`rust/include/cua_driver_abi.h`](rust/include/cua_driver_abi.h). The contract
and generated bindings are documented in [`contract/README.md`](contract/README.md).

## Permission modes

`standard` is the promptless default for ordinary automation. `bounded`
admits only reviewed tools and resources. `unrestricted` requires
`--dangerously-bypass-approvals`.

The mode belongs to the process that owns the runtime and is fixed at launch:
`qwen-cua-driver serve` takes the flags, while `qwen-cua-driver mcp` and embedding hosts
use the matching `CUA_DRIVER_PERMISSION_MODE`,
`CUA_DRIVER_CAPABILITY_MANIFEST_FILE`, and
`CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED` variables. Choose it before starting
the daemon; a running daemon must be restarted to change it.

Attaching to an existing logged-in Chromium profile remains explicit:

```bash
qwen-cua-driver mcp --grant existing-profile
```

An embedding application can instead provide `DriverAuthorizationHost` and
own the permission prompt and grant lifecycle.

## Qwen normalized coordinates

Pixel coordinates remain the default. Set:

```bash
export CUA_DRIVER_RS_COORDINATE_SPACE=1
export CUA_DRIVER_RS_COORDINATE_SCALE=1000 # optional; 1000 is the default
```

to expose and accept a 0-1000 coordinate grid. Translation happens at the
canonical tool-registry boundary shared by MCP, CLI, daemon, private worker,
replay, and direct SDK execution. Window-local actions use the most recent
snapshot dimensions; screen-space actions use the logical screen dimensions.
Missing or stale coordinate bases fail closed instead of being guessed.

Browser CSS coordinates are deliberately not normalized. In normalized mode,
use a fresh browser element reference for `browser_click` and
`browser_pointer`; raw CSS coordinates are rejected.

## Model-visible payload filtering

Set `MCP_MODEL_PAYLOAD_FILTER=1` to filter affected Qwen-facing textual MCP
payloads. The filter covers both text and structured content and leaves binary
image/media payloads opaque. It is off by default and does not change the
direct SDK contract.

## Telemetry boundary

Telemetry is disabled by default in the Qwen distribution. It can be enabled
explicitly with `qwen-cua-driver telemetry enable` or the documented
`CUA_DRIVER_RS_TELEMETRY_ENABLED=1` environment override. Explicit opt-in sends
the upstream content-free event schema to Cua's PostHog endpoint; no Qwen
telemetry service or proxy is involved.

Use `qwen-cua-driver telemetry status` to inspect the effective decision and
`qwen-cua-driver telemetry disable` to turn it off. A normal uninstall
preserves the preference and pseudonymous installation identifier; use
`--purge` on Unix or `CUA_DRIVER_RS_UNINSTALL_PURGE=1` on Windows to remove
them.

## macOS identity and permissions

macOS attributes Accessibility and Screen Recording grants to the responsible
app identity. Install and grant permissions to `QwenCuaDriver.app`. The
installed CLI can proxy through that app-owned daemon. `qwen-cua-driver mcp
--direct` deliberately uses the spawning host's TCC attribution and is not a
substitute for a certified embedding host.

Do not grant permissions to an arbitrary loose binary path in production.
Signed and notarized release artifacts are produced only by the Qwen-owned
release workflow.

## Repository layout

| Path | Purpose |
| --- | --- |
| `rust/` | Cargo workspace for the CLI, daemon, SDK, platform crates, and tests |
| `python/` | Python SDK and bundled-runtime wrapper |
| `typescript/` | TypeScript SDK and native runtime loader |
| `contract/` | Generated portable contract and fixtures |
| `tests/fixtures/` | Cross-platform GUI harness applications |
| `scripts/` | Release/local install, uninstall, generation, and sync helpers |
| `docs/` | Package-local architecture and behavior notes |

Start with [`rust/README.md`](rust/README.md),
[`docs/test-matrix.md`](docs/test-matrix.md), and
[`tests/fixtures/README.md`](tests/fixtures/README.md) when changing runtime
behavior or test coverage.

## Development

```bash
cd packages/cua-driver/rust
cargo fmt --all -- --check
cargo check -p cua-driver -p cua-driver-core -p cua-driver-sdk
cargo test -p cua-driver-core
```

Generated contract and language bindings must be checked with the package-local
scripts before release. Signed/notarized macOS, Windows UIAccess, Linux X11 and
Wayland, and real MCP/model verification remain platform release gates.
