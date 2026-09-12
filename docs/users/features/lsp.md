# Language Server Protocol (LSP) Support

Qwen Code provides native Language Server Protocol (LSP) support, enabling advanced code intelligence features like go-to-definition, find references, diagnostics, and code actions. This integration allows the AI agent to understand your code more deeply and provide more accurate assistance.

## Overview

LSP support in Qwen Code works by connecting to language servers that understand your code. Once you configure servers via `.lsp.json` (or extensions), Qwen Code can start them and use them to:

- Navigate to symbol definitions
- Find all references to a symbol
- Get hover information (documentation, type info)
- View diagnostic messages (errors, warnings)
- Access code actions (quick fixes, refactorings)
- Analyze call hierarchies

## Quick Start

LSP is an experimental feature in Qwen Code. To enable it, use the `--experimental-lsp` command line flag:

```bash
qwen --experimental-lsp
```

LSP servers are configuration-driven. You must define them in `.lsp.json` (or via extensions) for Qwen Code to start them.

### Prerequisites

You need to have the language server for your programming language installed:

| Language              | Language Server            | Install Command                                                                |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| TypeScript/JavaScript | typescript-language-server | `npm install -g typescript-language-server typescript`                         |
| Python                | pylsp                      | `pip install python-lsp-server`                                                |
| Go                    | gopls                      | `go install golang.org/x/tools/gopls@latest`                                   |
| Rust                  | rust-analyzer              | [Installation guide](https://rust-analyzer.github.io/manual.html#installation) |
| C/C++                 | clangd                     | Install LLVM/clangd via your package manager                                   |
| Java                  | jdtls                      | Install JDTLS and a JDK                                                        |

## Configuration

### .lsp.json File

You can configure language servers using a `.lsp.json` file in your project root. Each top-level key is a language identifier, and its value is the server configuration object.

**Basic format:**

```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact"
    }
  }
}
```

### C/C++ (clangd) configuration

Dependencies:

- clangd (LLVM) must be installed and available in PATH.
- A compile database (`compile_commands.json`) or `compile_flags.txt` is required for accurate results.

Example:

```json
{
  "cpp": {
    "command": "clangd",
    "args": [
      "--background-index",
      "--clang-tidy",
      "--header-insertion=iwyu",
      "--completion-style=detailed"
    ]
  }
}
```

### Java (jdtls) configuration

Dependencies:

- JDK installed and available in PATH (`java`).
- JDTLS installed and available in PATH (`jdtls`).

Example:

```json
{
  "java": {
    "command": "jdtls",
    "args": ["-configuration", ".jdtls-config", "-data", ".jdtls-workspace"]
  }
}
```

### Configuration Options

#### Transport Fields

| Option    | Type   | Description                                                             |
| --------- | ------ | ----------------------------------------------------------------------- |
| `command` | string | Required only for `stdio`. Resolved through `PATH` or an absolute path. |

#### Optional Fields

| Option                  | Type     | Default   | Description                                                                                                                                           |
| ----------------------- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `args`                  | string[] | `[]`      | Command line arguments                                                                                                                                |
| `transport`             | string   | `"stdio"` | Transport type: `stdio`, `tcp`, or `socket`                                                                                                           |
| `env`                   | object   | -         | Environment variables                                                                                                                                 |
| `initializationOptions` | object   | -         | LSP initialization options                                                                                                                            |
| `settings`              | object   | -         | Server settings via `workspace/didChangeConfiguration`                                                                                                |
| `extensionToLanguage`   | object   | -         | Maps file extensions to language identifiers                                                                                                          |
| `workspaceFolder`       | string   | -         | Override workspace folder (must be within project root)                                                                                               |
| `startupTimeout`        | number   | `10000`   | Spawn or socket connection timeout (milliseconds)                                                                                                     |
| `shutdownTimeout`       | number   | `5000`    | Shutdown timeout in milliseconds                                                                                                                      |
| `restartOnCrash`        | boolean  | `false`   | Auto-restart on crash                                                                                                                                 |
| `maxRestarts`           | number   | `3`       | Maximum restart attempts                                                                                                                              |
| `trustRequired`         | boolean  | `true`    | Require a trusted workspace. Project `.lsp.json` always forces `true`; only extension configs can set `false`. See [Trust Controls](#trust-controls). |

The top-level key is the language identifier. When any transport specifies
`command`, that value is also used as the server name; configurations without a
command use the language identifier as their name. The server name identifies
entries both within one source and across sources. When several entries resolve
to the same name, the last entry in a source wins, and project configuration
replaces extension configuration. To use one command for several file types,
prefer one entry with an `extensionToLanguage` map instead of repeating the
command under several language keys.

Qwen Code watches the project-root `.lsp.json` for semantic changes and
reconciles added, removed, and changed servers. Invalid JSON leaves the current
LSP runtime unchanged and reports the configuration error.

### TCP/Socket Transport

For servers that use TCP or Unix socket transport:

```json
{
  "remote-lsp": {
    "transport": "tcp",
    "socket": {
      "host": "127.0.0.1",
      "port": 9999
    },
    "extensionToLanguage": {
      ".custom": "custom"
    }
  }
}
```

## Available LSP Operations

Qwen Code exposes LSP functionality through the unified `lsp` tool. Here are the available operations:

Location-based operations (`goToDefinition`, `findReferences`, `hover`, `goToImplementation`, and `prepareCallHierarchy`) require `filePath` and `line`. `character` is optional and defaults to column 1. If you do not know the exact position, use `workspaceSymbol` or `documentSymbol` first to locate the symbol.

### Code Navigation

#### Go to Definition

Find where a symbol is defined.

```
Operation: goToDefinition
Parameters:
  - filePath: Path to the file
  - line: Line number (1-based)
  - character: Column number (optional, defaults to 1)
  - serverName: Registered server name shown by /lsp (optional)
```

#### Find References

Find all references to a symbol.

```
Operation: findReferences
Parameters:
  - filePath: Path to the file
  - line: Line number (1-based)
  - character: Column number (optional, defaults to 1)
  - includeDeclaration: Include the declaration itself (optional)
  - serverName: Registered server name shown by /lsp (optional)
```

#### Go to Implementation

Find implementations of an interface or abstract method.

```
Operation: goToImplementation
Parameters:
  - filePath: Path to the file
  - line: Line number (1-based)
  - character: Column number (optional, defaults to 1)
  - serverName: Registered server name shown by /lsp (optional)
```

### Symbol Information

#### Hover

Get documentation and type information for a symbol.

```
Operation: hover
Parameters:
  - filePath: Path to the file
  - line: Line number (1-based)
  - character: Column number (optional, defaults to 1)
  - serverName: Registered server name shown by /lsp (optional)
```

#### Document Symbols

Get all symbols in a document.

```
Operation: documentSymbol
Parameters:
  - filePath: Path to the file
  - serverName: Registered server name shown by /lsp (optional)
```

#### Workspace Symbol Search

Search for symbols across the workspace.

```
Operation: workspaceSymbol
Parameters:
  - query: Search query string
  - limit: Maximum results (optional)
```

### Call Hierarchy

#### Prepare Call Hierarchy

Get the call hierarchy item at a position.

```
Operation: prepareCallHierarchy
Parameters:
  - filePath: Path to the file
  - line: Line number (1-based)
  - character: Column number (optional, defaults to 1)
  - serverName: Registered server name shown by /lsp (optional)
```

#### Incoming Calls

Find all functions that call the given function.

```
Operation: incomingCalls
Parameters:
  - callHierarchyItem: Item from prepareCallHierarchy
  - serverName: Registered server name shown by /lsp (optional, defaults to the item's server)
```

#### Outgoing Calls

Find all functions called by the given function.

```
Operation: outgoingCalls
Parameters:
  - callHierarchyItem: Item from prepareCallHierarchy
  - serverName: Registered server name shown by /lsp (optional, defaults to the item's server)
```

### Diagnostics

#### File Diagnostics

Get diagnostic messages (errors, warnings) for a file.

```
Operation: diagnostics
Parameters:
  - filePath: Path to the file
  - serverName: Registered server name shown by /lsp (optional)
```

#### Workspace Diagnostics

Get all diagnostic messages across the workspace.

```
Operation: workspaceDiagnostics
Parameters:
  - limit: Maximum results (optional)
  - serverName: Registered server name shown by /lsp (optional)
```

Diagnostics use the LSP pull methods `textDocument/diagnostic` and
`workspace/diagnostic`; servers must support the corresponding method. Qwen
Code does not currently consume pushed `publishDiagnostics` notifications.
Because failed or unsupported requests are skipped, an empty result does not
reliably prove that the file or workspace has no diagnostics.

### Code Actions

#### Get Code Actions

Get available code actions (quick fixes, refactorings) at a location.

```
Operation: codeActions
Parameters:
  - filePath: Path to the file
  - line: Start line number (1-based)
  - character: Start column number (optional, defaults to 1)
  - endLine: End line number (optional, defaults to line)
  - endCharacter: End column (optional, defaults to character)
  - diagnostics: Diagnostics to get actions for (optional)
  - codeActionKinds: Filter by action kind (optional)
  - serverName: Registered server name shown by /lsp (optional)
```

Code action kinds:

- `quickfix` - Quick fixes for errors/warnings
- `refactor` - Refactoring operations
- `refactor.extract` - Extract to function/variable
- `refactor.inline` - Inline function/variable
- `source` - Source code actions
- `source.organizeImports` - Organize imports
- `source.fixAll` - Fix all auto-fixable issues

## Security

Language servers run with the permissions of the Qwen Code process and can
execute code. Project `.lsp.json` entries are always loaded with
`trustRequired: true`, so a project file cannot opt itself out of the trust
check. The check blocks a server only when the workspace is considered
untrusted. Folder trust (`security.folderTrust.enabled`) is disabled by default;
while disabled, every workspace is considered trusted and `/trust` is not
available. An IDE may also report a workspace as untrusted.

### Trust Controls

- **Project `.lsp.json`**: The configured `trustRequired` value is ignored and
  forced to `true`; it blocks startup only when the workspace is considered
  untrusted
- **Extension configuration**: An extension may set `trustRequired: false` for
  an individual server, but the global folder-trust setting can still require
  all servers to run only in trusted workspaces

When folder trust is enabled, use `/trust` to mark a workspace as trusted.

## Troubleshooting

### Server Not Starting

1. **Verify `--experimental-lsp` flag**: Make sure you're using the flag when starting Qwen Code
2. **Check if the server is installed**: Run the command manually (e.g. `clangd --version`) to verify
3. **Check the command**: The server binary must be in your system `PATH`, or specified as an absolute path (e.g. `/opt/llvm/bin/clangd`). Relative paths that escape the workspace are blocked
4. **Check workspace trust**: If folder trust is enabled, use `/trust`; if your IDE reports the workspace as untrusted, trust it in the IDE
5. **Check logs**: Start Qwen Code with `--debug`, then search for LSP-related entries in the debug log (see Debugging section below)
6. **Check the process**: Run `ps aux | grep <server-name>` to verify the server process is running

### Slow Performance

1. **Large projects**: Consider excluding `node_modules` and other large directories
2. **Transport timeout**: Increase `startupTimeout` when process creation or a socket connection is slow. Protocol requests, including `initialize`, use a separate fixed 15-second timeout

### No Results

1. **Server not ready**: The server may still be indexing. For C/C++ projects with clangd, ensure `--background-index` is in the args and a `compile_commands.json` (or `compile_flags.txt`) exists in the project root or a parent directory. Use `--compile-commands-dir=<path>` if it is in a build subdirectory
2. **Stale file contents**: Qwen Code sends `textDocument/didOpen` on first access but does not currently send `didChange` or `didSave`. Saving an already opened file does not guarantee that the server receives the new contents; restart the session to reopen it
3. **Wrong language**: Check if the correct server is running for your language
4. **Check the process**: Run `ps aux | grep <server-name>` to verify the server is actually running

### Debugging

LSP does not have a separate debug flag. Use Qwen Code's normal debug mode together with the LSP feature flag:

```bash
qwen --experimental-lsp --debug
```

Debug logs are written to the session debug log directory. To check LSP-related entries:

```bash
# Default runtime directory
rg "LSP|Native LSP|clangd|connection closed" ~/.qwen/debug/latest
# Or, without ripgrep:
grep -E "LSP|Native LSP|clangd|connection closed" ~/.qwen/debug/latest

# If QWEN_RUNTIME_DIR is configured
rg "LSP|Native LSP|clangd|connection closed" "$QWEN_RUNTIME_DIR/debug/latest"
```

Useful entries include:

- `[LSP] ...`: Logs emitted by the native LSP service and server manager.
- `[CONFIG] Native LSP status after discovery: ...`: LSP server configuration discovered for the session.
- `[CONFIG] Native LSP status after startup: ...`: Server startup result, including ready/failed counts.
- `[STATUS] LSP status snapshot for /status: ...`: Status snapshot printed when running `/status` in debug mode.

You can also run `/status` in the CLI to see a short LSP summary:

```text
LSP: disabled
LSP: enabled, 1/1 ready
LSP: enabled, 0/1 ready (1 failed)
LSP: enabled, no servers configured
LSP: enabled, status unavailable
```

For per-server details, run `/lsp`:

```text
**LSP Server Status**

| Server | Command | Languages | Status |
|--------|---------|-----------|--------|
| clangd | `clangd` | cpp | READY |
| pyright-langserver | `pyright-langserver` | python | FAILED - startup failed |
```

Common error messages to look for:

```text
command path is unsafe        -> relative path escapes workspace, use absolute path or add to PATH
command not found             -> server binary not installed or not in PATH
requires trusted workspace    -> use /trust when folder trust is enabled, or trust the workspace in your IDE
LSP connection closed         -> server started but exited or closed stdio before replying to initialize
```

For clangd startup failures, verify the server directly from the project root:

```bash
clangd --version
clangd --check=/path/to/file.cpp --log=verbose
```

C/C++ projects should usually provide a `compile_commands.json` or `compile_flags.txt`. If the compile database is in a build directory, pass it to clangd:

```json
{
  "cpp": {
    "command": "clangd",
    "args": ["--background-index", "--compile-commands-dir=build"]
  }
}
```

```bash
ps aux | grep clangd   # or typescript-language-server, jdtls, etc.
```

## Extension LSP Configuration

Extensions can provide LSP server configurations through the `lspServers` field in their `plugin.json`. This can be either an inline object or a path to a `.lsp.json` file. Qwen Code loads these configs when the extension is enabled. The format is the same language-keyed layout used in project `.lsp.json` files.

## Best Practices

1. **Install language servers globally**: This ensures they're available in all projects
2. **Use project-specific settings**: Configure server options per project when needed via `.lsp.json`
3. **Keep servers updated**: Update your language servers regularly for best results
4. **Trust wisely**: Only trust workspaces from trusted sources

## FAQ

### Q: How do I enable LSP?

Use the `--experimental-lsp` flag when starting Qwen Code:

```bash
qwen --experimental-lsp
```

### Q: How do I know which language servers are running?

Start Qwen Code with LSP and debug mode enabled:

```bash
qwen --experimental-lsp --debug
```

Then run `/status` for a short summary, `/lsp` for per-server status, or inspect the debug log:

```bash
# Default runtime directory
rg "LSP|Native LSP|<server-name>" ~/.qwen/debug/latest
# Or:
grep -E "LSP|Native LSP|<server-name>" ~/.qwen/debug/latest

# If QWEN_RUNTIME_DIR is configured
rg "LSP|Native LSP|<server-name>" "$QWEN_RUNTIME_DIR/debug/latest"
```

LSP uses Qwen Code's normal `--debug` mode; there is no separate LSP debug flag.

### Q: Can I use multiple language servers for the same file type?

Yes. Most document and navigation operations try ready servers sequentially
and return the first non-empty result. This includes definitions, references,
hover, document symbols, implementations, call hierarchy, and code actions.
Workspace symbols, file diagnostics, and workspace diagnostics instead
aggregate results from all ready servers. Every operation except
`workspaceSymbol` accepts `serverName` to target one server. The value must
exactly match the registered name shown by `/lsp`: the `command` value when one
is configured, otherwise the language key. A name that matches no ready server
returns an empty result rather than an error. `workspaceSymbol` always searches
all ready servers.

### Q: Does LSP work in sandbox mode?

Yes, subject to the sandbox environment. Qwen Code starts `stdio` language
servers as child processes of the current CLI process, so when the CLI runs in
a sandbox the server binary and its dependencies must also be available there.
For `tcp` and `socket` transports without `command`, Qwen Code connects to an
externally managed server, which must be reachable from the sandbox. When those
transports specify `command`, Qwen Code starts that process first, so its binary
and dependencies must also be available inside the sandbox. Workspace trust
controls still apply.
