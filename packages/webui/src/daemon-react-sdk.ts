/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@qwen-code/webui/daemon-react-sdk`
 *
 * React bindings for the Qwen Code daemon process.
 * Provides context Providers, hooks, types, and constants
 * for building UIs that connect to and interact with the daemon.
 *
 * @example
 * ```tsx
 * import {
 *   DaemonSessionProvider,
 *   DaemonWorkspaceProvider,
 *   useMessages,
 *   useConnection,
 *   useStreamingState,
 *   type DaemonMessage,
 * } from '@qwen-code/webui/daemon-react-sdk';
 * ```
 */

// ── Providers ─────────────────────────────────────────────────────

/**
 * Wraps children with session-level daemon context.
 * Manages a single conversation session: transcript, streaming state,
 * prompt submission, and permission handling.
 */
export { DaemonSessionProvider } from './daemon/index.js';

/**
 * Wraps children with workspace-level daemon context.
 * Provides access to cross-session resources: tools, skills, MCP servers,
 * memory, agents, and file system operations.
 */
export { DaemonWorkspaceProvider } from './daemon/index.js';

// ── Core Hooks ────────────────────────────────────────────────────

/** Send prompts, cancel requests, and submit permission responses. */
export { useDaemonActions as useActions } from './daemon/index.js';

/** Connection status, capabilities, and model info. */
export { useDaemonConnection as useConnection } from './daemon/index.js';

/** Pre-converted message list (user, assistant, tool groups, plans). */
export { useDaemonMessages as useMessages } from './daemon/index.js';

/** Current session metadata (id, model, approval mode). */
export { useDaemonSession as useSession } from './daemon/index.js';

/** Streaming state: `'idle' | 'thinking' | 'responding'`. */
export { useDaemonStreamingState as useStreamingState } from './daemon/index.js';

// ── Permission Hooks ──────────────────────────────────────────────

/** The single pending permission request awaiting user response (or null). */
export { useDaemonPendingPermissionRequest as usePendingPermissionRequest } from './daemon/index.js';

/** All unresolved permission requests in the current transcript. */
export { useDaemonPendingPermissions as usePendingPermissions } from './daemon/index.js';

// ── Todo Hooks ────────────────────────────────────────────────────

/** The currently active (most relevant) todo list. */
export { useDaemonActiveTodoList as useActiveTodoList } from './daemon/index.js';

/** The most recently updated todo list. */
export { useDaemonLatestTodoList as useLatestTodoList } from './daemon/index.js';

/** All todo lists extracted from the transcript. */
export { useDaemonTodoLists as useTodoLists } from './daemon/index.js';

// ── Resource Hooks ────────────────────────────────────────────────

/** List and inspect configured agents. */
export { useDaemonAgents as useAgents } from './daemon/index.js';

/** Authentication state for the daemon connection. */
export { useDaemonAuth as useAuth } from './daemon/index.js';

/** Language diagnostics (errors, warnings) from the workspace. */
export { useDaemonDiagnostics as useDiagnostics } from './daemon/index.js';

/** Workspace file operations: glob, read, write, edit, stat, listDirectory. */
export { useDaemonFiles as useFiles } from './daemon/index.js';

/** Run glob queries against the workspace file system. */
export { useDaemonGlob as useGlob } from './daemon/index.js';

/** MCP server status, tools, and management operations. */
export { useDaemonMcp as useMcp } from './daemon/index.js';

/** Memory files (CLAUDE.md etc.) stored in the workspace. */
export { useDaemonMemory as useMemory } from './daemon/index.js';

/** Generic SWR-style resource fetcher for daemon REST endpoints. */
export { useDaemonResource as useResource } from './daemon/index.js';

/**
 * List daemon sessions (workspace-level). Switch/new/release actions require
 * a nested `DaemonSessionProvider` — they are `undefined` without one.
 */
export { useDaemonSessions as useSessions } from './daemon/index.js';

/** Available slash-command skills. */
export { useDaemonSkills as useSkills } from './daemon/index.js';

/** Registered tools and their configuration. */
export { useDaemonTools as useTools } from './daemon/index.js';

// ── Workspace Hooks ───────────────────────────────────────────────

/** Workspace context value (file ops, directory listing). */
export { useDaemonWorkspace as useWorkspace } from './daemon/index.js';

/** Workspace-level actions (create session, switch model, etc.). */
export { useDaemonWorkspaceActions as useWorkspaceActions } from './daemon/index.js';

/** Like `useWorkspace()` but returns null when outside a WorkspaceProvider. */
export { useOptionalDaemonWorkspace as useOptionalWorkspace } from './daemon/index.js';

// ── Transcript Hooks (low-level) ──────────────────────────────────

/** Raw transcript blocks from the SSE stream. For custom message conversion. */
export { useDaemonTranscriptBlocks as useTranscriptBlocks } from './daemon/session/index.js';

/** Full transcript state including block index and progress tracking. */
export { useDaemonTranscriptState as useTranscriptState } from './daemon/session/index.js';

/** Direct access to the transcript store (subscribe, getSnapshot). */
export { useDaemonTranscriptStore as useTranscriptStore } from './daemon/session/index.js';

/** Low-level prompt lifecycle status (queued, streaming, idle). */
export { useDaemonPromptStatus as usePromptStatus } from './daemon/session/index.js';

// ── Constants ─────────────────────────────────────────────────────

/** Ordered list of approval modes for cycling: `['auto', 'suggest', 'ask']`. */
export { DAEMON_APPROVAL_MODES } from './daemon/index.js';

// ── Types: Connection & Session ───────────────────────────────────

export type {
  /** Full connection state: status, session id, models, context, capabilities. */
  DaemonConnectionState,
  /** Connection lifecycle: `'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'`. */
  DaemonConnectionStatus,
  /** Model descriptor: id, display label, context window size. */
  DaemonModelInfo,
  /** Slash-command descriptor with name, description, and argument hint. */
  DaemonCommandInfo,
  /** All session-level actions: prompt, cancel, permission, model, session management. */
  DaemonSessionActions,
  /** Internal session context value (store + connection + actions). */
  DaemonSessionContextValue,
  /** Props accepted by `<DaemonSessionProvider>`. */
  DaemonSessionProviderProps,
  /** Streaming lifecycle: `'idle' | 'waiting' | 'responding' | 'thinking'`. */
  DaemonStreamingState,
  /** Prompt submission status: `'idle' | 'waiting' | 'streaming'`. */
  DaemonPromptStatus,
  /** Image attachment (base64 data + MIME type) for prompt submission. */
  DaemonPromptImage,
  /** Permission approval level: `'plan' | 'default' | 'auto-edit' | 'auto' | 'yolo'`. */
  DaemonApprovalMode,
  DaemonContextCategoryBreakdown,
  DaemonContextMemoryDetail,
  DaemonContextSkillDetail,
  DaemonContextToolDetail,
  DaemonSessionContextUsage,
  DaemonSessionContextUsageStatus,
  /** Options for `sendPrompt()`: optimistic message, image attachments. */
  SendPromptOptions,
} from './daemon/index.js';

// ── Types: Messages ──────────────────────────────────────────────

export type {
  /** Union of all converted message types shown in the chat UI. */
  DaemonMessage,
  /** Assistant (model) response message. */
  DaemonAssistantMessage,
  /** User prompt message. */
  DaemonUserMessage,
  /** System status/error/debug message. */
  DaemonSystemMessage,
  /** Plan-mode confirmation message shown during `plan` approval. */
  DaemonPlanMessage,
  /** Grouped tool invocations rendered together in the UI. */
  DaemonToolGroupMessage,
} from './daemon/index.js';

// ── Types: Tool Calls ────────────────────────────────────────────

export type {
  /** Single tool call within a tool group: name, status, preview, content. */
  DaemonMessageToolCall,
  /** Tool call output content (text, error, structured data). */
  DaemonMessageToolCallContent,
  /** Tool execution status: `'running' | 'completed' | 'error'` etc. */
  DaemonMessageToolCallStatus,
  /** Tool category: `'bash' | 'file_read' | 'file_write' | 'mcp'` etc. */
  DaemonMessageToolKind,
  /** File location reference within a tool result. */
  DaemonMessageToolCallLocation,
  /** Todo item within a tool-managed task list. */
  DaemonMessageTodoItem,
} from './daemon/index.js';

// ── Types: Permissions ───────────────────────────────────────────

export type {
  /** Pending permission request with title, options, and raw block. */
  DaemonPendingPermissionRequest,
  /** Option kind: `'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'`. */
  DaemonPermissionOptionKind,
  /** Single selectable option within a permission request. */
  DaemonPermissionRequestOption,
} from './daemon/index.js';

// ── Types: Todos ─────────────────────────────────────────────────

export type {
  /** Single item in a todo list: id, content, status, priority. */
  DaemonTodoItem,
  /** Complete todo list: title, items, associated tool call block. */
  DaemonTodoList,
  /** Todo priority level: `'low' | 'medium' | 'high'`. */
  DaemonTodoPriority,
  /** Todo item status: `'pending' | 'in_progress' | 'completed'`. */
  DaemonTodoStatus,
} from './daemon/index.js';

// ── Types: Workspace ─────────────────────────────────────────────

export type {
  /** All workspace-level actions: MCP, tools, memory, agents, files, auth. */
  DaemonWorkspaceActions,
  /** Internal workspace context value (client + actions + status + error). */
  DaemonWorkspaceContextValue,
  /** Props accepted by `<DaemonWorkspaceProvider>`. */
  DaemonWorkspaceProviderProps,
  /** Workspace connection lifecycle: `'idle' | 'connecting' | 'connected' | 'error'`. */
  DaemonWorkspaceStatus,
  /** Options for resource hooks: `{ autoLoad?, enabled? }`. */
  DaemonResourceOptions,
  /** Resource fetch result: `{ data, loading, error, reload() }`. */
  ResourceResult,
  /** Resource state snapshot: `{ data, loading, error }`. */
  ResourceState,
} from './daemon/index.js';

// ── Types: Filesystem & Glob ─────────────────────────────────────

export type {
  /** Single entry in a directory listing: name, kind, ignored status. */
  DaemonDirectoryEntry,
  /** Full directory listing: path, entries array, truncation flag. */
  DaemonDirectoryListing,
  /** File metadata: path, type, size, modification time. */
  DaemonFileStat,
  /** Options for glob queries: maxResults, includeIgnored, cwd. */
  DaemonGlobOptions,
  /** Glob match result containing matched file paths. */
  DaemonGlobResult,
  /** Memory file scope: `'workspace' | 'global'`. */
  DaemonContextFileScope,
} from './daemon/index.js';

// ── Types: Sessions, Agents, Tools, MCP, Memory ──────────────────

export type {
  /** Session list entry: id, title, timestamps, client count, active prompt flag. */
  DaemonSessionSummary,
  /** Full agent detail including system prompt, tools, and run config. */
  DaemonWorkspaceAgentDetail,
  /** Agent list entry: name, description, level, model, builtin flag. */
  DaemonWorkspaceAgentSummary,
  /** MCP server status: name, transport, connection state, disabled reason. */
  DaemonWorkspaceMcpServerStatus,
  /** Single MCP tool: name, description, JSON schema, validity. */
  DaemonWorkspaceMcpToolStatus,
  /** All tools from a single MCP server. */
  DaemonWorkspaceMcpToolsStatus,
  /** Memory file entry: path, scope, byte size. */
  DaemonWorkspaceMemoryFile,
  /** Skill status: name, description, level, model-invocable flag. */
  DaemonWorkspaceSkillStatus,
  /** Registered tool: name, displayName, description, enabled flag. */
  DaemonWorkspaceToolStatus,
} from './daemon/index.js';

// ── Types: SDK Transcript Blocks (low-level) ─────────────────────

export type {
  /** Shell output block: stdout/stderr text stream. */
  DaemonShellTranscriptBlock,
  /** Status/error/debug informational block. */
  DaemonStatusTranscriptBlock,
  /** User, assistant, or thought text block (may be streaming). */
  DaemonTextTranscriptBlock,
  /** Tool invocation block with preview, content, locations. */
  DaemonToolTranscriptBlock,
  /** Discriminated union of all transcript block types. */
  DaemonTranscriptBlock,
  /** Block kind tag: `'user' | 'assistant' | 'thought' | 'tool' | 'shell' | 'permission' | 'status' | 'error' | 'debug'`. */
  DaemonTranscriptBlockKind,
  /** Interactive question block (ask_user_question tool preview). */
  DaemonTranscriptQuestion,
  /** Single option within a transcript question. */
  DaemonTranscriptQuestionOption,
  /** Configuration for the transcript reducer: maxBlocks, initial timestamp. */
  DaemonTranscriptReducerOptions,
  /** Non-chat side state: current tool call, approval mode, progress, resync. */
  DaemonTranscriptSidechannelState,
  /** Full transcript snapshot: blocks array, indexes, active IDs, sidechannel. */
  DaemonTranscriptState,
  /** External store interface: getSnapshot, subscribe, dispatch, reset. */
  DaemonTranscriptStore,
} from '@qwen-code/sdk/daemon';
