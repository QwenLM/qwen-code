# @qwen-code/node-repl-mcp

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes a **session-persistent Node.js REPL** as three MCP tools. It runs a real
Node.js kernel in a dedicated child process; top-level bindings, closures, and
module state persist across calls within a session.

This package is **fully independent of `@qwen-code/qwen-code-core`** — any MCP
client (Qwen Code via `mcpServers`, Claude, Codex, etc.) can run it.

## Tools

| Tool                            | Description                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `node_repl`                     | Execute JavaScript. `{ code, timeout_ms?, title? }`. Bindings persist across calls; top-level `await` supported. |
| `node_repl_reset`               | Terminate the kernel process and discard all bindings/module state.                                              |
| `node_repl_add_node_module_dir` | Register an extra `node_modules` directory for bare-package resolution.                                          |

### Cell semantics

- Explicit output only: `nodeRepl.write(value)` for text, `nodeRepl.emitImage(png|jpeg|webp)`
  for images; `console.*` is captured. Plain expression results are not returned.
- `nodeRepl.cwd` / `homeDir` / `tmpDir` and `nodeRepl.getHeapStatus()` are available.
- Top-level static `import` is not allowed — use dynamic `await import()`.
- Bare packages resolve from the session `cwd` `node_modules` plus any directory
  registered via `node_repl_add_node_module_dir`; package entrypoints use Node
  singleton caching. Local `.js`/`.mjs` reload on each execution.
- Node builtins are importable except `process`/`node:process`. Use
  `(await import('node:module')).createRequire(import.meta.url)` for CommonJS or
  native (N-API) addons.
- Timeout, cancellation, `node_repl_reset`, or a crash replaces the kernel process
  and discards all bindings.

> Isolation note: the VM context provides lifecycle/namespace isolation, **not** an
> OS security sandbox. Imported packages and builtins run with ordinary Node.js
> authority and inherit the parent environment. Grant this server only in trusted
> contexts.

## Usage

Once published, the packaged `bin` is the simplest entry point:

```jsonc
// qwen-code settings.json (or any MCP client)
{
  "mcpServers": {
    "node-repl": {
      "command": "npx",
      "args": ["-y", "@qwen-code/node-repl-mcp"],
      "cwd": "/your/workspace",
      "env": { "QWEN_NODE_REPL_ROOTS": "/extra/node_modules/parent" },
    },
  },
}
```

For local development against a build in this repo, point at `dist/index.js`:

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
- `QWEN_NODE_REPL_DEBUG` — set truthy for stderr debug logging.

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
