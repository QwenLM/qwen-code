/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonAuthDeviceFlowSdkErrorKind,
  DaemonAuthProviderId,
  DaemonErrorKind,
  DaemonEvent,
} from '../types.js';
import { DAEMON_ERROR_KINDS } from '../types.js';
import type {
  DaemonUiEvent,
  DaemonUiPermissionOption,
  DaemonUiToolProvenance,
  DaemonTurnUsage,
  NormalizeDaemonEventOptions,
} from './types.js';
import { DAEMON_PLAN_TOOL_CALL_ID } from './types.js';
import {
  getFirstString,
  getOutputText,
  getString,
  getTextContent,
  extractContentPart,
  isRecord,
  redactSensitiveFields,
  stringifyJson,
  stringifyRedactedJson,
} from './utils.js';

/**
 * Common base fields stamped on every normalized UI event. Centralized as a
 * type alias so adding new envelope fields (e.g., `serverTimestamp` in PR-B,
 * `traceId` in future) doesn't require touching every normalizer helper.
 */
type NormalizedEventBase = Pick<
  DaemonUiEvent,
  'eventId' | 'serverTimestamp' | 'originatorClientId' | 'rawEvent'
>;

const DAEMON_ERROR_KIND_SET = new Set<string>(DAEMON_ERROR_KINDS);
const DEVICE_FLOW_PROVIDER_SET = new Set<string>(['qwen', 'qwen-oauth']);
const MCP_RESTART_REFUSED_REASONS = new Set<string>([
  'in_flight',
  'disabled',
  'budget_would_exceed',
]);

const MAX_DETAILS_LENGTH = 4096;

export function normalizeDaemonEvent(
  event: DaemonEvent,
  opts: NormalizeDaemonEventOptions = {},
): DaemonUiEvent[] {
  const base = createBase(event, opts);
  switch (event.type) {
    case 'session_update':
      return normalizeSessionUpdate(event, base, opts);
    case 'shell_output': {
      const text = getOutputText(event.data);
      const stream = getShellStream(event.data);
      const source = getSource(event.data);
      return text
        ? [
            {
              ...base,
              type:
                source === 'user-shell' ? 'user.shell.output' : 'shell.output',
              text,
              ...(stream ? { stream } : {}),
            },
          ]
        : [];
    }
    case 'permission_request':
      return normalizePermissionRequest(event, base);
    case 'permission_resolved':
    case 'permission_already_resolved':
      return normalizePermissionResolved(event, base);
    case 'model_switched':
      return [
        {
          ...base,
          type: 'model.changed',
          modelId: getString(event.data, 'modelId') ?? 'unknown',
        },
      ];
    case 'model_switch_failed':
      return [
        {
          ...base,
          type: 'error',
          recoverable: true,
          text:
            getString(event.data, 'error') ??
            'Model switch failed (no details available)',
        },
      ];
    case 'session_died': {
      // Hoist `asDaemonErrorKind` to a const — original
      // double-eval walked the record + Set twice per event.
      const errorKind = asDaemonErrorKind(getString(event.data, 'errorKind'));
      return [
        {
          ...base,
          type: 'error',
          recoverable: false,
          ...(errorKind ? { errorKind } : {}),
          text:
            getString(event.data, 'reason') ??
            'Session died (no details available)',
        },
      ];
    }
    case 'session_closed':
      return [
        {
          ...base,
          type: 'status',
          text: `Session closed: ${getString(event.data, 'reason') ?? 'closed'}`,
        },
      ];
    case 'client_evicted':
      return [
        {
          ...base,
          type: 'error',
          recoverable: true,
          text:
            getString(event.data, 'reason') ??
            'SSE client evicted (no details available)',
        },
      ];
    case 'slow_client_warning':
      return [
        {
          ...base,
          type: 'status',
          text: 'SSE stream is lagging',
        },
      ];
    case 'stream_error': {
      const errorKind = asDaemonErrorKind(getString(event.data, 'errorKind'));
      return [
        {
          ...base,
          type: 'error',
          recoverable: true,
          ...(errorKind ? { errorKind } : {}),
          text:
            getString(event.data, 'error') ??
            'SSE stream error (no details available)',
        },
      ];
    }
    case 'turn_error': {
      const code = getString(event.data, 'code');
      const promptId = getString(event.data, 'promptId');
      return [
        {
          ...base,
          type: 'error',
          source: 'turn_error',
          recoverable: true,
          ...(code ? { code } : {}),
          ...(promptId ? { promptId } : {}),
          text:
            getString(event.data, 'message') ??
            'Prompt failed (no details available)',
        },
      ];
    }
    case 'state_resync_required':
      return normalizeStateResyncRequired(event, base);

    case 'session_rewound':
      return normalizeSessionRewound(event, base);

    case 'session_branched':
      return normalizeSessionBranched(event, base);

    case 'prompt_cancelled': {
      // Forward the optional `reason` (e.g. `'forward_failed'` from the
      // bridge's C3 compensating broadcast) so consumers can distinguish a
      // user cancel from a forward failure.
      const reason = stringField(event.data, 'reason');
      return [
        { ...base, type: 'prompt.cancelled', ...(reason ? { reason } : {}) },
      ];
    }

    case 'followup_suggestion':
      return normalizeFollowupSuggestion(event, base);

    case 'user_shell_command': {
      const command = getString(event.data, 'command');
      const cwd = getString(event.data, 'cwd');
      return command
        ? [
            {
              ...base,
              type: 'user.shell.command',
              command,
              ...(cwd ? { cwd } : {}),
            },
            { ...base, type: 'user.text.delta', text: `$ ${command}` },
          ]
        : [];
    }
    case 'user_shell_result': {
      const exitCode = numberField(event.data, 'exitCode');
      const aborted =
        isRecord(event.data) &&
        (event.data as Record<string, unknown>)['aborted'] === true;
      const text = aborted
        ? 'Shell command was aborted'
        : `Shell command exited with code ${exitCode ?? 'unknown'}`;
      return [{ ...base, type: 'status', text }];
    }

    case 'replay_complete': {
      const replayedCount = numberField(event.data, 'replayedCount') ?? 0;
      // D4: prefer the canonical `lastReplayedEventId`; fall back to the
      // deprecated `lastEventId` alias for daemons predating the rename.
      const lastReplayedEventId =
        numberField(event.data, 'lastReplayedEventId') ??
        numberField(event.data, 'lastEventId');
      return [
        {
          ...base,
          type: 'session.replay_complete',
          replayedCount,
          ...(lastReplayedEventId !== undefined ? { lastReplayedEventId } : {}),
        },
      ];
    }

    // ── Session-meta events ──────────────────────────────────────────────
    case 'session_metadata_updated':
      return normalizeSessionMetadataUpdated(event, base);

    case 'approval_mode_changed':
      return normalizeApprovalModeChanged(event, base);

    // ── Workspace events ──────────────────────────────────────
    case 'memory_changed':
      return normalizeMemoryChanged(event, base);

    case 'agent_changed':
      return normalizeAgentChanged(event, base);

    case 'tool_toggled':
      return normalizeToolToggled(event, base);

    case 'settings_changed':
      return normalizeSettingsChanged(event, base);

    case 'workspace_initialized':
      return normalizeWorkspaceInitialized(event, base);

    case 'mcp_budget_warning':
      return normalizeMcpBudgetWarning(event, base);

    case 'mcp_child_refused_batch':
      return normalizeMcpChildRefused(event, base);

    case 'mcp_server_restarted':
      return normalizeMcpServerRestarted(event, base);

    case 'mcp_server_restart_refused':
      return normalizeMcpServerRestartRefused(event, base);

    case 'extensions_changed':
      return normalizeExtensionsChanged(event, base);

    // ── Auth device-flow events (RFC 8628) ─────────────────
    case 'auth_device_flow_started':
      return normalizeAuthDeviceFlowStarted(event, base);

    case 'auth_device_flow_throttled':
      return normalizeAuthDeviceFlowThrottled(event, base);

    case 'auth_device_flow_authorized':
      return normalizeAuthDeviceFlowAuthorized(event, base);

    case 'auth_device_flow_failed':
      return normalizeAuthDeviceFlowFailed(event, base);

    case 'auth_device_flow_cancelled':
      return normalizeAuthDeviceFlowCancelled(event, base);

    default:
      // Emit a single `debug` block instead
      // of `status + debug`. In long sessions where the daemon adds
      // unknown event types, the doubled block-consumption rate
      // accelerated `maxBlocks` trimming of real content. The `debug`
      // shape already carries the event-type as a prefix, so the
      // status block was redundant. Adapters that want a user-visible
      // banner can pattern-match on `event.type === 'debug'` and the
      // text prefix.
      return [
        {
          ...base,
          type: 'debug',
          text: `${event.type} (unrecognized daemon event): ${stringifyRedactedJson(event.data)}`,
        },
      ];
  }
}

function normalizeStateResyncRequired(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const reason = getString(event.data, 'reason');
  const lastDeliveredId = numberField(event.data, 'lastDeliveredId');
  const earliestAvailableId = numberField(event.data, 'earliestAvailableId');
  if (
    !reason ||
    lastDeliveredId === undefined ||
    earliestAvailableId === undefined
  ) {
    return fallbackDebug(
      event,
      base,
      'malformed state_resync_required payload',
    );
  }
  return [
    {
      ...base,
      type: 'session.state_resync_required',
      reason,
      lastDeliveredId,
      earliestAvailableId,
    },
  ];
}

function normalizeSessionRewound(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const promptId = getString(event.data, 'promptId');
  const targetTurnIndex = numberField(event.data, 'targetTurnIndex');
  if (!promptId || targetTurnIndex === undefined) {
    return fallbackDebug(event, base, 'malformed session_rewound payload');
  }
  const sessionId = getString(event.data, 'sessionId');
  return [
    {
      ...base,
      type: 'session.rewound',
      promptId,
      targetTurnIndex,
      ...(sessionId ? { sessionId } : {}),
    },
  ];
}

function normalizeSessionBranched(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const sourceSessionId = getString(event.data, 'sourceSessionId');
  const newSessionId = getString(event.data, 'newSessionId');
  const displayName = getString(event.data, 'displayName');
  if (!sourceSessionId || !newSessionId || !displayName) {
    return fallbackDebug(event, base, 'malformed session_branched payload');
  }
  return [
    {
      ...base,
      type: 'session.branched',
      sourceSessionId,
      newSessionId,
      displayName,
    },
  ];
}

function normalizeFollowupSuggestion(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const sessionId = getString(event.data, 'sessionId');
  const suggestion = getString(event.data, 'suggestion');
  const promptId = getString(event.data, 'promptId');
  if (!sessionId || !suggestion || !promptId) {
    return fallbackDebug(event, base, 'malformed followup_suggestion payload');
  }
  return [
    {
      ...base,
      type: 'followup.suggestion',
      sessionId,
      suggestion,
      promptId,
    },
  ];
}

function createBase(
  event: DaemonEvent,
  opts: NormalizeDaemonEventOptions,
): NormalizedEventBase {
  const serverTimestamp = extractServerTimestamp(event);
  return {
    ...(event.id !== undefined ? { eventId: event.id } : {}),
    ...(serverTimestamp !== undefined ? { serverTimestamp } : {}),
    ...(event.originatorClientId
      ? { originatorClientId: event.originatorClientId }
      : {}),
    ...(opts.includeRawEvent
      ? { rawEvent: { ...event, data: redactSensitiveFields(event.data) } }
      : {}),
  };
}

/**
 * Extract daemon-authoritative timestamp from envelope. Looks at known
 * candidate locations in order:
 *
 *   1. `event.serverTimestamp` — top-level, preferred when daemon adds it
 *   2. `event._meta.serverTimestamp` — Anthropic-style metadata convention
 *   3. `event.data._meta.serverTimestamp` — sessionUpdate nested location
 *   4. `event.data.update._meta.serverTimestamp|timestamp` — ACP update meta
 *
 * Returns undefined when none of them are present or all are non-finite.
 * Forward-compat: SDK reads whichever location the daemon eventually emits
 * without requiring a coordinated SDK release.
 */
function extractServerTimestamp(event: DaemonEvent): number | undefined {
  const direct = (event as { serverTimestamp?: unknown }).serverTimestamp;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const envelopeMeta = (event as { _meta?: unknown })._meta;
  if (isRecord(envelopeMeta)) {
    const ts = envelopeMeta['serverTimestamp'];
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  }
  if (isRecord(event.data)) {
    const dataMeta = (event.data as Record<string, unknown>)['_meta'];
    if (isRecord(dataMeta)) {
      const ts = dataMeta['serverTimestamp'];
      if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    }
    const update = (event.data as Record<string, unknown>)['update'];
    if (isRecord(update)) {
      const updateMeta = update['_meta'];
      if (isRecord(updateMeta)) {
        const serverTs = updateMeta['serverTimestamp'];
        if (typeof serverTs === 'number' && Number.isFinite(serverTs)) {
          return serverTs;
        }
        const ts = updateMeta['timestamp'];
        if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
      }
    }
  }
  return undefined;
}

function normalizeSessionUpdate(
  event: DaemonEvent,
  base: NormalizedEventBase,
  opts: NormalizeDaemonEventOptions,
): DaemonUiEvent[] {
  const update = getSessionUpdatePayload(event.data);
  if (!update) {
    return [
      {
        ...base,
        type: 'debug',
        text: `session_update: ${stringifyRedactedJson(event.data)}`,
      },
    ];
  }

  const kind = getString(update, 'sessionUpdate');
  switch (kind) {
    case 'user_message_chunk': {
      if (
        opts.suppressOwnUserEcho &&
        opts.clientId &&
        event.originatorClientId === opts.clientId
      ) {
        return [];
      }
      const content = update['content'];
      const part = extractContentPart(content);
      if (part) {
        if (part.kind === 'image') {
          const data = part.source.data;
          let mimeType = part.mediaType || 'image/*';
          if (mimeType === 'image/*' && data) {
            // Strip data: URI prefix if present before magic-byte sniffing
            const rawData = data.startsWith('data:')
              ? (data.split(',')[1] ?? '')
              : data;
            const prefix = rawData.slice(0, 10);
            if (prefix.startsWith('iVBORw0KGg')) mimeType = 'image/png';
            else if (prefix.startsWith('/9j/')) mimeType = 'image/jpeg';
            else if (prefix.startsWith('R0lGOD')) mimeType = 'image/gif';
            else if (prefix.startsWith('UklGR')) mimeType = 'image/webp';
          }
          if (data) {
            return [{ ...base, type: 'user.image.delta', data, mimeType }];
          }
          return [];
        }
        if (part.kind === 'text') {
          return part.text
            ? [{ ...base, type: 'user.text.delta', text: part.text }]
            : [];
        }
        return [];
      }
      const text = getTextContent(content);
      return text ? [{ ...base, type: 'user.text.delta', text }] : [];
    }
    case 'agent_message_chunk': {
      const text = getTextContent(update['content']);
      const parentToolCallId = extractParentToolCallId(update);
      const events: DaemonUiEvent[] = [];
      if (text) {
        events.push({
          ...base,
          type: 'assistant.text.delta' as const,
          text,
          ...(parentToolCallId ? { parentToolCallId } : {}),
        });
      }
      // A turn's per-round token usage rides on an otherwise-empty
      // `agent_message_chunk` (`_meta.usage`, text blank), so this frame is the
      // only carrier — emit it even when there is no assistant text to show.
      const usage = extractAssistantUsage(update);
      if (usage) {
        events.push({
          ...base,
          type: 'assistant.usage' as const,
          usage,
          ...(parentToolCallId ? { parentToolCallId } : {}),
        });
      }
      return events;
    }
    case 'agent_thought_chunk': {
      const text = getTextContent(update['content']);
      if (!text) return [];
      const parentToolCallId = extractParentToolCallId(update);
      return [
        {
          ...base,
          type: 'thought.text.delta' as const,
          text,
          ...(parentToolCallId ? { parentToolCallId } : {}),
        },
      ];
    }
    case 'tool_call':
    case 'tool_call_update':
      return [normalizeToolUpdate(update, base)];
    case 'shell_output':
    case 'tool_output': {
      const text = getOutputText(update);
      const stream = getShellStream(update) ?? getShellStream(event.data);
      const source = getSource(update) ?? getSource(event.data);
      return text
        ? [
            {
              ...base,
              type:
                source === 'user-shell' ? 'user.shell.output' : 'shell.output',
              text,
              ...(stream ? { stream } : {}),
            },
          ]
        : [];
    }
    case 'available_commands_update': {
      const rawCommands = Array.isArray(update['availableCommands'])
        ? update['availableCommands']
        : [];
      const commands = rawCommands.filter(isRecord) as ReadonlyArray<
        Record<string, unknown>
      >;
      return [
        {
          ...base,
          type: 'session.available_commands',
          count: commands.length,
          commands,
        },
      ];
    }
    case 'plan':
      return [normalizePlanUpdate(update, base)];
    case 'current_mode_update':
      return [];
    default:
      return [
        {
          ...base,
          type: 'debug',
          text: `${kind ?? 'session_update'}: ${stringifyRedactedJson(update)}`,
        },
      ];
  }
}

function extractParentToolCallId(
  update: Record<string, unknown>,
): string | undefined {
  const meta = isRecord(update['_meta']) ? update['_meta'] : undefined;
  return meta ? getString(meta, 'parentToolCallId') : undefined;
}

/**
 * Read the token usage the daemon stamps on `agent_message_chunk._meta.usage`.
 * Returns undefined when no usage is present (older agents, non-usage chunks) so
 * the caller emits no `assistant.usage` event; a present-but-partial frame keeps
 * whichever side it has and zero-fills the other.
 */
function extractAssistantUsage(
  update: Record<string, unknown>,
): DaemonTurnUsage | undefined {
  const meta = isRecord(update['_meta']) ? update['_meta'] : undefined;
  const usage = meta && isRecord(meta['usage']) ? meta['usage'] : undefined;
  if (!usage) return undefined;
  const inputTokens = numberField(usage, 'inputTokens');
  const outputTokens = numberField(usage, 'outputTokens');
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  // Cached-read tokens are a subset already counted in inputTokens; carried so
  // renderers can break out the cache hit, not added to the total again.
  const cachedTokens = numberField(usage, 'cachedReadTokens');
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
  };
}

function normalizeToolUpdate(
  update: Record<string, unknown>,
  base: NormalizedEventBase,
): DaemonUiEvent {
  const metadata = isRecord(update['_meta']) ? update['_meta'] : undefined;
  const toolName =
    getString(update, 'toolName') ??
    getString(update, 'name') ??
    (metadata ? getString(metadata, 'toolName') : undefined) ??
    (metadata ? getString(metadata, 'name') : undefined);
  const toolKind = getString(update, 'kind');
  const title = getString(update, 'title') ?? toolName ?? toolKind;
  const rawInputSource =
    update['rawInput'] ?? update['input'] ?? update['args'];
  const rawOutputSource =
    update['rawOutput'] ?? update['output'] ?? update['result'];
  // Redact sensitive fields (apiKey / token / password / etc.) at the
  // normalizer boundary so raw values never reach transcript blocks, terminal
  // details, or downstream UI components.
  const rawInput =
    rawInputSource !== undefined
      ? redactSensitiveFields(rawInputSource)
      : undefined;
  const rawOutput =
    rawOutputSource !== undefined
      ? redactSensitiveFields(rawOutputSource)
      : undefined;
  const content =
    update['content'] !== undefined
      ? redactSensitiveFields(update['content'])
      : undefined;
  const locations =
    update['locations'] !== undefined
      ? redactSensitiveFields(update['locations'])
      : undefined;
  const toolCallId = getString(update, 'toolCallId');
  const status = getString(update, 'status');
  if (!toolCallId) {
    return {
      ...base,
      type: 'error',
      code: 'daemon.protocol.tool_update_missing_tool_call_id',
      recoverable: true,
      text: `Tool update missing toolCallId${title ? ` (${title})` : ''}`,
    };
  }
  const { provenance, serverId } = extractToolProvenance(update, toolName);
  // PR-K (post-rebase): daemon stamps `parentToolCallId` + `subagentType` in
  // `tool_call._meta` when the call was invoked inside a sub-agent
  // delegation (see core's `SubAgentTracker.getSubagentMeta()`). Forward
  // these into the typed UI event so the reducer can correlate sub-agent
  // blocks under their parent for nested rendering. Both undefined for
  // top-level (non-sub-agent) tool calls.
  //
  // Self-reference guard: defensively drop `parentToolCallId === toolCallId`.
  // The daemon should never emit this, but accepting it would make the
  // block its own parent — selectors loop, renderers cycle.
  const rawParentToolCallId =
    getString(update, 'parentToolCallId') ??
    (metadata ? getString(metadata, 'parentToolCallId') : undefined);
  const parentToolCallId =
    rawParentToolCallId && rawParentToolCallId !== toolCallId
      ? rawParentToolCallId
      : undefined;
  const subagentType =
    getString(update, 'subagentType') ??
    (metadata ? getString(metadata, 'subagentType') : undefined);
  return {
    ...base,
    type: 'tool.update',
    toolCallId,
    ...(status ? { status } : {}),
    ...(title ? { title } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolKind ? { toolKind } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(locations !== undefined ? { locations } : {}),
    ...(provenance ? { provenance } : {}),
    ...(serverId ? { serverId } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    ...(rawInput !== undefined
      ? { details: capDetails(stringifyRedactedJson(rawInput)) }
      : rawOutput !== undefined
        ? { details: capDetails(stringifyRedactedJson(rawOutput)) }
        : {}),
  };
}

function normalizePlanUpdate(
  update: Record<string, unknown>,
  base: NormalizedEventBase,
): DaemonUiEvent {
  const entries = Array.isArray(update['entries']) ? update['entries'] : [];
  const contentText = capDetails(formatPlanEntries(entries));
  const planCallId =
    base.eventId !== undefined
      ? `${DAEMON_PLAN_TOOL_CALL_ID}-${base.eventId}`
      : DAEMON_PLAN_TOOL_CALL_ID;
  // Carry the cumulative-usage snapshot the agent stamps on each plan update
  // (PlanEmitter) through to rawOutput, so the web-shell can diff consecutive
  // todo snapshots into per-task token/time detail.
  const meta = isRecord(update['_meta']) ? update['_meta'] : undefined;
  const stats = meta && isRecord(meta['stats']) ? meta['stats'] : undefined;
  return {
    ...base,
    type: 'tool.update',
    toolCallId: planCallId,
    title: 'Updated Plan',
    status: 'completed',
    toolName: 'todo_write',
    toolKind: 'updated_plan',
    content: [
      {
        type: 'content',
        content: { type: 'text', text: contentText },
      },
    ],
    rawOutput: stats ? { entries, stats } : { entries },
  };
}

function formatPlanEntries(entries: readonly unknown[]): string {
  return entries
    .flatMap((entry): string[] => {
      if (!isRecord(entry)) return [];
      const content = getString(entry, 'content');
      if (!content) return [];
      const marker = getPlanEntryMarker(getString(entry, 'status'));
      return [`- [${marker}] ${content}`];
    })
    .join('\n');
}

function getPlanEntryMarker(status: string | undefined): string {
  switch (status) {
    case 'completed':
      return 'x';
    case 'in_progress':
      return '-';
    default:
      return ' ';
  }
}

/**
 * Pull `provenance` + `serverId` from the tool update payload, falling back
 * to the `mcp__<serverId>__<tool>` naming convention when the daemon
 * doesn't stamp the fields explicitly. Returns `undefined` for both when
 * provenance is genuinely unknown — UI defaults to `'unknown'` in that case.
 */
function extractToolProvenance(
  update: Record<string, unknown>,
  toolName: string | undefined,
): {
  provenance?: DaemonUiToolProvenance;
  serverId?: string;
} {
  const explicit = getString(update, 'provenance');
  const explicitServerId = getString(update, 'serverId');
  if (explicit === 'builtin' || explicit === 'mcp' || explicit === 'subagent') {
    return {
      provenance: explicit,
      ...(explicit === 'mcp' && explicitServerId
        ? { serverId: explicitServerId }
        : {}),
    };
  }
  // Heuristic fallback: MCP server tools follow `mcp__<serverId>__<tool>`.
  if (toolName && toolName.startsWith('mcp__')) {
    const rest = toolName.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep > 0) {
      return { provenance: 'mcp', serverId: rest.slice(0, sep) };
    }
  }
  return {};
}

function asDaemonErrorKind(
  value: string | undefined,
): DaemonErrorKind | undefined {
  if (!value) return undefined;
  return DAEMON_ERROR_KIND_SET.has(value)
    ? (value as DaemonErrorKind)
    : undefined;
}

function capDetails(details: string): string {
  if (details.length <= MAX_DETAILS_LENGTH) return details;
  return `${details.slice(0, MAX_DETAILS_LENGTH)}... [truncated]`;
}

function normalizePermissionRequest(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  if (!isRecord(event.data)) {
    return [
      {
        ...base,
        type: 'debug',
        text: `permission_request: ${stringifyRedactedJson(event.data)}`,
      },
    ];
  }

  const requestId = getString(event.data, 'requestId');
  if (!requestId) {
    return [
      {
        ...base,
        type: 'debug',
        text: `permission_request: ${stringifyRedactedJson(event.data)}`,
      },
    ];
  }

  const toolCall =
    event.data['toolCall'] !== undefined
      ? redactSensitiveFields(event.data['toolCall'])
      : undefined;

  return [
    {
      ...base,
      type: 'permission.request',
      requestId,
      sessionId: getString(event.data, 'sessionId'),
      title: describeToolCall(toolCall),
      options: normalizePermissionOptions(event.data['options']),
      toolCall,
    },
  ];
}

function normalizePermissionResolved(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const requestId = getString(event.data, 'requestId');
  if (!requestId) {
    return [
      {
        ...base,
        type: 'debug',
        text: `${event.type}: ${stringifyRedactedJson(event.data)}`,
      },
    ];
  }
  // A4: the canonical voter is `data.voterClientId`; fall back to the
  // envelope `originatorClientId` (deprecated alias) for daemons predating
  // the rename. Both may be absent for no-voter resolutions (timer /
  // session-closed). `originatorClientId` stays on the base unchanged.
  const voterClientId =
    getString(event.data, 'voterClientId') ?? base.originatorClientId;
  return [
    {
      ...base,
      type: 'permission.resolved',
      requestId,
      outcome: describePermissionOutcome(event.data),
      ...(voterClientId ? { voterClientId } : {}),
    },
  ];
}

export function getSessionUpdatePayload(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const update = value['update'];
  return isRecord(update) ? update : value;
}

function normalizePermissionOptions(
  value: unknown,
): DaemonUiPermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option): DaemonUiPermissionOption[] => {
    if (!isRecord(option)) return [];
    const optionId = getString(option, 'optionId');
    if (!optionId) return [];
    return [
      {
        optionId,
        label:
          getString(option, 'label') ??
          getString(option, 'title') ??
          getString(option, 'name') ??
          optionId,
        ...(getString(option, 'description')
          ? { description: getString(option, 'description') }
          : {}),
        raw: option,
      },
    ];
  });
}

function describePermissionOutcome(value: unknown): string {
  if (!isRecord(value)) return stringifyJson(value);
  const outcome = value['outcome'];
  if (typeof outcome === 'string') return outcome;
  if (isRecord(outcome)) {
    const kind = getString(outcome, 'outcome') ?? 'selected';
    const optionId = getString(outcome, 'optionId');
    return optionId ? `${kind}:${optionId}` : kind;
  }
  return getFirstString(value, ['status', 'reason']) ?? stringifyJson(value);
}

function describeToolCall(value: unknown): string {
  if (!isRecord(value)) return 'Tool permission';
  return (
    getString(value, 'title') ??
    getString(value, 'name') ??
    getString(value, 'kind') ??
    getString(value, 'toolName') ??
    'Tool permission'
  );
}

function getShellStream(value: unknown): 'stdout' | 'stderr' | undefined {
  const stream = getString(value, 'stream');
  return stream === 'stdout' || stream === 'stderr' ? stream : undefined;
}

function getSource(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = getString(value, 'source');
  if (direct) return direct;
  const meta = value['_meta'];
  return isRecord(meta) ? getString(meta, 'source') : undefined;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Session-meta + workspace + auth normalizers
 *
 * Each daemon event with a closed-shape `data` interface in `events.ts` gets
 * its own normalizer that validates required fields and emits a typed UI
 * event. Events with invalid payloads fall through to a `debug` text — UI
 * never silently drops a known event type, but malformed data is surfaced
 * for operator triage.
 * ──────────────────────────────────────────────────────────────────────── */

function fallbackDebug(
  event: DaemonEvent,
  base: NormalizedEventBase,
  reason: string,
): DaemonUiEvent[] {
  return [
    {
      ...base,
      type: 'debug',
      text: `${event.type}: ${reason}`,
    },
  ];
}

function normalizeSessionMetadataUpdated(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const sessionId = getString(event.data, 'sessionId');
  if (!sessionId) return fallbackDebug(event, base, 'missing sessionId');
  const displayName = getString(event.data, 'displayName');
  return [
    {
      ...base,
      type: 'session.metadata.changed',
      sessionId,
      ...(displayName !== undefined ? { displayName } : {}),
    },
  ];
}

function normalizeApprovalModeChanged(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const sessionId = getString(event.data, 'sessionId');
  const previous = getString(event.data, 'previous');
  const next = getString(event.data, 'next');
  if (!sessionId || !previous || !next) {
    return fallbackDebug(event, base, 'missing sessionId / previous / next');
  }
  const persisted =
    isRecord(event.data) && typeof event.data['persisted'] === 'boolean'
      ? (event.data['persisted'] as boolean)
      : false;
  return [
    {
      ...base,
      type: 'session.approval_mode.changed',
      sessionId,
      previous,
      next,
      persisted,
    },
  ];
}

function normalizeMemoryChanged(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const scope = getString(event.data, 'scope');
  const filePath = getString(event.data, 'filePath');
  const mode = getString(event.data, 'mode');
  // Use the `numberField` helper so NaN /
  // Infinity are rejected — every other numeric field in the normalizer
  // already routes through it. A daemon emitting `bytesWritten: NaN`
  // would otherwise propagate to renderers as `+NaNb`.
  const bytesWritten = numberField(
    isRecord(event.data) ? event.data : undefined,
    'bytesWritten',
  );
  if (
    (scope !== 'workspace' && scope !== 'global') ||
    !filePath ||
    (mode !== 'append' && mode !== 'replace') ||
    bytesWritten === undefined
  ) {
    return fallbackDebug(event, base, 'malformed memory_changed payload');
  }
  return [
    {
      ...base,
      type: 'workspace.memory.changed',
      scope,
      filePath,
      mode,
      bytesWritten,
    },
  ];
}

function normalizeAgentChanged(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const change = getString(event.data, 'change');
  const name = getString(event.data, 'name');
  const level = getString(event.data, 'level');
  if (
    (change !== 'created' && change !== 'updated' && change !== 'deleted') ||
    !name ||
    (level !== 'project' && level !== 'user')
  ) {
    return fallbackDebug(event, base, 'malformed agent_changed payload');
  }
  return [
    {
      ...base,
      type: 'workspace.agent.changed',
      change,
      name,
      level,
    },
  ];
}

function normalizeToolToggled(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const toolName = getString(event.data, 'toolName');
  const enabled =
    isRecord(event.data) && typeof event.data['enabled'] === 'boolean'
      ? (event.data['enabled'] as boolean)
      : undefined;
  if (!toolName || enabled === undefined) {
    return fallbackDebug(event, base, 'malformed tool_toggled payload');
  }
  return [
    {
      ...base,
      type: 'workspace.tool.toggled',
      toolName,
      enabled,
    },
  ];
}

function normalizeSettingsChanged(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const key = getString(event.data, 'key');
  const scope = getString(event.data, 'scope');
  if (!key) {
    return fallbackDebug(event, base, 'malformed settings_changed payload');
  }
  return [
    {
      ...base,
      type: 'workspace.settings.changed',
      key,
      scope: scope ?? 'workspace',
      value: isRecord(event.data) ? event.data['value'] : undefined,
    },
  ];
}

function normalizeWorkspaceInitialized(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const path = getString(event.data, 'path');
  const action = getString(event.data, 'action');
  if (
    !path ||
    (action !== 'created' && action !== 'overwrote' && action !== 'noop')
  ) {
    return fallbackDebug(
      event,
      base,
      'malformed workspace_initialized payload',
    );
  }
  return [{ ...base, type: 'workspace.initialized', path, action }];
}

function normalizeMcpBudgetWarning(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  if (!isRecord(event.data)) {
    return fallbackDebug(event, base, 'non-object payload');
  }
  const liveCount = numberField(event.data, 'liveCount');
  const reservedCount = numberField(event.data, 'reservedCount');
  const budget = numberField(event.data, 'budget');
  const thresholdRatio = numberField(event.data, 'thresholdRatio');
  const mode = getString(event.data, 'mode');
  if (
    liveCount === undefined ||
    reservedCount === undefined ||
    budget === undefined ||
    thresholdRatio === undefined ||
    (mode !== 'warn' && mode !== 'enforce')
  ) {
    return fallbackDebug(event, base, 'malformed mcp_budget_warning payload');
  }
  return [
    {
      ...base,
      type: 'workspace.mcp.budget_warning',
      liveCount,
      reservedCount,
      budget,
      thresholdRatio,
      mode,
    },
  ];
}

function normalizeMcpChildRefused(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  if (!isRecord(event.data)) {
    return fallbackDebug(event, base, 'non-object payload');
  }
  const refusedServers = Array.isArray(event.data['refusedServers'])
    ? (event.data['refusedServers'] as unknown[])
        .filter(isRecord)
        .map((s) => {
          const name = getString(s, 'name');
          const transport = getString(s, 'transport');
          const reason = getString(s, 'reason');
          if (!name || !transport || reason !== 'budget_exhausted') return null;
          return {
            name,
            transport,
            reason: 'budget_exhausted' as const,
          };
        })
        .filter(
          (
            v,
          ): v is {
            name: string;
            transport: string;
            reason: 'budget_exhausted';
          } => v !== null,
        )
    : [];
  const budget = numberField(event.data, 'budget');
  const liveCount = numberField(event.data, 'liveCount');
  const reservedCount = numberField(event.data, 'reservedCount');
  if (
    refusedServers.length === 0 ||
    budget === undefined ||
    liveCount === undefined ||
    reservedCount === undefined
  ) {
    return fallbackDebug(
      event,
      base,
      'malformed mcp_child_refused_batch payload',
    );
  }
  return [
    {
      ...base,
      type: 'workspace.mcp.child_refused',
      refusedServers,
      budget,
      liveCount,
      reservedCount,
    },
  ];
}

function normalizeMcpServerRestarted(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const serverName = getString(event.data, 'serverName');
  const durationMs = numberField(event.data, 'durationMs');
  if (!serverName || durationMs === undefined) {
    return fallbackDebug(event, base, 'malformed mcp_server_restarted payload');
  }
  return [
    {
      ...base,
      type: 'workspace.mcp.server_restarted',
      serverName,
      durationMs,
    },
  ];
}

function normalizeMcpServerRestartRefused(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const serverName = getString(event.data, 'serverName');
  const reason = getString(event.data, 'reason');
  if (!serverName || !reason || !MCP_RESTART_REFUSED_REASONS.has(reason)) {
    return fallbackDebug(
      event,
      base,
      'malformed mcp_server_restart_refused payload',
    );
  }
  return [
    {
      ...base,
      type: 'workspace.mcp.server_restart_refused',
      serverName,
      reason: reason as 'in_flight' | 'disabled' | 'budget_would_exceed',
    },
  ];
}

function normalizeExtensionsChanged(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const refreshed = numberField(event.data, 'refreshed');
  const failed = numberField(event.data, 'failed');
  const status = getString(event.data, 'status');
  const source = getString(event.data, 'source');
  const name = getString(event.data, 'name');
  const version = getString(event.data, 'version');
  const error = getString(event.data, 'error');
  if (refreshed === undefined || failed === undefined) {
    return fallbackDebug(event, base, 'malformed extensions_changed payload');
  }
  if (
    status !== undefined &&
    status !== 'installed' &&
    status !== 'enabled' &&
    status !== 'disabled' &&
    status !== 'updated' &&
    status !== 'uninstalled' &&
    status !== 'failed'
  ) {
    return fallbackDebug(event, base, 'malformed extensions_changed payload');
  }
  return [
    {
      ...base,
      type: 'workspace.extensions.changed',
      refreshed,
      failed,
      ...(status ? { status } : {}),
      ...(source ? { source } : {}),
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(error ? { error } : {}),
    },
  ];
}

function normalizeAuthDeviceFlowStarted(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const deviceFlowId = getString(event.data, 'deviceFlowId');
  const providerId = getString(event.data, 'providerId');
  const expiresAt = numberField(event.data, 'expiresAt');
  if (
    !deviceFlowId ||
    !providerId ||
    !DEVICE_FLOW_PROVIDER_SET.has(providerId) ||
    expiresAt === undefined
  ) {
    return fallbackDebug(
      event,
      base,
      'malformed auth_device_flow_started payload',
    );
  }
  return [
    {
      ...base,
      type: 'auth.device_flow.started',
      deviceFlowId,
      providerId: providerId as DaemonAuthProviderId,
      expiresAt,
    },
  ];
}

function normalizeAuthDeviceFlowThrottled(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const deviceFlowId = getString(event.data, 'deviceFlowId');
  const intervalMs = numberField(event.data, 'intervalMs');
  if (!deviceFlowId || intervalMs === undefined) {
    return fallbackDebug(
      event,
      base,
      'malformed auth_device_flow_throttled payload',
    );
  }
  return [
    {
      ...base,
      type: 'auth.device_flow.throttled',
      deviceFlowId,
      intervalMs,
    },
  ];
}

function normalizeAuthDeviceFlowAuthorized(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const deviceFlowId = getString(event.data, 'deviceFlowId');
  const providerId = getString(event.data, 'providerId');
  if (
    !deviceFlowId ||
    !providerId ||
    !DEVICE_FLOW_PROVIDER_SET.has(providerId)
  ) {
    return fallbackDebug(
      event,
      base,
      'malformed auth_device_flow_authorized payload',
    );
  }
  const expiresAt = numberField(event.data, 'expiresAt');
  const accountAlias = getString(event.data, 'accountAlias');
  return [
    {
      ...base,
      type: 'auth.device_flow.authorized',
      deviceFlowId,
      providerId: providerId as DaemonAuthProviderId,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(accountAlias ? { accountAlias } : {}),
    },
  ];
}

function normalizeAuthDeviceFlowFailed(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const deviceFlowId = getString(event.data, 'deviceFlowId');
  const errorKind = getString(event.data, 'errorKind');
  if (!deviceFlowId || !isDeviceFlowErrorKind(errorKind)) {
    return fallbackDebug(
      event,
      base,
      'malformed auth_device_flow_failed payload',
    );
  }
  const hint = getString(event.data, 'hint');
  return [
    {
      ...base,
      type: 'auth.device_flow.failed',
      deviceFlowId,
      errorKind,
      ...(hint ? { hint } : {}),
    },
  ];
}

/**
 * Known closed-set of `DaemonAuthDeviceFlowErrorKind` values, exported as
 * documentation of the canonical kinds the daemon emits today.
 *
 * Both reviewers noted that the
 * suggested strict validation against this set. We intentionally keep
 * lenient pass-through — the public type
 * `DaemonAuthDeviceFlowSdkErrorKind` explicitly includes `(string & {})`
 * as a forward-compat escape hatch so future daemon emissions of new
 * kinds remain typed-acceptable AND propagate end-to-end without an SDK
 * release. The existing test `keeps future auth_device_flow_failed
 * errorKind values observable` enforces this contract.
 *
 * Downstream consumers `switch(errorKind)` exhaustively MUST include a
 * `default:` arm for the open `(string & {})` case — the typed
 * known-set arms cover the listed kinds. The known set is referenced
 * here in code only so it surfaces in IDE hovers / type-doc tooling.
 */
export const KNOWN_DEVICE_FLOW_ERROR_KINDS = [
  'expired_token',
  'access_denied',
  'invalid_grant',
  'upstream_error',
  'persist_failed',
  'not_found_or_evicted',
] as const satisfies readonly DaemonAuthDeviceFlowSdkErrorKind[];

function isDeviceFlowErrorKind(
  value: unknown,
): value is DaemonAuthDeviceFlowSdkErrorKind {
  // Lenient pass-through. See `KNOWN_DEVICE_FLOW_ERROR_KINDS` above for
  // the canonical set; the `(string & {})` arm of the public type
  // tolerates anything else for forward-compat.
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeAuthDeviceFlowCancelled(
  event: DaemonEvent,
  base: NormalizedEventBase,
): DaemonUiEvent[] {
  const deviceFlowId = getString(event.data, 'deviceFlowId');
  if (!deviceFlowId) {
    return fallbackDebug(
      event,
      base,
      'malformed auth_device_flow_cancelled payload',
    );
  }
  return [{ ...base, type: 'auth.device_flow.cancelled', deviceFlowId }];
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
