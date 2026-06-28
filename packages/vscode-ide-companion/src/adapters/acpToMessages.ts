/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * acpToMessages — VSCode webview adapter (WS3).
 *
 * Converts the webview's in-memory, ACP-derived state (the text stream, the
 * tool-call map, plan entries, insight progress) into the shared
 * `@qwen-code/chat-panel` `Message[]` contract, so the webview can render
 * through `<ChatPanel>` just like web-shell does — each host maps its own data
 * onto the same contract.
 *
 * The webview's native render list (`App.tsx`'s `allMessages`) merges text and
 * individual tool calls by timestamp and renders plan / insight as separate
 * sections. `<ChatPanel>` instead expects a single `Message[]` where consecutive
 * tool calls are folded into `tool_group` rows (there is no single-tool variant)
 * and plan / insight are their own rows — so this adapter mirrors the timestamp
 * merge, groups consecutive tools, and appends the current plan / insight state.
 *
 * The function is pure and deterministic (ids derived from role/timestamp/index)
 * so it can be golden-tested in isolation.
 */
import type {
  Message,
  ACPToolCall,
  DaemonMessageTodoItem,
  DaemonMessageToolCallContent,
  DaemonMessageToolCallLocation,
  DaemonMessageToolCallStatus,
} from '@qwen-code/chat-panel';
import type { ToolCallData } from '@qwen-code/webui';
import type { TextMessage } from '../webview/hooks/message/useMessageHandling.js';
import type { PlanEntry } from '../types/chatTypes.js';

export interface AcpInsightState {
  stage: string;
  progress: number;
  detail?: string;
}

/** Everything the webview holds that the conversation flow needs to render. */
export interface AcpToMessagesInput {
  /** Text stream: user prompts, assistant answers, thinking blocks. */
  messages: readonly TextMessage[];
  /** Tool calls keyed by ACP `toolCallId` (in-progress + completed). */
  toolCalls?: ReadonlyMap<string, ToolCallData>;
  /** Latest plan / todo snapshot. */
  planEntries?: readonly PlanEntry[];
  /** Optional insight progress. */
  insight?: AcpInsightState | null;
  /** Optional path to the finished insight report. */
  insightReportPath?: string | null;
}

/**
 * Stable, deterministic id for a text message. The webview's `TextMessage` has
 * no id, so derive one from role + timestamp + index — this keeps React keys
 * and golden tests stable. Swap to a real id once ACP carries one.
 */
function textMessageId(msg: TextMessage, index: number): string {
  return `acp-${msg.role}-${msg.timestamp}-${index}`;
}

/** Map one text message to the shared contract (user / assistant / thinking). */
function textToMessage(msg: TextMessage, index: number): Message {
  const id = textMessageId(msg, index);
  // TODO(WS3): carry user images (msg.kind === 'image' / imagePath) and the
  //   fileContext badge — via the user message's `images` / hostData.
  return { id, role: msg.role, content: msg.content, timestamp: msg.timestamp };
}

/** The webui status union has `cancelled`; the shared contract does not. */
function toToolStatus(status: string): DaemonMessageToolCallStatus {
  switch (status) {
    case 'pending':
    case 'in_progress':
    case 'completed':
    case 'failed':
      return status;
    // `cancelled` has no shared equivalent; surface it as a terminal failure.
    default:
      return 'failed';
  }
}

/** A tool title is `string | object` on the wire; flatten to a display string. */
function toToolTitle(title: ToolCallData['title']): string | undefined {
  if (typeof title === 'string') {
    return title || undefined;
  }
  if (title && typeof title === 'object') {
    return JSON.stringify(title);
  }
  return undefined;
}

function toToolContent(
  content: ToolCallData['content'],
): DaemonMessageToolCallContent[] | undefined {
  if (!content || content.length === 0) {
    return undefined;
  }
  return content.map((c) => ({
    type: c.type,
    content: c.content,
    path: c.path,
    // webui carries `oldText: string | null`; the contract uses `string?`.
    oldText: c.oldText ?? undefined,
    newText: c.newText,
  }));
}

function toToolLocations(
  locations: ToolCallData['locations'],
): DaemonMessageToolCallLocation[] | undefined {
  if (!locations || locations.length === 0) {
    return undefined;
  }
  // webui location is `{ path, line }`; the contract renames `path` → `file`.
  return locations.map((l) => ({ file: l.path, line: l.line ?? undefined }));
}

/** Map a webview `ToolCallData` onto the shared `ACPToolCall`. */
function toACPToolCall(tc: ToolCallData): ACPToolCall {
  return {
    callId: tc.toolCallId,
    // In the webview, `kind` carries the actual tool name (e.g. `todo_write`),
    // which the panel lowercases for classification / display-name lookup.
    toolName: tc.kind,
    title: toToolTitle(tc.title),
    status: toToolStatus(tc.status),
    args:
      tc.rawInput && typeof tc.rawInput === 'object'
        ? (tc.rawInput as Record<string, unknown>)
        : undefined,
    rawOutput: tc.rawOutput,
    content: toToolContent(tc.content),
    locations: toToolLocations(tc.locations),
    startTime: tc.timestamp,
  };
}

function planToMessage(entries: readonly PlanEntry[]): Message {
  const todos: DaemonMessageTodoItem[] = entries.map((e, i) => ({
    id: `acp-plan-${i}`,
    content: e.content,
    status: e.status,
    priority: e.priority,
  }));
  return { id: 'acp-plan', role: 'plan', todos };
}

/** Timeline entry tagged so we can group consecutive tool calls. */
type Entry =
  | { kind: 'text'; ts: number; msg: TextMessage; index: number }
  | { kind: 'tool'; ts: number; tool: ToolCallData };

/**
 * Convert the webview's ACP-derived state to the shared `Message[]`.
 *
 * Order mirrors the webview's `allMessages`: text and tool calls merged by
 * timestamp (missing timestamps sort as 0). Consecutive tool calls collapse
 * into one `tool_group`. The current plan and insight state are appended last —
 * the webview holds them as snapshots without per-row timestamps, so precise
 * interleaving is a TODO once ACP carries their timing.
 */
export function acpToMessages(input: AcpToMessagesInput): Message[] {
  const entries: Entry[] = [];

  input.messages.forEach((msg, index) => {
    entries.push({ kind: 'text', ts: msg.timestamp ?? 0, msg, index });
  });
  for (const tool of input.toolCalls?.values() ?? []) {
    entries.push({ kind: 'tool', ts: tool.timestamp ?? 0, tool });
  }

  // Stable sort by timestamp so same-timestamp items keep insertion order
  // (text before tools, matching how the webview pushes them).
  entries.sort((a, b) => a.ts - b.ts);

  const messages: Message[] = [];
  let pendingTools: ToolCallData[] = [];

  const flushTools = (): void => {
    if (pendingTools.length === 0) {
      return;
    }
    const first = pendingTools[0];
    messages.push({
      id: `acp-tools-${first.toolCallId}`,
      role: 'tool_group',
      tools: pendingTools.map(toACPToolCall),
      timestamp: first.timestamp,
    });
    pendingTools = [];
  };

  for (const entry of entries) {
    if (entry.kind === 'tool') {
      pendingTools.push(entry.tool);
      continue;
    }
    flushTools();
    messages.push(textToMessage(entry.msg, entry.index));
  }
  flushTools();

  if (input.planEntries && input.planEntries.length > 0) {
    messages.push(planToMessage(input.planEntries));
  }

  if (input.insight) {
    messages.push({
      id: 'acp-insight-progress',
      role: 'insight_progress',
      stage: input.insight.stage,
      progress: input.insight.progress,
      detail: input.insight.detail,
    });
  }

  if (input.insightReportPath) {
    messages.push({
      id: 'acp-insight-ready',
      role: 'insight_ready',
      path: input.insightReportPath,
    });
  }

  return messages;
}
