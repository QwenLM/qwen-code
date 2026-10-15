/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isValidMemoryContent,
  renderMemoryContentForConfirmation,
} from './memory-content.js';

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const REMEMBER_TOOL_NAME = 'mcp__external-context__context_remember';
const ASK_PERMISSION_MODES = new Set([
  'default',
  'auto',
  'auto_edit',
  'auto-edit',
  'yolo',
]);

interface HookDecisionOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'ask' | 'deny';
    permissionDecisionReason: string;
  };
}

type HookOutput = HookDecisionOutput | Record<string, never>;

type HookInputStream = AsyncIterable<string | Uint8Array> & {
  destroy?(): void;
};

interface HookOutputStream {
  write(value: string): unknown;
}

export function runWriteConfirmation(value: unknown): HookOutput {
  if (!isRecord(value)) {
    return denyInvalid();
  }
  if (
    value['hook_event_name'] !== 'PreToolUse' ||
    value['tool_name'] !== REMEMBER_TOOL_NAME
  ) {
    return {};
  }
  const toolInput = value['tool_input'];
  const permissionMode = value['permission_mode'];
  if (
    typeof permissionMode !== 'string' ||
    !isRecord(toolInput) ||
    typeof toolInput['content'] !== 'string' ||
    !isValidMemoryContent(toolInput['content'])
  ) {
    return denyInvalid();
  }
  if (permissionMode === 'plan') {
    return deny('External context memory writes are not allowed in plan mode.');
  }
  if (!ASK_PERMISSION_MODES.has(permissionMode)) {
    return deny(
      'External context memory write permission mode is unsupported.',
    );
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason:
        'Save this exact content to the bound Mem0 repository memory?\n' +
        renderMemoryContentForConfirmation(toolInput['content']),
    },
  };
}

export async function runWriteConfirmationCli(
  inputStream: HookInputStream = process.stdin,
  outputStream: HookOutputStream = process.stdout,
): Promise<void> {
  const input = await readHookInput(inputStream).catch(() => undefined);
  outputStream.write(JSON.stringify(runWriteConfirmation(input)));
}

function denyInvalid(): HookDecisionOutput {
  return deny('External context memory write confirmation request is invalid.');
}

function deny(reason: string): HookDecisionOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

async function readHookInput(
  inputStream: HookInputStream,
): Promise<unknown | undefined> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const source of inputStream) {
    const chunk = Buffer.from(source);
    total += chunk.byteLength;
    if (total > MAX_HOOK_INPUT_BYTES) {
      inputStream.destroy?.();
      return undefined;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function isDirectEntryPoint(): Promise<boolean> {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) {
    return false;
  }
  try {
    return (
      (await realpath(fileURLToPath(import.meta.url))) ===
      (await realpath(resolve(entryPoint)))
    );
  } catch {
    return false;
  }
}

if (await isDirectEntryPoint()) {
  try {
    await runWriteConfirmationCli();
  } catch {
    process.exitCode = 1;
  }
}
