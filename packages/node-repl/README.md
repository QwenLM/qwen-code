# @qwen-code/node-repl-mcp

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes a **session-persistent Node.js REPL** as two MCP tools. It runs a real
Node.js kernel in a dedicated child process; top-level bindings, closures, and
module state persist across calls within a session.

This package is **fully independent of `@qwen-code/qwen-code-core`** — any MCP
client (Qwen Code via `mcpServers`, Claude, Codex, etc.) can run it.

## Tools

| Tool       | Description                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `js`       | Execute JavaScript to completion. `{ code, timeout_ms?, title? }`, default timeout 30 seconds. |
| `js_reset` | Discard bindings and restart the kernel on the next call.                                      |

The first call preloads global `cua` and emits the current platform's runtime
documentation. Start with `var app = await cua.getApp("Application")`; it displays
AX state automatically. Use `app.getAXState()`, `app.getScreenshot()`, or
`app.getAXStateAndScreenshot()` for observations, with `emit:false` to suppress
automatic display. Actions return void; observe to confirm the result.
Call `cua.rewriteDocumentation()` after context compaction. `cua.desktop` provides explicit foreground desktop input; `cua.getBrowser/getTab/createBrowserTab` wrap the existing browser SDK. The SDK and browser SDK are installed as matching dependencies. Graceful reset/disposal closes the native session and releases held desktop keys before terminating the kernel.

### Cell semantics

- Explicit output only: `nodeRepl.write(value)` for text, `nodeRepl.emitImage(png|jpeg|webp)`
  for images; byte payloads may include JSON-serializable `metadata`, which is
  returned immediately before each retained image, independently of the prose
  output budget. Metadata for rejected or omitted images is also omitted.
  `console.*` is captured. Plain expression results are not returned.
- `nodeRepl.cwd` / `homeDir` / `tmpDir` and `nodeRepl.getHeapStatus()` are available.
- Top-level static `import` is not allowed — use dynamic `await import()`.
- Declared bindings stay live across cells: after replacing an observation,
  helpers that captured its binding read the replacement. Helper assignments
  and direct assignments share the same binding, including within one cell.
- Bare packages resolve from the session `cwd` `node_modules` plus any directory
  configured by the host with `QWEN_NODE_REPL_MODULE_DIRS`; package entrypoints use Node
  singleton caching. Local `.js`/`.mjs` reload on each execution.
- Node builtins are importable except `process`/`node:process`. Use
  `(await import('node:module')).createRequire(import.meta.url)` for CommonJS or
  native (N-API) addons.
- Timeout and cancellation normally stop only the active cell. Earlier bindings
  and the kernel process remain available, while new bindings from that cell are
  not committed. If the kernel does not return a terminal result within five
  seconds of cancellation, the host terminates it and reports that all bindings
  were lost. A subsequent cell starts a fresh kernel. External actions may have
  completed, so verify external state before retrying. `js_reset` or a
  real process crash also discards all bindings.
- When the kernel is retained, runtime errors keep completed statement/declarator
  checkpoints; cancellation and timeout restore binding values from cell entry.
  Object mutations and external side effects are not rolled back.

> Isolation note: the VM context provides lifecycle/namespace isolation, **not** an
> OS security sandbox. Imported packages and builtins run with ordinary Node.js
> authority and inherit the parent environment. Grant this server only in trusted
> contexts.

## Usage

### Requirements and installation

Install Node.js **22 or later**, including npm, and the MCP client you want to
use. Run the server on the computer whose desktop you want to control.
The commands below target **0.26.0** and require that version's npm packages
and native GitHub Release (`cua-driver-rs-v0.26.0`) to be published.

`npx` downloads the server on first launch. It automatically installs
`@qwen-code/cua-sdk@0.26.0` and `@qwen-code/browser-use@0.26.0`; the SDK's
installation downloads the matching native payload and verifies its SHA-256
checksum. Allow npm installation scripts and network access to npm and GitHub
Releases. No separate SDK install, manual SDK import, skill installation,
or standalone `qwen-cua-driver` CLI installation is needed.

Claude Code and Codex do not require Qwen Code to use this server. These
component versions do not require a Qwen Code CLI or Web Shell release with
the same version. For direct native MCP tools instead of JavaScript, see the
[CUA Driver README](../cua-driver/README.md#agent-integration).

### Qwen Code

On macOS/Linux:

```bash
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@0.26.0
```

This writes the server entry to `~/.qwen/settings.json`. Use `--scope project`
for the current project's `.qwen/settings.json` instead. The equivalent
settings entry is:

```jsonc
{
  "mcpServers": {
    "node-repl": {
      "command": "npx",
      "args": ["-y", "@qwen-code/node-repl-mcp@0.26.0"],
    },
  },
}
```

### Claude Code

On macOS/Linux:

```bash
claude mcp add --scope user --transport stdio node-repl -- npx -y @qwen-code/node-repl-mcp@0.26.0
```

User scope is stored in `~/.claude.json`. Use `--scope project` to write the
current project's `.mcp.json` instead; its `mcpServers` entry can use the same
JSON shape as above. See the
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

### Codex

On macOS/Linux:

```bash
codex mcp add node-repl -- npx -y @qwen-code/node-repl-mcp@0.26.0
```

Alternatively, add the following to `~/.codex/config.toml`. The longer startup
timeout allows time for the first npm/native payload download; add it to the
existing table if you registered the server with the CLI.

```toml
[mcp_servers.node-repl]
command = "npx"
args = ["-y", "@qwen-code/node-repl-mcp@0.26.0"]
startup_timeout_sec = 120
```

Use an absolute `npx` executable path if the client's `PATH` does not include
your Node.js installation. See the
[official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

### Windows client commands

In PowerShell, use `cmd.exe` to launch npm's `npx` command. Run the command for
your chosen client:

```powershell
# Qwen Code
qwen mcp add --scope user node-repl cmd.exe /d /c npx -y @qwen-code/node-repl-mcp@0.26.0

# Claude Code
claude mcp add --scope user --transport stdio node-repl -- cmd.exe /d /c npx -y @qwen-code/node-repl-mcp@0.26.0

# Codex
codex mcp add node-repl -- cmd.exe /d /c npx -y @qwen-code/node-repl-mcp@0.26.0
```

For manual JSON/TOML configuration on Windows, set `command` to `"cmd.exe"`
and `args` to `["/d", "/c", "npx", "-y", "@qwen-code/node-repl-mcp@0.26.0"]`.

### Permissions and connection check

Restart the client, then check `qwen mcp list`, `claude mcp list`, or
`codex mcp list`. Inside the session, use `/mcp` to check that `node-repl`
is connected and exposes `js` and `js_reset`. Ask the agent to execute this
first `js` call:

```js
await cua.getState();
```

It displays the current platform's instructions and application inventory.
Continue with `var app = await cua.getApp('Application name')` using an
application from that observation. The global `cua` is already loaded.

On macOS, grant Accessibility and Screen Recording to the responsible host
shown by macOS (the client, terminal, or Node process, depending on how you
launched it). Automation may also be requested for document/Finder actions.
These SDK grants follow the host's OS responsibility chain; the standalone
`QwenCuaDriver.app` grant does not replace them. On Linux, pass the desktop
environment as described below. Browser automation uses Chrome 125 or later on
macOS/Linux and requires the
[Qwen Code browser extension](https://chromewebstore.google.com/detail/qwen-code/hdhmmjclhibojdddmancfgbkleahfaph)
installed in the Chrome profile you want to control.

### Local development and environment

For a build in this repo, point at `dist/index.js`:

```jsonc
{
  "mcpServers": {
    "node-repl": {
      "command": "node",
      "args": ["/path/to/packages/node-repl/dist/index.js"],
      "cwd": "/your/workspace",
    },
  },
}
```

The `cwd` you set is the kernel's working directory and the base for bare-package
resolution (`<cwd>/node_modules`).

Environment:

- `QWEN_NODE_REPL_ROOTS` — extra readable roots (path-list, OS delimiter).
- `QWEN_NODE_REPL_MODULE_DIRS` — host-configured `node_modules` directories (path-list, OS delimiter); retained across reset.
- `QWEN_NODE_REPL_DEBUG` — set truthy for stderr debug logging.

### Linux desktop sessions

When using the CUA SDK, start the MCP server with the environment of the desktop
session it will control. The kernel inherits the server's environment at startup;
variables removed by the MCP client cannot be recovered by the SDK. For Codex,
add the following allowlist to the existing server entry in `config.toml`:

```toml
[mcp_servers.node-repl]
command = "npx"
args = ["-y", "@qwen-code/node-repl-mcp@0.26.0"]
startup_timeout_sec = 120
env_vars = ["DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY", "GTK_MODULES", "QT_ACCESSIBILITY", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON"]
```

The client process must already have the correct values. For hosts that use an
explicit `env` map, populate it from that same desktop session; display numbers,
authentication paths, and bus addresses vary by machine and user. Restart the
MCP server after changing its environment. An X11 connection failure is reported
as `desktop_unavailable` by CUA discovery, rather than as an empty desktop.
Linux supports X11 applications, including XWayland; native Wayland
applications are unsupported. Add `env_vars` to the existing table rather
than creating a second table for the same server.

Uncaught errors preserve a string `code` and bounded `details` text in MCP output,
including action and verification diagnostics. External side effects may already
have happened when an error is thrown; use those diagnostics before retrying.

## Desktop relay

`node-repl-mcp desktop-relay` lends this server to a Qwen Code session running
somewhere else, typically a headless dev box, so the Computer Use runtime can
drive the desktop you are sitting at. On macOS:

```bash
npx -y @qwen-code/node-repl-mcp@0.26.0 desktop-relay install
```

This installs the server and `@qwen-code/cua-sdk` under `~/.qwen/desktop-relay`
and registers a launchd socket on `127.0.0.1:47821` in inetd mode: nothing runs
until something connects, and each connection gets its own short-lived process.

- **Web Shell.** In a session served by a remote `qwen serve` (started with
  `QWEN_SERVE_CLIENT_MCP_OVER_WS=1`), choose **Use this computer** in the sidebar
  footer. A native dialog on this computer asks for approval; once allowed, the
  relay starts the JavaScript MCP server here and registers it for that one session over the
  daemon's reverse tool channel. Disconnect from the same entry.

An approved session can run code on this computer with your permissions and see
and control its screen, exactly as a local `node_repl` can. Every connection is
approved separately; nothing is remembered. `desktop-relay status` shows the last
connection, `desktop-relay uninstall [--purge]` removes the socket (and the
runtime).

If the browser cannot reach the relay, the remote connection may still be
running. Request a local disconnect without using the loopback socket:

```bash
~/.qwen/desktop-relay/node_modules/.bin/node-repl-mcp desktop-relay disconnect
```

This checks the recorded process identity before sending SIGTERM; it does not
download a package. For a custom installation, use that installation's executable
and add `--home <dir>`. The command reports a disconnect request, not a confirmed
shutdown; `desktop-relay status` shows the last recorded state.

## Build & test

```bash
npm run build         # tsc (tsconfig.build.json) + copy runtime assets into dist/runtime
npm run typecheck     # includes the test files
npm test              # vitest: kernel integration, N-API, 100-cell + 10-kernel scale,
                      # line fidelity, hoisting semantics, MCP surface
npm run smoke           # kernel manager + output adapter, in-process
npm run smoke:mcp       # real MCP client <-> built stdio server
npm run smoke:lifecycle # proves the kernel child is reaped on stdin EOF / signals
```

> Run vitest from inside this package. A bare `npx vitest run` from the repo root
> executes every workspace project (tens of thousands of tests) and can exhaust
> the default heap.

## Provenance

Ported from the Qwen Code PR #9499 Node REPL core (kernel, module loader, cell
transform, protocol, security policy, kernel manager). The qwen-coupled result
converter was replaced by `output-adapter.ts`, which emits MCP content blocks.
The empty-in-production trusted-package / sha256-pinning layer was removed
entirely: this runtime has no trusted-package or capability mechanism.

Relayed `js` calls have a 20-second execution limit so cancellation and the
terminal response fit the daemon's 30-second reverse-channel deadline. Local
stdio calls retain the default 30-second limit.
