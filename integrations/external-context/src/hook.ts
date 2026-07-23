/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { sanitizeAutoRecallQuery, renderExternalContext } from './context.js';
import { isInsideRepository, loadConfig } from './config.js';
import { createProvider } from './providers.js';
import { observeProviderOperation, withProviderTimeout } from './runtime.js';
import type { ExternalContextConfig, ProviderBinding } from './types.js';

const REMEMBER_TOOL = 'mcp__external-context__context_remember';
const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

interface HookInput {
  hook_event_name?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  tool_name?: unknown;
}

interface HookOutput {
  continue: true;
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse' | 'UserPromptSubmit';
    permissionDecision?: 'ask';
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

const ALLOW: HookOutput = { continue: true };

export async function handleHookInput(
  candidate: unknown,
  load: () => Promise<ExternalContextConfig> = loadConfig,
  bind: (
    config: ExternalContextConfig['provider'],
  ) => ProviderBinding = createProvider,
): Promise<HookOutput> {
  if (!isHookInput(candidate)) {
    return ALLOW;
  }
  const input = candidate;
  if (
    input.hook_event_name === 'PreToolUse' &&
    input.tool_name === REMEMBER_TOOL
  ) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason:
          'Confirm writing shared repository memory to the external provider.',
      },
    };
  }

  if (
    input.hook_event_name !== 'UserPromptSubmit' ||
    typeof input.prompt !== 'string' ||
    typeof input.cwd !== 'string'
  ) {
    return ALLOW;
  }

  try {
    const config = await load();
    if (
      !config.autoRecall.enabled ||
      !(await isInsideRepository(config.repositoryRoot, input.cwd))
    ) {
      return ALLOW;
    }
    const query = sanitizeAutoRecallQuery(input.prompt);
    if (!query) {
      return ALLOW;
    }

    const binding = bind(config.provider);
    const items = await observeProviderOperation({
      binding,
      operation: 'auto_recall',
      execute: () =>
        withProviderTimeout(config.autoRecall.timeoutMs, (signal) =>
          binding.provider.search({ query, limit: 5, signal }),
        ),
      count: (result) => result.length,
    });
    const additionalContext = renderExternalContext(items);
    if (!additionalContext) {
      return ALLOW;
    }
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    };
  } catch {
    return ALLOW;
  }
}

export async function runHook(): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.stdout.write(JSON.stringify(ALLOW));
    return;
  }
  const output = await handleHookInput(input);
  process.stdout.write(JSON.stringify(output));
}

function isHookInput(value: unknown): value is HookInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_HOOK_INPUT_BYTES) {
      throw new Error('Hook input is too large.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
