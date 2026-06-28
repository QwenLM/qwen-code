/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * acpToMessages — VSCode webview adapter (WS3, skeleton).
 *
 * Converts the webview's in-memory, ACP-derived state (the text stream, the
 * tool-call map, plan entries) into the shared `@qwen-code/chat-panel`
 * `Message[]` contract, so the webview can render through `<ChatPanel>` just
 * like web-shell does — each host maps its own data onto the same contract.
 *
 * Status: TRACER skeleton. Only user / assistant / thinking text messages are
 * mapped today; tool_group, plan, and insight rows are stubbed (see TODOs) and
 * land as WS3 progresses. The function is pure and deterministic so it can be
 * golden-tested in isolation, before any webview wiring.
 *
 * WIRING BLOCKER (WS3, resolve first): this package is `NodeNext`, but
 * `@qwen-code/chat-panel` currently emits `bundler`-style `.d.ts` with
 * extensionless re-exports (`export * from './adapters/types'`), which NodeNext
 * cannot follow — so the `Message` import below won't resolve here yet. Fix by
 * making chat-panel NodeNext-consumable (give its source relative imports `.js`
 * extensions so the emitted types carry them; that stays vite/bundler-safe too),
 * then add a `@qwen-code/chat-panel` workspace dep (or tsconfig/esbuild source
 * alias) to this package. Until then this file is a scaffold, not yet built.
 */
import type { Message } from '@qwen-code/chat-panel';
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
  /** Optional insight progress + final report path. */
  insight?: AcpInsightState | null;
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
  if (msg.role === 'user') {
    // TODO(WS3): carry images (msg.kind === 'image' / imagePath) and the
    //   fileContext badge — via attachments / textElements, or hostData.
    return { id, role: 'user', content: msg.content, timestamp: msg.timestamp };
  }
  if (msg.role === 'thinking') {
    return {
      id,
      role: 'thinking',
      content: msg.content,
      timestamp: msg.timestamp,
    };
  }
  return {
    id,
    role: 'assistant',
    content: msg.content,
    timestamp: msg.timestamp,
  };
}

/**
 * TRACER: convert the text stream to `Message[]`. Tool calls, plan, and insight
 * are not folded in yet — this is the minimal first step that lets `<ChatPanel>`
 * render a real user + assistant conversation in the webview.
 */
export function acpToMessages(input: AcpToMessagesInput): Message[] {
  const messages: Message[] = input.messages.map((m, i) => textToMessage(m, i));

  // TODO(WS3): fold tool calls in as `tool_group` rows — group `input.toolCalls`
  //   by turn (reuse the shared `groupConsecutiveTools` helper once it moves
  //   into the package), map `ToolCallData` → `ACPToolCall`
  //   (`toolCallId` → `callId`, `locations[].path` → `file`, content/status),
  //   interleaved with the text stream by timestamp.
  // TODO(WS3): map `input.planEntries` → a `plan` row (`PlanEntry` → `TodoItem`,
  //   preserving priority/status), merge-or-new like the daemon path.
  // TODO(WS3): map `input.insight` / `input.insightReportPath` →
  //   `insight_progress` / `insight_ready` rows.
  // TODO(WS3): once tool_group/plan/insight exist, merge ALL rows by timestamp
  //   so order matches the live transcript (mirrors web-shell's reference
  //   adapter `transcriptBlocksToDaemonMessages`).

  return messages;
}
