# Hot Reload Overall Plan

This directory tracks the design work for issue
[#3696](https://github.com/QwenLM/qwen-code/issues/3696): a comprehensive
hot-reload system for skills, extensions, MCP servers, LSP servers, and runtime
configuration.

## Goal

Users should be able to update skills, extension state, MCP/LSP configuration,
and supported settings without restarting the current Qwen Code session. The
system should preserve conversation context while making runtime state changes
predictable and visible.

## Sub-task Breakdown

The hot-reload plan has **6 top-level sub-tasks**. The current tracking issue
splits sub-task 3 into **3a** and **3b** for implementation clarity, so the
execution checklist contains **7 entries**.

| Task | Scope                                    | Status                   | Design document                                                      |
| ---- | ---------------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| 1    | Settings file change detection           | Done in #4933            | [settings-change-detection.md](./settings-change-detection.md)       |
| 2    | Skill hot-reload improvements            | Done via #2415 and #3923 | Not in this directory                                                |
| 3a   | MCP server runtime re-initialization     | In progress via #5561    | [mcp-runtime-reinitialization.md](./mcp-runtime-reinitialization.md) |
| 3b   | LSP server runtime re-initialization     | In progress              | [lsp-runtime-reinitialization.md](./lsp-runtime-reinitialization.md) |
| 4    | Unified refresh/cache orchestration      | Not started              | Pending                                                              |
| 5    | User-facing `/reload` slash command      | Not started              | Pending                                                              |
| 6    | `needsRefresh` app-state/UI notification | Not started              | Pending                                                              |

## Document Mapping

- `settings-change-detection.md` corresponds to **sub-task 1: Settings file
  change detection**. It provides the watcher infrastructure: detect supported
  `settings.json` changes, reload settings from disk, and notify listeners. It
  intentionally does not push updated values into `Config` snapshots or restart
  runtime subsystems.
- `mcp-runtime-reinitialization.md` corresponds to **sub-task 3a: MCP server
  runtime re-initialization**. It consumes settings change events, updates the
  runtime MCP configuration, and incrementally reconciles live MCP connections.
  The original issue grouped MCP and LSP under top-level sub-task 3; this
  document covers the MCP half only.
- `lsp-runtime-reinitialization.md` corresponds to **sub-task 3b: LSP server
  runtime re-initialization**. It watches workspace `.lsp.json` changes,
  reuses the existing native LSP client, and incrementally reconciles live LSP
  servers.

## Implementation Order

1. Keep sub-task 1 as the foundation: settings changes are detected and
   dispatched, but consumers decide what to refresh.
2. Complete sub-task 3a so MCP server additions, removals, and configuration
   edits can take effect at runtime.
3. Add sub-task 3b for LSP runtime re-initialization using the same principle:
   update runtime configuration, stop affected servers, and restart only what
   changed.
4. Introduce sub-task 4 as the shared orchestration layer for cache and runtime
   refreshes across skills, commands, prompts, extensions, MCP, and LSP.
5. Add sub-task 5 as the manual user entry point: `/reload` should call the
   unified orchestration path and report what changed.
6. Add sub-task 6 for background-change UX: set `needsRefresh` when a detected
   change cannot or should not be fully applied automatically, then prompt the
   user to run `/reload`.

## Design Principle

Keep each layer narrow:

- file watching detects and reports settings changes;
- subsystem reinitialization updates only the affected runtime state;
- unified orchestration sequences existing refresh operations;
- UI commands and notifications expose the behavior without duplicating reload
  logic.
