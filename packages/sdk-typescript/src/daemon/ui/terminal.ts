/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonTranscriptBlock, DaemonUiEvent } from './types.js';
import { formatMissedRange } from './transcript.js';
import { sanitizeTerminalText } from './utils.js';

export function daemonUiEventToTerminalText(event: DaemonUiEvent): string {
  switch (event.type) {
    case 'user.text.delta':
      return terminalLine('qwen', event.text, '38;5;42');
    case 'assistant.text.delta':
      return sanitizeTerminalText(event.text).replace(/\r?\n/g, '\r\n');
    case 'assistant.done':
      return '';
    case 'assistant.usage':
      // Metadata only (token counts); no transcript line to render.
      return '';
    case 'thought.text.delta':
      return terminalLine('thought', event.text, '2');
    case 'tool.update':
      return terminalLine(
        `tool ${event.status}`,
        `${event.title}${event.details ? ` ${event.details}` : ''}`,
        '38;5;75',
      );
    case 'shell.output':
      return terminalBlock('shell', event.text, '38;5;244');
    case 'user.shell.output':
      return terminalBlock('user-shell', event.text, '38;5;244');
    case 'permission.request': {
      const options = event.options.map((option) => option.label).join(' / ');
      return terminalLine(
        'permission',
        `${event.title}${options ? ` [${options}]` : ''}`,
        '33',
      );
    }
    case 'permission.resolved':
      return terminalLine('permission', event.outcome, '33');
    case 'model.changed':
      return terminalLine('model', event.modelId, '36');
    case 'status':
    case 'debug':
      return terminalLine(event.type, event.text, '2');
    case 'error':
      return terminalLine('error', event.text, '31');
    // Session-meta / workspace / auth events: emit a short structured line
    // in terminal mode so they show up in tail-style debug, but do not
    // flood the terminal with full payloads. UI clients with richer
    // surfaces (web / IDE) consume the typed events directly.
    case 'session.metadata.changed':
      return terminalLine(
        'session',
        `metadata: ${event.displayName ?? '(no display name)'}`,
        '36',
      );
    case 'session.approval_mode.changed':
      return terminalLine(
        'approval-mode',
        `${event.previous} → ${event.next}${event.persisted ? ' (persisted)' : ''}`,
        '36',
      );
    case 'session.available_commands':
      return terminalLine('commands', `available ${event.count}`, '2');
    case 'session.state_resync_required':
      // wenshao R5 (deepseek-v4-pro): reuse the exported formatter from
      // transcript.ts so the two sites can't silently diverge.
      return terminalLine(
        'resync-required',
        `${event.reason}: ${formatMissedRange(event.lastDeliveredId, event.earliestAvailableId)}`,
        '31',
      );
    case 'session.replay_complete':
      return terminalLine(
        'replay-complete',
        `caught up (${event.replayedCount} replayed)`,
        '2',
      );
    case 'session.rewound':
      return terminalLine(
        'rewound',
        `${event.promptId} → turn ${event.targetTurnIndex}`,
        '2',
      );
    case 'session.branched':
      return terminalLine(
        'branched',
        `${event.sourceSessionId} → ${event.newSessionId} (${event.displayName})`,
        '2',
      );
    case 'prompt.cancelled':
      return terminalLine('cancelled', 'prompt cancelled', '33');
    case 'followup.suggestion':
      // Daemon assist push — useful in debug-style terminal tails but not
      // rendered as a first-class UI affordance here (terminals don't have
      // a notion of input-placeholder ghost text). Web / TUI adapters
      // consume the typed event directly.
      return terminalLine('suggestion', event.suggestion, '2');
    case 'workspace.memory.changed':
      return terminalLine(
        'memory',
        `${event.mode} ${event.scope} ${event.filePath} +${event.bytesWritten}b`,
        '36',
      );
    case 'workspace.agent.changed':
      return terminalLine(
        'agent',
        `${event.change} ${event.level}/${event.name}`,
        '36',
      );
    case 'workspace.tool.toggled':
      return terminalLine(
        'tool',
        `${event.toolName} ${event.enabled ? 'enabled' : 'disabled'}`,
        '36',
      );
    case 'workspace.settings.changed':
      return terminalLine(
        'settings',
        `${event.key} changed (scope: ${event.scope})`,
        '36',
      );
    case 'workspace.initialized':
      return terminalLine(
        'workspace',
        `init ${event.action} ${event.path}`,
        '36',
      );
    case 'workspace.mcp.budget_warning':
      return terminalLine(
        'mcp',
        `${event.mode}: ${event.liveCount}/${event.budget} (${Math.round(
          event.thresholdRatio * 100,
        )}% threshold)`,
        '33',
      );
    case 'workspace.mcp.child_refused':
      return terminalLine(
        'mcp',
        `refused ${event.refusedServers.length} servers (budget ${event.budget})`,
        '31',
      );
    case 'workspace.mcp.server_restarted':
      return terminalLine(
        'mcp',
        `${event.serverName} restarted in ${event.durationMs}ms`,
        '36',
      );
    case 'workspace.mcp.server_restart_refused':
      return terminalLine(
        'mcp',
        `${event.serverName} restart refused: ${event.reason}`,
        '33',
      );
    case 'workspace.extensions.changed':
      if (event.status === 'failed') {
        return terminalLine(
          'ext',
          `extension action failed${
            event.name
              ? ` ${event.name}`
              : event.source
                ? ` ${event.source}`
                : ''
          }: ${event.error ?? 'unknown error'}`,
          '31',
        );
      }
      if (event.status === 'installed') {
        return terminalLine(
          'ext',
          `installed ${event.name ?? event.source ?? 'extension'}${
            event.version ? ` v${event.version}` : ''
          } (${event.refreshed} refreshed, ${event.failed} failed)`,
          '36',
        );
      }
      return terminalLine(
        'ext',
        `extensions refreshed (${event.refreshed} ok, ${event.failed} failed)`,
        '36',
      );
    case 'auth.device_flow.started':
      return terminalLine(
        'auth',
        `${event.providerId} device-flow started (${event.deviceFlowId})`,
        '36',
      );
    case 'auth.device_flow.throttled':
      return terminalLine(
        'auth',
        `device-flow throttled, retry after ${event.intervalMs}ms`,
        '33',
      );
    case 'auth.device_flow.authorized':
      return terminalLine(
        'auth',
        `${event.providerId} authorized${event.accountAlias ? ` as ${event.accountAlias}` : ''}`,
        '32',
      );
    case 'auth.device_flow.failed':
      return terminalLine(
        'auth',
        `device-flow failed: ${event.errorKind}${event.hint ? ` (${event.hint})` : ''}`,
        '31',
      );
    case 'auth.device_flow.cancelled':
      return terminalLine(
        'auth',
        `device-flow cancelled (${event.deviceFlowId})`,
        '2',
      );
    case 'user.shell.command':
      return '';
    case 'user.image.delta':
      return `[image: ${sanitizeTerminalText(event.mimeType)}]`;
    default:
      return assertNever(event);
  }
}

export function transcriptBlockToTerminalText(
  block: DaemonTranscriptBlock,
): string {
  switch (block.kind) {
    case 'user':
      return terminalLine('qwen', block.text, '38;5;42');
    case 'assistant':
      return sanitizeTerminalText(block.text).replace(/\r?\n/g, '\r\n');
    case 'thought':
      return terminalLine('thought', block.text, '2');
    case 'tool':
      return terminalLine(
        `tool ${block.status}`,
        `${block.title}${block.details ? ` ${block.details}` : ''}`,
        '38;5;75',
      );
    case 'shell':
      return terminalBlock('shell', block.text, '38;5;244');
    case 'user_shell':
      return terminalBlock(
        `shell command ${block.command}`.trim(),
        block.text,
        '38;5;244',
      );
    case 'permission': {
      const options = block.options.map((option) => option.label).join(' / ');
      const suffix = block.resolved ? ` resolved=${block.resolved}` : '';
      return terminalLine(
        'permission',
        `${block.title}${options ? ` [${options}]` : ''}${suffix}`,
        '33',
      );
    }
    case 'status':
    case 'debug':
      return terminalLine(block.kind, block.text, '2');
    case 'error':
      return terminalLine('error', block.text, '31');
    case 'prompt_cancelled':
      return terminalLine('cancelled', 'prompt cancelled', '33');
    default:
      return assertNever(block);
  }
}

function assertNever(value: never): string {
  const variant = value as { kind?: unknown; type?: unknown };
  const name =
    typeof variant.type === 'string'
      ? variant.type
      : typeof variant.kind === 'string'
        ? variant.kind
        : 'unknown';
  return terminalLine(
    'error',
    `Unhandled daemon terminal event: ${name}`,
    '31',
  );
}

function terminalLine(label: string, text: string, sgr: string): string {
  return `\r\n${terminalLabel(label, sgr)}${sanitizeTerminalText(text).replace(/\r?\n/g, '\r\n')}\r\n`;
}

function terminalBlock(label: string, text: string, sgr: string): string {
  if (!text) return '';
  return `\r\n${terminalLabel(label, sgr)}${sanitizeTerminalText(text).replace(/\r?\n/g, '\r\n')}\r\n`;
}

function terminalLabel(label: string, sgr: string): string {
  return `\x1b[${sgr}m${sanitizeTerminalText(label)}>\x1b[0m `;
}
