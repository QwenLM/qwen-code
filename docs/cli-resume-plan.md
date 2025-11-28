# CLI Resume Based on Auto-Saved Sessions

## Goals

- Use the auto-saved chat recording as the single source of truth.
- Provide `--continue` (resume newest session) and `--resume <sessionId>` flags.
- Remove the need for manual `/chat save|resume|delete|list` checkpoints to avoid confusion.
- **Design for future checkpointing**: Enable users to branch from any historical message without breaking append-only semantics.

## Scope

- Core session management (listing, loading, resuming).
- Client startup wiring (GeminiClient/GeminiChat) with resume data.
- CLI flag parsing and UX.
- Slash command cleanup (retain export/share only).
- Tests and docs.

## JSONL Record Format (Tree-Structured)

### Design Rationale

A plain sequential list cannot support checkpointing (resuming from an arbitrary historical point). To enable future checkpointing while maintaining append-only writes, each record includes `uuid` and `parentUuid` fields, forming a **tree structure** within a flat JSONL file.

### Immediate Write Model

Every event (thought, token usage, message, tool call) is written immediately as a separate record. Records belonging to the same logical message share the same `uuid` and are **aggregated during read**. This ensures:

- Maximum crash-safety (no buffering/queuing)
- Simpler write logic
- Each write is atomic

Example of a single assistant message split across multiple records:

```json
{"uuid": "a1", "parentUuid": "u1", "type": "assistant", "thoughts": [...]}
{"uuid": "a1", "parentUuid": "u1", "type": "assistant", "tokens": {...}}
{"uuid": "a1", "parentUuid": "u1", "type": "assistant", "message": "Hi!", "model": "..."}
```

All three records share `uuid: "a1"` and are merged into one message during read.

### Record Schema

Every line in the JSONL file is a self-contained record:

```json
{
  "uuid": "b1a2eff4-8c56-4ff4-b7ad-0e85ef2c35f1",
  "parentUuid": "06e2c1f0-3044-481f-81c2-b0dc0bb68a9f",
  "sessionId": "6b0b0776-e08e-426e-bff4-91f7fbcd1892",
  "timestamp": "2025-11-25T08:55:15.926Z",
  "type": "user | assistant | tool_result",
  "cwd": "/Users/andy/workspace/projects/qwen-code",
  "version": "2.0.43",
  "gitBranch": "feat/session-management",
  "message": { "role": "user|model", "parts": [...] },
  "tokens": { "input": 100, "output": 50, ... },
  "model": "model-name",
  "toolCallsMetadata": [{ /* UI enrichment data */ }]
}
```

| Field               | Required | Description                                               |
| ------------------- | -------- | --------------------------------------------------------- |
| `uuid`              | ✓        | Identifier for this logical message (shared by all parts) |
| `parentUuid`        | ✓        | UUID of the parent message; `null` for root               |
| `sessionId`         | ✓        | Groups records into a logical session                     |
| `timestamp`         | ✓        | ISO 8601 timestamp of when the record was created         |
| `type`              | ✓        | `"user"`, `"assistant"`, or `"tool_result"`               |
| `cwd`               | ✓        | Working directory at time of message                      |
| `version`           | ✓        | CLI version for compatibility tracking                    |
| `gitBranch`         |          | Current git branch, if available                          |
| `message`           |          | Raw `Content` object (role + parts) as used with API      |
| `tokens`            |          | Token usage statistics                                    |
| `model`             |          | Model used for this response                              |
| `toolCallsMetadata` |          | Enriched tool call info for UI recovery                   |

### Message Field

The `message` field stores the raw `Content` object exactly as used with the API:

- **User messages**: `{ "role": "user", "parts": [{ "text": "..." }, ...] }`
- **Assistant messages**: `{ "role": "model", "parts": [{ "text": "..." }, { "functionCall": {...} }, { "thought": true, "text": "..." }] }`
- **Tool results**: `{ "role": "user", "parts": [{ "functionResponse": {...} }] }`

This enables **direct aggregation** of `message` fields into `Content[]` for session resumption without any post-processing.

### Record Types

- **`user`**: Regular user input (text, files, images, etc.)
- **`assistant`**: Model response - message contains all parts (text, thoughts, functionCalls)
- **`tool_result`**: Function responses sent back to the model

### toolCallsMetadata

The `toolCallsMetadata` field stores enriched tool call information for UI recovery:

- `id`: Tool call ID
- `name`: Tool name
- `args`: Tool arguments
- `result`: Raw tool execution result (responseParts)
- `status`: Execution status (success, error, cancelled)
- `timestamp`: When the tool was executed
- `displayName`: Human-readable tool name (enriched)
- `description`: Tool description (enriched)
- `resultDisplay`: UI display string from `ToolCallResponseInfo.resultDisplay`
- `renderOutputAsMarkdown`: Display hint

This data is NOT part of the API Content but is needed to reconstruct the UI state.

**Aggregation Rule:** When reading, records with the same `uuid` are merged:

- `message`: merge `parts` arrays from all Content objects
- `model`: take first non-empty value
- `tokens`: take the latest value
- `toolCallsMetadata`: concatenate arrays
- `timestamp`: use the latest for the aggregated message

### Tree Reconstruction

**Linear history** (current default): Follow `parentUuid` chain from the latest record back to root (`parentUuid: null`).

```
[uuid:A, parentUuid:null] ← root
[uuid:B, parentUuid:A]
[uuid:C, parentUuid:B]
[uuid:D, parentUuid:C]    ← current head
```

**Branched history** (future checkpointing): Multiple records can share the same `parentUuid`, creating branches.

```
[uuid:A, parentUuid:null] ← root
[uuid:B, parentUuid:A]
[uuid:C, parentUuid:B]    ← original branch continues
[uuid:D, parentUuid:C]
[uuid:E, parentUuid:B]    ← checkpoint: new branch from B
[uuid:F, parentUuid:E]    ← new branch continues
```

To reconstruct a conversation path:

1. Start from any leaf record
2. Follow `parentUuid` links until reaching `null`
3. Reverse the collected records to get chronological order

### Benefits

- **Append-only**: All writes are appends; never rewrite the file
- **Crash-safe**: Partial writes only lose the incomplete record
- **Checkpointing-ready**: Branch from any historical point by referencing its `uuid`
- **Single file per session**: No need for multiple files or complex directory structures
- **Self-contained records**: Each line has full context for debugging/analysis

## Work Items

### 1) Session Store Enhancements (core) ✅ Done

- Moved session management to `packages/core/src/services/sessionService.ts`:
  - `listSessions()` → scan `.../chats`, parse records to extract metadata (sessionId, startTime, lastUpdated, message count, filePath), sort by `lastUpdated` desc.
  - `loadSession(sessionId)` → find and parse a session by id, reconstruct linear history, return `ResumedSessionData | null`.
  - `loadLastSession()` → convenience wrapper returning the newest session.
  - `removeSession(sessionId)` → delete a session file.
  - `sessionExists(sessionId)` → check if a session exists.
- `ChatRecordingService.initialize(resumedSessionData)` appends to existing file with correct `parentUuid` linking.

### 2) Client Resume Support (core) ✅ Done

- Extended `GeminiClient.initialize()` to check for resumed session data in Config.
- Created `packages/core/src/services/sessionResumeUtils.ts` with:
  - `convertToApiHistory()` → converts ChatRecords to `Content[]` for API history
  - `convertToUiHistory()` → converts ChatRecords to UI history items for display
  - `createResumeInfoMessage()` → generates info message about resumed session
  - `prepareSessionResume()` → convenience wrapper returning all resume data
- If resumed session exists, pass reconstructed `Content[]` history to `startChat()`.

### 3) CLI Flags (cli) ✅ Done

- Added `--continue` flag to resume the most recent session for the current project.
- Added `--resume <sessionId>` flag to resume a specific session by ID.
- Added validation: cannot use both flags together.
- In `loadCliConfig()`:
  - Check for `--continue` or `--resume` flags
  - Pass `resumedSessionData` to Config constructor
- Error handling: exit with error if specified session not found; warn if no sessions to resume.
- **Future**: Add `--checkpoint <messageUuid>` to resume from a specific message (creates a branch).

### 4) Slash Command Cleanup (cli) ✅ Done

- Removed `/chat save|resume|delete|list` to avoid dual mechanisms.

### 5) JSON ➜ JSONL Transition (core) ✅ Done

- Use JSONL as the sole storage format (no JSON fallback/migration).
- Update `ChatRecordingService` to write/read JSONL with tree-structured records.
- Each record is self-contained; no separate header line needed.
- Implemented tree reconstruction via `uuid`/`parentUuid` chain.
- Added git branch detection and CLI version tracking in each record.
- **Simplified API:**
  - `recordUserMessage(content: Content)` - Records a user message with raw Content
  - `recordAssistantTurn({ model, content, tokens, toolCallsMetadata })` - Records assistant turn with raw Content + metadata
  - `recordToolResult(content: Content, toolCallsMetadata?)` - Records tool results with raw Content
  - Helper: `toTokensSummary(usageMetadata)` - Converts API response to `UsageMetadata`
- **Recording Flow (Injectable Pattern):**
  - `ChatRecordingService` is created by `GeminiClient` and injected into both `GeminiChat` and `CoreToolScheduler`
  - **GeminiChat**: Records user messages and assistant turns when service is provided (null = skip recording)
  - **CoreToolScheduler**: Records tool results when service is provided (null = skip recording)
  - **Subagents**: Pass `null` for the recording service to skip recording (subagent conversations are not persisted)
  - This design ensures recording is an **explicit, caller-controlled decision** rather than an implicit side effect
- **Key Design Principle:** The `message` field stores raw `Content` objects (role + parts) exactly as used with the API. This enables direct aggregation into `Content[]` for session resumption without any transformation.

### 6) UI History Display ✅ Done

- Added resumed session history display in `AppContainer.tsx`:
  - After config initialization, check for resumed session data
  - Convert ChatRecords to HistoryItems using `convertToUiHistory()`
  - Display "Resumed session from..." info message
  - Load all previous user messages, assistant responses, and tool calls
- Tool calls displayed with proper status icons (Success/Error/Canceled).

### 7) Config Integration ✅ Done

- Added `resumedSessionData?: ResumedSessionData` to `ConfigParameters` interface.
- Added `resumedSessionData` field to `Config` class with getter `getResumedSessionData()`.
- Modified `getChatRecordingService()` to pass resumed session data to `initialize()`.

### 8) Tests (Pending)

- Unit tests for new `SessionService` listing/loading methods.
- Unit tests for `sessionResumeUtils` conversion functions.
- Core/client tests for starting with resume data (latest and by id).
- CLI tests for `--continue`/`--resume` paths and error handling.
- **Tree structure tests**:
  - Linear history reconstruction
  - (Future) Branched history reconstruction
  - Handling of orphaned records (missing parent)
  - Append-only integrity and truncated-line recovery

### 9) Docs/UX (Pending)

- Update README/help text to describe auto-save plus the new flags.
- Note deprecation/removal of manual `/chat` save/resume/delete/list.
- Document the JSONL format for power users who want to inspect/manipulate sessions.

## Project Scoping and Naming

- Sessions must be scoped to the current project only: `listSessions/loadSession/getLatestSession` should operate within the project-specific subdirectory.
- Folder naming: use a human-readable, sanitized path-based token (e.g., `-Users-andy-workspace-projects-qwen-code`), replacing the hash-based folder. We will treat this as a breaking change and will not maintain backward compatibility for legacy hash-based dirs or formats.

## Format Consideration: JSON ➜ JSONL

### Motivation

Current JSON recording rewrites the whole file on each update; JSONL allows append-only writes, better robustness, and simpler partial recovery.

### Approach

- **Tree-structured records**: Each line contains a complete record with `uuid`/`parentUuid` linking (see Record Schema above).
- **No header line**: Metadata is embedded in each record, enabling:
  - Quick listing by scanning first/last lines
  - Self-contained records for debugging
  - Simpler parsing logic
- **Writer behavior**: Append new records with correct `parentUuid`; sync/flush periodically; maintain in-memory cache of current branch for quick reads.
- **Reader behavior**: Parse all lines, build UUID→record index, reconstruct tree by following parent links.

### Migration Strategy

- This is a **breaking change**. We will not maintain backward compatibility for legacy JSON or hash-based directory formats.
- Old sessions in legacy format will not be readable; users should export important sessions before upgrading.

### Future: Checkpointing Support

With the tree structure in place, checkpointing becomes straightforward:

1. User selects a historical message by `uuid`
2. New messages use that `uuid` as their `parentUuid`
3. Both the original and new branches coexist in the same file
4. `--checkpoint <uuid>` flag reconstructs history from that point

This design requires no file format changes when checkpointing is implemented—only new CLI commands and UI to select checkpoint targets.

---

• TBD

- compression tool - P1 -- done
- Subagent execution, exclude tools - P1
- slash commands - P2 -- done
- test logs(--continue, --resume, new session, local & online) - P2
