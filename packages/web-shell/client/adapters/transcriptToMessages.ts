/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonInputAnnotation,
  DaemonTranscriptBlock,
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonShellTranscriptBlock,
  DaemonStatusTranscriptBlock,
  DaemonUserShellTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import type {
  DaemonMessage,
  DaemonMessageToolCall,
  DaemonMessageToolCallContent,
  DaemonMessageToolCallStatus,
  DaemonMessageToolKind,
  DaemonMessageTodoItem,
  DaemonUserMessage,
} from './messageTypes.js';
import { isTodoWriteToolName } from '../utils/todos.js';

interface PermissionToolInfo {
  title?: string;
  args?: Record<string, unknown>;
}

type DaemonPermissionTranscriptBlock = Extract<
  DaemonTranscriptBlock,
  { kind: 'permission' }
>;

type ExtendedDaemonTextTranscriptBlock = DaemonTextTranscriptBlock & {
  meta?: {
    source?: unknown;
    inputAnnotations?: unknown;
  };
};

interface TranscriptMessageLabels {
  promptCancelled?: string;
  branchSuccess?: (name: string) => string;
  modelStreamInterrupted?: string;
  loopDetected?: string;
}

interface TranscriptMessageOptions {
  labels?: TranscriptMessageLabels;
}

interface BackgroundAgentTaskUpdate {
  status: string;
  endTime: number;
}

function collectBackgroundAgentTaskUpdates(
  blocks: readonly DaemonTranscriptBlock[],
): ReadonlyMap<string, BackgroundAgentTaskUpdate> {
  const updates = new Map<string, BackgroundAgentTaskUpdate>();
  for (const block of blocks) {
    if (block.kind !== 'assistant' && block.kind !== 'user') continue;
    const meta = getRecord(block.meta);
    if (
      meta?.['source'] !== 'background_notification' ||
      meta['qwenDiscreteMessage'] !== true
    ) {
      continue;
    }
    const task = getRecord(meta['backgroundTask']);
    const toolUseId = getString(task, 'toolUseId');
    const status = getString(task, 'status');
    if (task?.['kind'] !== 'agent' || !toolUseId || !status) continue;
    updates.set(toolUseId, {
      status,
      endTime: block.serverTimestamp ?? block.clientReceivedAt,
    });
  }
  return updates;
}

function applyBackgroundAgentTaskUpdate(
  tool: DaemonMessageToolCall,
  update: BackgroundAgentTaskUpdate | undefined,
): void {
  if (!update) return;
  switch (update.status) {
    case 'completed':
      tool.status = 'completed';
      tool.endTime = update.endTime;
      break;
    case 'failed':
      tool.status = 'failed';
      tool.endTime = update.endTime;
      break;
    case 'cancelled':
    case 'canceled':
      tool.status = 'completed';
      tool.endTime = update.endTime;
      tool.rawOutput = {
        ...(getRecord(tool.rawOutput) ?? {}),
        status: 'cancelled',
      };
      break;
  }
}

function isIgnoredWebShellStatus(text: string): boolean {
  // `model.changed` projects to a `status` block, not a `debug` one, so this
  // stays text-keyed. The Web Shell renders its own richer model-switch
  // summary (dispatched as a client-side `debug` event) instead.
  return text.startsWith('Model switched: ');
}

/**
 * Whole shape of the legacy top-level projection — `<event-type>
 * (unrecognized daemon event): <payload>` — anchored at the start. Matching
 * the marker anywhere in the text would hide any block that merely quotes it,
 * such as a malformed payload carrying an upstream peer's message.
 *
 * The payload is deliberately unconstrained. `DaemonEvent.data` is `unknown`
 * and `stringifyJson` returns strings verbatim, serializes primitives as
 * `42` / `true` / `null`, and yields `''` for `undefined` — so keying on a
 * leading `{` would let every non-object payload slip through. The event-type
 * prefix plus the fixed phrase is specific enough on its own.
 */
const LEGACY_UNRECOGNIZED_EVENT_PATTERN =
  /^[A-Za-z0-9_.-]+ \(unrecognized daemon event\): /;

/**
 * The legacy `session_update` projection is `<kind>: <json>` — no marker to
 * key on, so those blocks can only be matched by kind name. Deliberately
 * scoped to the kinds known to have leaked into transcripts before the
 * normalizer suppressed them at the source: `usage_update` (#8790, the
 * original spam report) and `a2ui`, whose command JSON the bridge splits out
 * of the tool frame precisely to keep it out of transcripts. Anchored, and
 * requiring the `: {` shape, so prose starting with the word still renders.
 */
const LEGACY_SUPPRESSED_SESSION_UPDATE_PREFIXES = [
  'usage_update: {',
  'a2ui: {',
];

/**
 * Daemon frames the normalizer had no case for are developer diagnostics —
 * a raw JSON dump of an event this client does not understand. They routinely
 * appear whenever the daemon ships a new event kind ahead of the UI, and
 * rendering them drops unreadable JSON into the middle of the conversation.
 *
 * Keyed on the normalizer's `debugReason` rather than the block text. The
 * SDK names reasons by category: `unrecognized_*` is forward-compat noise,
 * hidden here by prefix so a reason a newer SDK adds is covered without a
 * Web Shell change. Everything else deliberately stays visible — `malformed_*`
 * means a frame this client *does* know arrived broken and is worth
 * surfacing, and client-dispatched debug blocks (e.g. the model-switch
 * summary) carry no `debugReason` at all.
 *
 * `WebShellTranscript` is a public entry point that takes already-projected
 * blocks from its caller, so blocks projected — or persisted — by an SDK older
 * than `debugReason` still arrive here with no reason at all. Those are
 * matched by shape instead, and only ever by shape: text matching is a
 * compatibility shim, so it is scoped to `debug` blocks (this helper is also
 * called for `status`, which never carried these projections) and anchored to
 * the whole projection, never a substring. A block that merely quotes a
 * marker — a malformed payload relaying an upstream message, a
 * client-dispatched summary, an ordinary status line — keeps rendering.
 *
 * Legacy `session_update` blocks have no marker, so they are matched by kind
 * name instead — see the prefix list above. That list is closed on purpose: a
 * generic `<word>: {` rule would swallow legitimate diagnostics. An old block
 * for some other unrecognized session-update kind therefore still renders;
 * new projections carry the reason and are covered.
 */
function isUnrecognizedDaemonDebug(
  block: DaemonStatusTranscriptBlock,
): boolean {
  if (block.debugReason !== undefined) {
    return block.debugReason.startsWith('unrecognized_');
  }
  // Only `debug` blocks ever carried an unrecognized projection; a `status`
  // block matching one of these shapes is real content.
  if (block.kind !== 'debug') return false;
  return (
    LEGACY_UNRECOGNIZED_EVENT_PATTERN.test(block.text) ||
    LEGACY_SUPPRESSED_SESSION_UPDATE_PREFIXES.some((prefix) =>
      block.text.startsWith(prefix),
    )
  );
}

// Resubmitting a prompt the daemon stopped for loop protection tends to
// re-loop, so no retry affordance is offered for these turn errors.
export function isRetryableTurnErrorKind(
  errorKind: string | undefined,
): boolean {
  return errorKind !== 'loop_detected';
}

function getErrorDisplayText(
  block: DaemonStatusTranscriptBlock,
  labels?: TranscriptMessageLabels,
): string {
  if (block.errorKind === 'loop_detected') {
    return labels?.loopDetected ?? block.text;
  }
  if (
    block.errorKind === 'model_stream_interrupted' ||
    // Older daemons emit this turn_error before they know about errorKind.
    (block.source === 'turn_error' &&
      block.text.trim().toLowerCase() === 'terminated')
  ) {
    return labels?.modelStreamInterrupted ?? block.text;
  }
  return block.text;
}

function getErrorMessageData(
  data: unknown,
  errorKind: DaemonStatusTranscriptBlock['errorKind'],
): { data?: unknown } {
  if (data === undefined) return {};
  if (!errorKind) return { data };
  return {
    data: {
      ...(getRecord(data) ?? { value: data }),
      errorKind,
    },
  };
}

function getSessionBranchDisplayName(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const branchData = data as {
    displayName?: unknown;
    newSessionId?: unknown;
  };
  if (typeof branchData.displayName === 'string' && branchData.displayName) {
    return branchData.displayName;
  }
  return typeof branchData.newSessionId === 'string'
    ? branchData.newSessionId.slice(0, 8)
    : null;
}

/**
 * Extract image content blocks from mid-turn injected message items.
 * Returns an array of {data, mimeType} objects for rendering in the transcript.
 */
function getMidTurnInjectedImages(
  data: unknown,
): Array<{ data: string; mimeType: string }> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return undefined;

  const images: Array<{ data: string; mimeType: string }> = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const type = (block as { type?: unknown }).type;
      const blockData = (block as { data?: unknown }).data;
      const mimeType = (block as { mimeType?: unknown }).mimeType;

      if (
        type === 'image' &&
        typeof blockData === 'string' &&
        typeof mimeType === 'string'
      ) {
        images.push({ data: blockData, mimeType });
      }
    }
  }

  return images.length > 0 ? images : undefined;
}

/**
 * Collect text content blocks from mid-turn injected message items. The
 * degraded-media drain echo ships an empty `messages` array whose items carry
 * only the unavailability notice, so the echo text can be empty while the
 * items still hold renderable text.
 */
function getMidTurnInjectedItemText(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return undefined;

  const texts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if ((block as { type?: unknown }).type !== 'text') continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) texts.push(text);
    }
  }

  return texts.length > 0 ? texts.join('\n') : undefined;
}

function isBackgroundNotificationBlock(
  block: DaemonTextTranscriptBlock,
): boolean {
  const extended = block as ExtendedDaemonTextTranscriptBlock;
  return extended.meta?.['source'] === 'background_notification';
}

function getBackgroundNotificationData(
  block: DaemonTextTranscriptBlock,
): Record<string, unknown> | undefined {
  const extended = block as ExtendedDaemonTextTranscriptBlock;
  return getRecord(extended.meta?.['backgroundTask']) ?? undefined;
}

function isTextBlockEmpty(block: DaemonTextTranscriptBlock): boolean {
  return block.text.length === 0;
}

function parseDaemonTodoItemsFromEntries(
  entries: readonly unknown[],
): DaemonMessageTodoItem[] | undefined {
  const todos = entries.flatMap((entry, index): DaemonMessageTodoItem[] => {
    const item = getRecord(entry);
    const content = getString(item, 'content');
    if (!content) return [];
    const id = getString(item, 'id') ?? `plan-${index}`;
    return [
      {
        id,
        content,
        status: getTodoStatus(getString(item, 'status')),
        ...(() => {
          const priority = getTodoPriority(getString(item, 'priority'));
          return priority ? { priority } : {};
        })(),
      },
    ];
  });
  return todos.length > 0 ? todos : undefined;
}

/**
 * Sum the per-block token usage the SDK reducer stamped onto assistant blocks
 * when several merge into one rendered message. Returns undefined when neither
 * side has usage, so the message field stays absent rather than a spurious 0/0.
 */
function mergeAssistantUsage(
  a:
    | { inputTokens: number; outputTokens: number; cachedTokens?: number }
    | undefined,
  b:
    | { inputTokens: number; outputTokens: number; cachedTokens?: number }
    | undefined,
):
  | { inputTokens: number; outputTokens: number; cachedTokens?: number }
  | undefined {
  if (!a) return b;
  if (!b) return a;
  const cachedTokens = (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
  };
}

export function transcriptBlocksToDaemonMessages(
  blocks: readonly DaemonTranscriptBlock[],
  options: TranscriptMessageOptions = {},
): DaemonMessage[] {
  const messages: DaemonMessage[] = [];
  const promptCancelledText =
    options.labels?.promptCancelled ?? 'Request cancelled.';
  // Replay can contain thousands of blocks. Keep tool calls indexed by callId
  // so later tool updates, parented children, and permission placeholders
  // merge in O(1)
  // instead of scanning the rendered message list for every block.
  // Subagent-owned assistant/thought/tool blocks are expected to carry
  // parentToolCallId; unparented blocks are rendered as top-level transcript.
  const toolsByCallId = new Map<string, DaemonMessageToolCall>();
  const permissionToolInfoByCallId = new Map<string, PermissionToolInfo>();
  const backgroundAgentTaskUpdates = collectBackgroundAgentTaskUpdates(blocks);
  let currentAssistantIdx: number | null = null;
  let currentThinkingIdx: number | null = null;
  // Tool cards are standalone transcript turns. Once a tool is emitted,
  // the next top-level assistant/thought block must start a fresh assistant
  // message instead of being appended to text that appeared before the tool.
  let needsNewContentMessage = false;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    // Wall-clock of this block, surfaced as a hover tooltip on the rendered
    // message. Prefer the daemon-authoritative stamp so every client agrees;
    // fall back to the local receive time when the daemon left it unset.
    const blockTime = block.serverTimestamp ?? block.clientReceivedAt;

    switch (block.kind) {
      case 'user': {
        const textBlock = block as DaemonTextTranscriptBlock;
        if (isBackgroundNotificationBlock(textBlock)) {
          currentAssistantIdx = null;
          currentThinkingIdx = null;
          needsNewContentMessage = true;
          messages.push({
            id: block.id,
            role: 'system',
            content: textBlock.text,
            variant: 'info',
            source: 'background_notification',
            data: getBackgroundNotificationData(textBlock),
            timestamp: blockTime,
          });
          break;
        }
        currentAssistantIdx = null;
        currentThinkingIdx = null;
        needsNewContentMessage = false;
        const meta = getRecord(
          (textBlock as ExtendedDaemonTextTranscriptBlock).meta,
        );
        const source = getString(meta, 'source');
        const inputAnnotations = Array.isArray(meta?.inputAnnotations)
          ? (meta.inputAnnotations as DaemonInputAnnotation[])
          : undefined;
        const images = textBlock.images?.map((img) => ({
          data: img.data,
          mimeType: img.mimeType || 'image/*',
        }));
        if (source === 'mid_turn_message_injected') {
          messages.push({
            id: block.id,
            role: 'system',
            content: textBlock.text,
            variant: 'info',
            source,
            timestamp: blockTime,
            ...(images && images.length > 0 ? { images } : {}),
          });
          needsNewContentMessage = true;
          break;
        }
        const msg: DaemonUserMessage = {
          id: block.id,
          role: 'user',
          content: textBlock.text,
          timestamp: blockTime,
          ...(source ? { source } : {}),
          ...(inputAnnotations ? { inputAnnotations } : {}),
        };
        // Attach images if present
        if (images && images.length > 0) {
          msg.images = images;
        }
        if (textBlock.files && textBlock.files.length > 0) {
          msg.files = textBlock.files.map((file) => ({
            name: file.name,
            mimeType: file.mimeType || 'text/plain',
          }));
        }
        messages.push(msg);
        break;
      }

      case 'assistant': {
        const textBlock = block as DaemonTextTranscriptBlock;
        if (isBackgroundNotificationBlock(textBlock)) {
          currentAssistantIdx = null;
          currentThinkingIdx = null;
          needsNewContentMessage = true;
          messages.push({
            id: block.id,
            role: 'system',
            content: textBlock.text,
            variant: 'info',
            source: 'background_notification',
            data: getBackgroundNotificationData(textBlock),
            timestamp: blockTime,
          });
          break;
        }
        if (!textBlock.text && !textBlock.usage) break;

        const parentSubAgent = textBlock.parentToolCallId
          ? toolsByCallId.get(textBlock.parentToolCallId)
          : undefined;
        if (parentSubAgent) {
          appendSubContent(parentSubAgent, textBlock.text);
          break;
        }

        const insightSegments = splitInsightSegments(textBlock.text);
        if (insightSegments) {
          let lastProgress: ParsedInsight | null = null;
          let hasTerminal = false;
          let readyCount = 0;
          let errorCount = 0;
          let lastAssistantSegmentIndex: number | null = null;
          for (const seg of insightSegments) {
            if (seg.kind === 'insight') {
              if (seg.data.type === 'insight_progress') {
                lastProgress = seg.data;
              } else if (seg.data.type === 'insight_ready') {
                hasTerminal = true;
                messages.push({
                  id: `${block.id}-ir-${readyCount++}`,
                  role: 'insight_ready',
                  path: seg.data.path,
                  timestamp: blockTime,
                });
              } else if (seg.data.type === 'insight_error') {
                hasTerminal = true;
                messages.push({
                  id: `${block.id}-ie-${errorCount++}`,
                  role: 'insight_error',
                  error: seg.data.error,
                  timestamp: blockTime,
                });
              }
            } else {
              messages.push({
                id: `${block.id}-t-${messages.length}`,
                role: 'assistant',
                content: seg.text,
                timestamp: blockTime,
              });
              currentAssistantIdx = messages.length - 1;
              lastAssistantSegmentIndex = currentAssistantIdx;
              currentThinkingIdx = null;
            }
          }
          if (textBlock.branchRecordId && lastAssistantSegmentIndex !== null) {
            const assistant = messages[lastAssistantSegmentIndex];
            if (assistant?.role === 'assistant') {
              messages[lastAssistantSegmentIndex] = {
                ...assistant,
                branchRecordId: textBlock.branchRecordId,
              };
            }
          }
          if (lastProgress && !hasTerminal) {
            messages.push({
              id: `${block.id}-ip`,
              role: 'insight_progress',
              stage: lastProgress.stage,
              progress: lastProgress.progress,
              detail: lastProgress.detail,
              timestamp: blockTime,
            });
          }
          needsNewContentMessage = true;
          break;
        }

        const target =
          currentAssistantIdx !== null
            ? messages[currentAssistantIdx]
            : undefined;
        if (
          target &&
          target.role === 'assistant' &&
          !needsNewContentMessage &&
          !isTextBlockEmpty(textBlock)
        ) {
          const usage = mergeAssistantUsage(target.usage, textBlock.usage);
          messages[currentAssistantIdx!] = {
            ...target,
            content: target.content + textBlock.text,
            isStreaming: textBlock.streaming,
            ...(textBlock.branchRecordId
              ? { branchRecordId: textBlock.branchRecordId }
              : {}),
            ...(usage ? { usage } : {}),
          };
          needsNewContentMessage = false;
          currentThinkingIdx = null;
        } else if (!isTextBlockEmpty(textBlock)) {
          messages.push({
            id: block.id,
            role: 'assistant',
            content: textBlock.text,
            isStreaming: textBlock.streaming,
            timestamp: blockTime,
            ...(textBlock.branchRecordId
              ? { branchRecordId: textBlock.branchRecordId }
              : {}),
            ...(textBlock.usage ? { usage: textBlock.usage } : {}),
          });
          currentAssistantIdx = messages.length - 1;
          currentThinkingIdx = null;
          needsNewContentMessage = false;
        } else if (textBlock.usage && target && target.role === 'assistant') {
          const usage = mergeAssistantUsage(target.usage, textBlock.usage);
          messages[currentAssistantIdx!] = {
            ...target,
            ...(textBlock.branchRecordId
              ? { branchRecordId: textBlock.branchRecordId }
              : {}),
            ...(usage ? { usage } : {}),
          };
        }
        break;
      }

      case 'thought': {
        const textBlock = block as DaemonTextTranscriptBlock;
        const parentSubAgent = textBlock.parentToolCallId
          ? toolsByCallId.get(textBlock.parentToolCallId)
          : undefined;
        if (parentSubAgent) {
          appendSubContent(parentSubAgent, textBlock.text);
          break;
        }
        const target =
          currentThinkingIdx !== null
            ? messages[currentThinkingIdx]
            : undefined;
        if (target && target.role === 'thinking' && !needsNewContentMessage) {
          messages[currentThinkingIdx!] = {
            ...target,
            content: target.content + textBlock.text,
            isStreaming: textBlock.streaming,
          };
          needsNewContentMessage = false;
        } else {
          messages.push({
            id: block.id,
            role: 'thinking',
            content: textBlock.text,
            isStreaming: textBlock.streaming,
            timestamp: blockTime,
          });
          currentThinkingIdx = messages.length - 1;
          needsNewContentMessage = false;
        }
        currentAssistantIdx = null;
        break;
      }

      case 'tool': {
        const toolBlock = block as DaemonToolTranscriptBlock;
        const toolCall = daemonToolBlockToToolCall(toolBlock);
        applyBackgroundAgentTaskUpdate(
          toolCall,
          backgroundAgentTaskUpdates.get(toolCall.callId),
        );
        const permissionInfo = permissionToolInfoByCallId.get(toolCall.callId);
        if (permissionInfo?.title) {
          toolCall.title = permissionInfo.title;
        }
        if (!toolCall.args && permissionInfo?.args) {
          toolCall.args = permissionInfo.args;
        }
        const parentSubAgent = toolCall.parentToolCallId
          ? toolsByCallId.get(toolCall.parentToolCallId)
          : undefined;
        const existingTool = toolsByCallId.get(toolCall.callId);

        if (existingTool) {
          mergeToolCall(existingTool, toolCall);
          break;
        }

        if (parentSubAgent) {
          appendSubTool(parentSubAgent, toolCall);
          toolsByCallId.set(toolCall.callId, toolCall);
          break;
        }

        appendToolCallMessage(messages, block.id, toolCall, blockTime);
        toolsByCallId.set(toolCall.callId, toolCall);
        currentAssistantIdx = null;
        currentThinkingIdx = null;
        needsNewContentMessage = true;
        break;
      }

      case 'shell': {
        const shellBlock = block as DaemonShellTranscriptBlock;
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'tool_group') {
          const targetIdx = findShellOutputTargetIndex(lastMsg.tools);
          const targetTool = lastMsg.tools[targetIdx];
          if (targetTool) {
            const previousOutput =
              typeof targetTool.rawOutput === 'string'
                ? targetTool.rawOutput
                : '';
            const nextTool = {
              ...targetTool,
              rawOutput: previousOutput + shellBlock.text,
            };
            messages[messages.length - 1] = {
              ...lastMsg,
              tools: [
                ...lastMsg.tools.slice(0, targetIdx),
                nextTool,
                ...lastMsg.tools.slice(targetIdx + 1),
              ],
            };
            if (toolsByCallId.get(targetTool.callId) === targetTool) {
              toolsByCallId.set(targetTool.callId, nextTool);
            }
          }
        } else {
          messages.push({
            id: block.id,
            role: 'tool_group',
            tools: [
              {
                callId: block.id,
                toolName: 'shell',
                status: 'completed',
                kind: 'execute',
                rawOutput: shellBlock.text,
              },
            ],
            timestamp: blockTime,
          });
          needsNewContentMessage = true;
        }
        break;
      }

      case 'user_shell': {
        const shellBlock = block as DaemonUserShellTranscriptBlock;
        messages.push({
          id: block.id,
          role: 'user_shell',
          command: shellBlock.command,
          output: shellBlock.text,
          ...(shellBlock.cwd ? { cwd: shellBlock.cwd } : {}),
          timestamp: blockTime,
        });
        needsNewContentMessage = true;
        break;
      }

      case 'permission': {
        const permBlock = block as DaemonPermissionTranscriptBlock;
        rememberPermissionToolInfo(permBlock, permissionToolInfoByCallId);
        const permissionToolCall = permissionBlockToToolCall(permBlock);
        if (!permissionToolCall) break;
        const isSubAgentPermission = isSubAgentToolCall(permissionToolCall);
        // Pending permissions are rendered by the dedicated permission UI.
        if (!permBlock.resolved) {
          break;
        }

        const existingPermission = toolsByCallId.get(permissionToolCall.callId);
        if (existingPermission) {
          const previousStatus = existingPermission.status;
          const previousEndTime = existingPermission.endTime;
          permissionToolCall.toolName = existingPermission.toolName;
          if (permBlock.resolved) {
            if (isApprovedPermissionResolution(permBlock.resolved)) {
              permissionToolCall.status = isSubAgentPermission
                ? permissionToolCall.status
                : 'in_progress';
            } else {
              permissionToolCall.status = 'failed';
              permissionToolCall.endTime = permBlock.updatedAt;
            }
          }
          mergeToolCall(existingPermission, permissionToolCall);
          if (
            isTerminalToolStatus(previousStatus) ||
            (permBlock.resolved &&
              isSubAgentPermission &&
              isApprovedPermissionResolution(permBlock.resolved))
          ) {
            existingPermission.status = previousStatus;
            existingPermission.endTime = previousEndTime;
          }
          break;
        }

        if (permBlock.resolved) {
          // Resolved permission with no matching real tool block:
          // - Approved: the daemon may still skip the initial agent tool_call
          //   or a regular tool_call. Keep a pending placeholder visible so
          //   later parented child events and the final update can merge by
          //   callId.
          // - Rejected: render a finished card. Later assistant content stays
          //   in the main conversation unless it has an explicit parent.
          if (isApprovedPermissionResolution(permBlock.resolved)) {
            if (!isSubAgentPermission) {
              permissionToolCall.status = 'in_progress';
            }
            appendToolCallMessage(
              messages,
              block.id,
              permissionToolCall,
              blockTime,
            );
            toolsByCallId.set(permissionToolCall.callId, permissionToolCall);
            needsNewContentMessage = true;
          } else {
            permissionToolCall.status = 'failed';
            permissionToolCall.endTime = permBlock.updatedAt;
            appendToolCallMessage(
              messages,
              block.id,
              permissionToolCall,
              blockTime,
            );
            toolsByCallId.set(permissionToolCall.callId, permissionToolCall);
            needsNewContentMessage = true;
          }
          break;
        }

        break;
      }

      case 'status':
      case 'debug': {
        const statusBlock = block;
        if (isUnrecognizedDaemonDebug(statusBlock)) break;
        // Mid-turn injected echoes are user content, not daemon diagnostics:
        // run them past no filter, or an injected message that merely starts
        // like a status line ("Model switched: …") or plan JSON would be
        // dropped or misrendered.
        if (statusBlock.source === 'mid_turn_message_injected') {
          const midTurnInjectedImages = getMidTurnInjectedImages(
            statusBlock.data,
          );
          messages.push({
            id: block.id,
            role: 'system',
            content:
              statusBlock.text.length > 0
                ? statusBlock.text
                : (getMidTurnInjectedItemText(statusBlock.data) ??
                  statusBlock.text),
            variant: 'info',
            timestamp: blockTime,
            source: statusBlock.source,
            ...(statusBlock.data !== undefined
              ? { data: statusBlock.data }
              : {}),
            ...(midTurnInjectedImages ? { images: midTurnInjectedImages } : {}),
          });
          needsNewContentMessage = true;
          break;
        }
        const branchDisplayName =
          statusBlock.source === 'session_branched'
            ? getSessionBranchDisplayName(statusBlock.data)
            : null;
        const text =
          branchDisplayName && options.labels?.branchSuccess
            ? options.labels.branchSuccess(branchDisplayName)
            : statusBlock.text;
        if (isIgnoredWebShellStatus(text)) break;
        const todos = parsePlanTodos(text);
        if (todos) {
          messages.push({
            id: block.id,
            role: 'plan',
            todos,
            timestamp: blockTime,
          });
          needsNewContentMessage = true;
          break;
        }
        // Status blocks and the debug blocks that survive the filter above are
        // daemon-level diagnostics, not tool output. Keeping them in the main
        // transcript avoids hiding global messages such as SSE lag warnings,
        // malformed-event debug lines, or shell result notices inside
        // whichever subAgent happened to be active.
        messages.push({
          id: block.id,
          role: 'system',
          content: text,
          variant: 'info',
          timestamp: blockTime,
          ...(statusBlock.source ? { source: statusBlock.source } : {}),
          ...(statusBlock.data !== undefined ? { data: statusBlock.data } : {}),
        });
        needsNewContentMessage = true;
        break;
      }

      case 'error': {
        const errorBlock = block;
        const errorKind = errorBlock.errorKind;
        messages.push({
          id: block.id,
          role: 'system',
          content: getErrorDisplayText(errorBlock, options.labels),
          variant: 'error',
          retryable:
            errorBlock.source === 'turn_error' &&
            isRetryableTurnErrorKind(errorKind),
          timestamp: blockTime,
          ...(errorBlock.source ? { source: errorBlock.source } : {}),
          ...getErrorMessageData(errorBlock.data, errorKind),
        });
        needsNewContentMessage = true;
        break;
      }

      case 'prompt_cancelled':
        messages.push({
          id: block.id,
          role: 'system',
          content: promptCancelledText,
          variant: 'info',
          source: 'prompt_cancelled',
          timestamp: blockTime,
        });
        needsNewContentMessage = true;
        break;

      default:
        break;
    }
  }

  return messages;
}

function appendSubTool(
  parent: DaemonMessageToolCall,
  toolCall: DaemonMessageToolCall,
): void {
  parent.subTools ||= [];
  parent.subTools.push(toolCall);
}

function appendSubContent(parent: DaemonMessageToolCall, text: string): void {
  parent.subContent = (parent.subContent || '') + text;
}

function appendToolCallMessage(
  messages: DaemonMessage[],
  blockId: string,
  toolCall: DaemonMessageToolCall,
  timestamp?: number,
): void {
  // Native CLI groups every tool call of one scheduler batch into a single
  // bordered tool_group (mapToDisplay in useReactToolScheduler). The daemon
  // transcript carries no batch marker, so the replay-stable equivalent is
  // adjacency: a tool block arriving while a tool_group is still the latest
  // visible message joins that group instead of opening a new box.
  //
  // Sub-agent calls stay in their own single-tool groups — MessageList's
  // groupParallelAgents relies on that shape to render consecutive agent
  // launches as ParallelAgentsGroup.
  //
  // Synthetic raw-shell groups (pushed by the `shell` block fallback) use the
  // bare block id without the `tg-` prefix and never absorb real tool calls.
  // Sub-agent calls and todo_write updates each stand alone in their own group
  // box instead of being crammed in with the tools around them: an agent renders
  // an expandable panel, and a todo update is its own collapsible checklist.
  const isStandalone = (t: DaemonMessageToolCall) =>
    isSubAgentToolCall(t) || isTodoWriteToolName(t.toolName);
  const last = messages[messages.length - 1];
  if (
    last &&
    last.role === 'tool_group' &&
    last.id.startsWith('tg-') &&
    !isStandalone(toolCall) &&
    !last.tools.some(isStandalone)
  ) {
    last.tools.push(toolCall);
    return;
  }
  messages.push({
    id: `tg-${blockId}`,
    role: 'tool_group',
    tools: [toolCall],
    timestamp,
  });
}

/**
 * Pick which tool in a group should receive a raw shell output chunk.
 *
 * Shell transcript blocks carry no toolCallId, so attachment is heuristic.
 * Single-tool groups (the only shape before adjacent-merge) keep the old
 * "last tool" behavior. In merged groups, prefer the most recent `execute`
 * tool that is still running — the scheduler executes one tool at a time, so
 * that is the tool producing output. On replay every status is already
 * terminal; fall back to the most recent `execute` tool, then to the last
 * tool so groups without kind metadata behave exactly as before.
 */
function findShellOutputTargetIndex(
  tools: readonly DaemonMessageToolCall[],
): number {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (tool.kind === 'execute' && tool.status === 'in_progress') {
      return i;
    }
  }
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].kind === 'execute') {
      return i;
    }
  }
  return tools.length - 1;
}

function mergeToolCall(
  target: DaemonMessageToolCall,
  source: DaemonMessageToolCall,
): void {
  target.status = source.status ?? target.status;
  target.title = source.title ?? target.title;
  target.toolName = source.toolName ?? target.toolName;
  target.kind = source.kind ?? target.kind;
  target.content = source.content ?? target.content;
  target.endTime = source.endTime ?? target.endTime;
  target.rawOutput = source.rawOutput ?? target.rawOutput;
  target.args = source.args ?? target.args;
  target.locations = source.locations ?? target.locations;
}

function isTerminalToolStatus(status: DaemonMessageToolCallStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function isSubAgentToolCall(tool: DaemonMessageToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  if (name === 'agent' || name === 'task') return true;
  if (tool.subTools || tool.subContent) return true;
  if (isTaskExecutionRaw(tool.rawOutput)) return true;
  return Boolean(tool.args?.subagent_type);
}

function isTaskExecutionRaw(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as Record<string, unknown>).type === 'task_execution'
  );
}

function parsePlanTodos(text: string): DaemonMessageTodoItem[] | undefined {
  const rawJson = text.startsWith('plan: ')
    ? text.slice('plan: '.length)
    : undefined;
  if (!rawJson) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawJson) as unknown;
    const record = getRecord(parsed);
    if (
      record?.['sessionUpdate'] !== 'plan' ||
      !Array.isArray(record['entries'])
    ) {
      return undefined;
    }
    return parseDaemonTodoItemsFromEntries(record['entries']);
  } catch {
    return undefined;
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getTodoStatus(
  value: string | undefined,
): DaemonMessageTodoItem['status'] {
  return value === 'completed' || value === 'in_progress' || value === 'pending'
    ? value
    : 'pending';
}

function getTodoPriority(
  value: string | undefined,
): DaemonMessageTodoItem['priority'] | undefined {
  return value === 'high' || value === 'medium' || value === 'low'
    ? value
    : undefined;
}

function daemonToolBlockToToolCall(
  block: DaemonToolTranscriptBlock,
): DaemonMessageToolCall {
  const rawOutput = getToolRawOutput(block);
  const isBackgroundAgent = isBackgroundAgentBlock(block, rawOutput);
  const content = normalizeToolContent(block.content);
  const statusMap: Record<string, DaemonMessageToolCallStatus> = {
    running: 'in_progress',
    pending: 'pending',
    confirming: 'pending',
    background: 'pending',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'completed',
    canceled: 'completed',
    in_progress: 'in_progress',
  };
  const isComplete =
    block.status === 'completed' ||
    block.status === 'failed' ||
    block.status === 'cancelled' ||
    block.status === 'canceled';

  return {
    callId: block.toolCallId,
    toolName: block.toolName || 'unknown',
    title: block.title,
    status:
      (isBackgroundAgent ? 'pending' : statusMap[block.status]) ||
      (block.status as DaemonMessageToolCallStatus) ||
      'in_progress',
    kind: inferToolKind(block.toolName, block.toolKind),
    rawOutput,
    args: block.rawInput as Record<string, unknown> | undefined,
    parentToolCallId: block.parentToolCallId,
    startTime: block.createdAt,
    endTime: isComplete && !isBackgroundAgent ? block.updatedAt : undefined,
    ...(content ? { content } : {}),
  };
}

function permissionBlockToToolCall(
  block: DaemonPermissionTranscriptBlock,
): DaemonMessageToolCall | undefined {
  const toolCall = getRecord(block.toolCall);
  if (!toolCall) return undefined;

  const rawInput = getToolCallRawInput(toolCall);
  // AskUserQuestion permissions are rendered by the shell as a dedicated
  // interactive form from the pending permission itself. Emitting a synthetic
  // generic tool card here would show the same permission twice, especially
  // when older daemon events only expose it as kind: "think".
  if (Array.isArray(rawInput?.['questions'])) return undefined;

  const meta = getRecord(toolCall['_meta']);
  const kind = getString(toolCall, 'kind');
  const toolName =
    getString(meta, 'toolName') ??
    getString(toolCall, 'toolName') ??
    getString(toolCall, 'name') ??
    (rawInput?.['subagent_type'] ? 'agent' : undefined) ??
    (kind === 'fetch' ? 'web_fetch' : kind);
  const toolCallId =
    getString(toolCall, 'toolCallId') ?? getString(toolCall, 'id');
  if (!toolCallId || !toolName) return undefined;

  const syntheticTool: DaemonMessageToolCall = {
    callId: toolCallId,
    toolName,
    title: getString(toolCall, 'title') ?? block.title,
    status: 'pending',
    kind: inferToolKind(toolName, kind),
    args: rawInput,
    startTime: block.createdAt,
  };

  return syntheticTool;
}

function rememberPermissionToolInfo(
  block: DaemonPermissionTranscriptBlock,
  infoByCallId: Map<string, PermissionToolInfo>,
): void {
  const toolCall = getRecord(block.toolCall);
  const toolCallId =
    getString(toolCall, 'toolCallId') ?? getString(toolCall, 'id');
  if (!toolCallId) return;
  const title = getString(toolCall, 'title') ?? block.title;
  const rawInput = toolCall ? getToolCallRawInput(toolCall) : undefined;
  if (!Array.isArray(rawInput?.['questions'])) return;
  infoByCallId.set(toolCallId, {
    ...(title ? { title } : {}),
    ...(rawInput ? { args: rawInput } : {}),
  });
}

function isApprovedPermissionResolution(resolved: string): boolean {
  const [primary = '', detail = ''] = resolved.toLowerCase().split(':', 2);
  if (isApprovalToken(primary)) return true;
  if (primary !== 'selected') return false;
  return isApprovalToken(detail.trim());
}

function isApprovalToken(token: string): boolean {
  return (
    token === 'allow' ||
    token === 'allowed' ||
    token === 'approve' ||
    token === 'approved' ||
    token === 'accept' ||
    token === 'accepted' ||
    token === 'confirm' ||
    token === 'confirmed' ||
    token === 'proceed' ||
    token === 'proceed_once' ||
    token === 'proceed_once_and_switch_to_default' ||
    token === 'proceed_always_project' ||
    token === 'proceed_always_user' ||
    token === 'allow_once' ||
    token === 'allow_always' ||
    token === 'success' ||
    token === 'succeeded'
  );
}

function getToolCallRawInput(
  toolCall: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return (
    getRecord(toolCall['rawInput']) ??
    getRecord(toolCall['input']) ??
    getRecord(toolCall['args'])
  );
}

function isBackgroundAgentBlock(
  block: DaemonToolTranscriptBlock,
  rawOutput: unknown,
): boolean {
  const name = block.toolName?.toLowerCase();
  if (name !== 'agent' && name !== 'task') return false;
  const raw = getRecord(rawOutput);
  return raw?.['status'] === 'background';
}

function getToolRawOutput(block: DaemonToolTranscriptBlock): unknown {
  if (isAskUserQuestionBlock(block) && block.status === 'failed') {
    return getToolContentText(block) ?? block.details ?? block.rawOutput;
  }

  if (!isCancelledStatus(block.status) || !block.details) {
    return block.rawOutput ?? block.details;
  }

  if (
    block.rawOutput &&
    typeof block.rawOutput === 'object' &&
    !Array.isArray(block.rawOutput)
  ) {
    return {
      ...(block.rawOutput as Record<string, unknown>),
      status: block.status,
      reason: block.details,
    };
  }

  return {
    status: block.status,
    reason: block.details,
    text:
      typeof block.rawOutput === 'string' && block.rawOutput
        ? block.rawOutput
        : block.details,
  };
}

function normalizeToolContent(
  value: unknown,
): DaemonMessageToolCallContent[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const content = value.flatMap((entry): DaemonMessageToolCallContent[] => {
    const item = getRecord(entry);
    if (!item) return [];

    const type = item['type'];
    if (type === 'content') {
      const body = getRecord(item['content']);
      if (!body || typeof body['type'] !== 'string') return [];
      return [
        {
          type: 'content',
          content: { ...body, type: body['type'] },
        },
      ];
    }

    if (type === 'diff') {
      const newText = item['newText'];
      if (typeof newText !== 'string') return [];

      const path = item['path'];
      const oldText = item['oldText'];
      return [
        {
          type: 'diff',
          ...(typeof path === 'string' ? { path } : {}),
          ...(typeof oldText === 'string' ? { oldText } : {}),
          newText,
        },
      ];
    }

    if (type === 'terminal') {
      const terminalId = item['terminalId'];
      return [
        {
          type: 'terminal',
          ...(typeof terminalId === 'string' ? { terminalId } : {}),
        },
      ];
    }

    return [];
  });

  return content.length > 0 ? content : undefined;
}

function isAskUserQuestionBlock(block: DaemonToolTranscriptBlock): boolean {
  if (!block.toolName) return false;
  const normalized = block.toolName.toLowerCase();
  return normalized === 'ask_user_question' || normalized === 'askuserquestion';
}

function getToolContentText(
  block: DaemonToolTranscriptBlock,
): string | undefined {
  if (!Array.isArray(block.content)) return undefined;
  const parts = block.content
    .map((item) => item?.content?.text)
    .filter((text): text is string => Boolean(text));
  if (!parts || parts.length === 0) return undefined;
  return parts.join('\n');
}

function isCancelledStatus(status: string): boolean {
  return status === 'cancelled' || status === 'canceled';
}

type ParsedInsight =
  | {
      type: 'insight_progress';
      stage: string;
      progress: number;
      detail?: string;
    }
  | { type: 'insight_ready'; path: string }
  | { type: 'insight_error'; error: string };

type InsightSegment =
  | { kind: 'text'; text: string }
  | { kind: 'insight'; data: ParsedInsight };

const INSIGHT_PREFIXES = [
  '"insight_progress":',
  '"insight_ready":',
  '"insight_error":',
];

function parseInsightJson(json: string): ParsedInsight | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const prog = getRecord(parsed['insight_progress']);
    if (
      prog &&
      typeof prog['stage'] === 'string' &&
      typeof prog['progress'] === 'number'
    ) {
      return {
        type: 'insight_progress',
        stage: prog['stage'] as string,
        progress: prog['progress'] as number,
        detail:
          typeof prog['detail'] === 'string'
            ? (prog['detail'] as string)
            : undefined,
      };
    }
    const ready = getRecord(parsed['insight_ready']);
    if (ready && typeof ready['path'] === 'string') {
      return { type: 'insight_ready', path: ready['path'] as string };
    }
    const insightError = getRecord(parsed['insight_error']);
    if (insightError && typeof insightError['error'] === 'string') {
      return { type: 'insight_error', error: insightError['error'] as string };
    }
  } catch {
    // not valid JSON
  }
  return null;
}

// Balanced-braces JSON extractor. Handles string escapes but not standalone
// arrays — sufficient for the insight protocol's object-only payloads.
function extractJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function splitInsightSegments(text: string): InsightSegment[] | null {
  const segments: InsightSegment[] = [];
  let lastIndex = 0;
  let pos = 0;
  let hasInsight = false;

  while (pos < text.length) {
    const braceIdx = text.indexOf('{', pos);
    if (braceIdx === -1) break;

    const afterBrace = text.slice(braceIdx + 1).trimStart();
    const isInsight = INSIGHT_PREFIXES.some((p) => afterBrace.startsWith(p));
    if (!isInsight) {
      pos = braceIdx + 1;
      continue;
    }

    const json = extractJsonObject(text, braceIdx);
    if (!json) {
      pos = braceIdx + 1;
      continue;
    }

    const insight = parseInsightJson(json);
    if (!insight) {
      pos = braceIdx + 1;
      continue;
    }

    hasInsight = true;
    const before = text.slice(lastIndex, braceIdx).trim();
    if (before) {
      segments.push({ kind: 'text', text: before });
    }
    segments.push({ kind: 'insight', data: insight });
    lastIndex = braceIdx + json.length;
    pos = lastIndex;
  }

  if (!hasInsight) return null;

  const after = text.slice(lastIndex).trim();
  if (after) {
    segments.push({ kind: 'text', text: after });
  }

  return segments.length > 0 ? segments : null;
}

function inferToolKind(
  toolName?: string,
  toolKind?: string,
): DaemonMessageToolKind | undefined {
  if (toolKind) return toolKind as DaemonMessageToolKind;
  if (!toolName) return undefined;
  const name = toolName.toLowerCase();
  if (name === 'bash' || name === 'execute') return 'execute';
  if (name === 'read') return 'read';
  if (name === 'edit' || name === 'write') return 'edit';
  if (name.includes('search') || name === 'grep' || name === 'glob')
    return 'search';
  if (name === 'agent' || name === 'task') return 'other';
  return undefined;
}
