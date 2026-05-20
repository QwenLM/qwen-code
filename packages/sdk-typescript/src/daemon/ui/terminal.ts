/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonTranscriptBlock, DaemonUiEvent } from './types.js';
import { sanitizeTerminalText } from './utils.js';

export function daemonUiEventToTerminalText(event: DaemonUiEvent): string {
  switch (event.type) {
    case 'user.text.delta':
      return terminalLine('qwen', event.text, '38;5;42');
    case 'assistant.text.delta':
      return sanitizeTerminalText(event.text).replace(/\r?\n/g, '\r\n');
    case 'assistant.done':
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
