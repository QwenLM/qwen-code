# Speculation Engine Design

> Speculatively executes the accepted suggestion before the user confirms, using copy-on-write file isolation. Results appear instantly when the user presses Tab.

## Overview

When a prompt suggestion is shown, the **speculation engine** immediately starts executing it in the background using a forked GeminiChat. File writes go to a temporary overlay directory. If the user accepts the suggestion, overlay files are copied to the real filesystem and the speculated conversation is injected into the main chat history. If the user types something else, the speculation is aborted and the overlay is cleaned up.

## Architecture

```
User sees suggestion "commit this"
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│  startSpeculation()                                          │
│                                                              │
│  ┌─────────────────┐    ┌────────────────────┐               │
│  │ Forked GeminiChat│    │  OverlayFs          │              │
│  │ (cache-shared)   │    │  /tmp/qwen-         │              │
│  │                  │    │   speculation/       │              │
│  │  systemInstruction│   │   {pid}/{id}/        │              │
│  │  + tools          │   │                      │              │
│  │  + history prefix │   │  COW: first write    │              │
│  │                  │    │  copies original     │              │
│  └────────┬─────────┘    └──────────┬───────────┘             │
│           │                         │                         │
│           ▼                         │                         │
│  ┌──────────────────────────────────┴──────────────────────┐  │
│  │  Speculative Loop (max 20 turns, 100 messages)          │  │
│  │                                                         │  │
│  │  Model response                                         │  │
│  │       │                                                 │  │
│  │       ▼                                                 │  │
│  │  ┌──────────────────────────────────────────────────┐   │  │
│  │  │  speculationToolGate                             │   │  │
│  │  │                                                  │   │  │
│  │  │  Read/Grep/Glob/LS/LSP → allow (+ overlay read) │   │  │
│  │  │  Edit/WriteFile → redirect to overlay            │   │  │
│  │  │    (only in auto-edit/yolo mode)                 │   │  │
│  │  │  Shell → AST check read-only? allow : boundary   │   │  │
│  │  │  WebFetch/WebSearch → boundary                   │   │  │
│  │  │  Agent/Skill/Memory/Ask → boundary               │   │  │
│  │  │  Unknown/MCP → boundary                          │   │  │
│  │  └──────────────────────────────────────────────────┘   │  │
│  │       │                                                 │  │
│  │       ▼                                                 │  │
│  │  Tool execution: toolRegistry.getTool → build → execute │  │
│  │  (bypasses CoreToolScheduler — gated by toolGate)       │  │
│  │                                                         │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                              │
│  On completion → generatePipelinedSuggestion()               │
└──────────────────────────────────────────────────────────────┘
           │
           │  User presses Tab / Enter
           ▼
┌──────────────────────────────────────────────────────────────┐
│  acceptSpeculation()                                         │
│                                                              │
│  1. overlayFs.applyToReal() — copy files to real FS          │
│  2. ensureToolResultPairing() — strip unpaired functionCalls │
│  3. geminiClient.addHistory() — inject messages              │
│  4. historyManager.addItem() — render in UI                  │
│  5. overlayFs.cleanup() — delete temp directory              │
│  6. Promote pipelined suggestion                             │
└──────────────────────────────────────────────────────────────┘
           │
           │  User types instead
           ▼
┌──────────────────────────────────────────────────────────────┐
│  abortSpeculation()                                          │
│                                                              │
│  1. abortController.abort() — cancel LLM call               │
│  2. overlayFs.cleanup() — delete temp directory              │
│  3. Log SpeculationEvent                                     │
└──────────────────────────────────────────────────────────────┘
```

## Copy-on-Write Overlay

```
Real CWD: /home/user/project/
Overlay:  /tmp/qwen-speculation/12345/a1b2c3d4/

Write to src/app.ts:
  1. Copy /home/user/project/src/app.ts → overlay/src/app.ts (first time only)
  2. Tool writes to overlay/src/app.ts

Read from src/app.ts:
  - If in writtenFiles → read from overlay/src/app.ts
  - Otherwise → read from /home/user/project/src/app.ts

New file (src/new.ts):
  - Create overlay/src/new.ts directly (no original to copy)

Accept:
  - copyFile(overlay/src/app.ts → /home/user/project/src/app.ts)
  - copyFile(overlay/src/new.ts → /home/user/project/src/new.ts)
  - rm -rf overlay/

Abort:
  - rm -rf overlay/
```

## Tool Gate Security

| Tool                           | Action   | Condition                                    |
| ------------------------------ | -------- | -------------------------------------------- |
| read_file, grep, glob, ls, lsp | allow    | Read paths resolved through overlay          |
| edit, write_file               | redirect | Only in auto-edit / yolo approval mode       |
| edit, write_file               | boundary | In default / plan approval mode              |
| shell                          | allow    | `isShellCommandReadOnlyAST()` returns true   |
| shell                          | boundary | Non-read-only commands                       |
| web_fetch, web_search          | boundary | Network requests require user consent        |
| agent, skill, memory, ask_user | boundary | Cannot interact with user during speculation |
| Unknown / MCP tools            | boundary | Safe default                                 |

### Path Rewrite

- **Write tools**: `rewritePathArgs()` redirects `file_path` to overlay via `overlayFs.redirectWrite()`
- **Read tools**: `resolveReadPaths()` redirects `file_path` to overlay via `overlayFs.resolveReadPath()` if previously written
- **Rewrite failure**: Treated as boundary (e.g., absolute path outside cwd throws in `redirectWrite`)

## Boundary Handling

When a boundary is hit mid-turn:

1. Already-executed tool calls are preserved (index-based tracking, not name-based)
2. Unexecuted function calls are stripped from the model message
3. Partial tool responses are added to history
4. `ensureToolResultPairing()` validates completeness before injection

## Pipelined Suggestion

After speculation completes (no boundary), a second LLM call generates the **next** suggestion:

```
Context: original conversation + "commit this" + speculated messages
→ LLM predicts: "push it"
→ Stored in state.pipelinedSuggestion
→ On accept: setPromptSuggestion("push it") — appears instantly
```

This enables Tab-Tab-Tab workflows where each acceptance immediately shows the next step.

## Forked Query (Cache Sharing)

### CacheSafeParams

```typescript
interface CacheSafeParams {
  generationConfig: GenerateContentConfig; // systemInstruction + tools
  history: Content[]; // curated, max 40 entries
  model: string;
  version: number; // increments on config changes
}
```

- Saved after each successful main turn in `GeminiClient.sendMessageStream()`
- Cleared on `startChat()` / `resetChat()` to prevent cross-session leakage
- History truncated to 40 entries before deep clone to reduce overhead
- Version detection via `JSON.stringify` comparison of systemInstruction + tools

### Cache Mechanism

DashScope already enables prefix caching via:

- `X-DashScope-CacheControl: enable` header
- `cache_control: { type: 'ephemeral' }` annotations on messages and tools

The forked `GeminiChat` uses identical `generationConfig` (including tools) and history prefix, so DashScope's existing cache mechanism produces cache hits automatically.

## Constants

| Constant                 | Value | Description                              |
| ------------------------ | ----- | ---------------------------------------- |
| MAX_SPECULATION_TURNS    | 20    | Maximum API round-trips                  |
| MAX_SPECULATION_MESSAGES | 100   | Maximum messages in speculated history   |
| SUGGESTION_DELAY_MS      | 300   | Delay before showing suggestion          |
| ACCEPT_DEBOUNCE_MS       | 100   | Debounce lock for rapid accepts          |
| MAX_HISTORY_FOR_CACHE    | 40    | History entries saved in CacheSafeParams |

## File Structure

```
packages/core/src/followup/
├── followupState.ts          # Framework-agnostic state controller
├── suggestionGenerator.ts    # LLM-based suggestion generation + 14 filter rules
├── forkedQuery.ts            # Cache-aware forked query infrastructure
├── overlayFs.ts              # Copy-on-write overlay filesystem
├── speculationToolGate.ts    # Tool boundary enforcement
├── speculation.ts            # Speculation engine (start/accept/abort)
└── index.ts                  # Module exports
```
