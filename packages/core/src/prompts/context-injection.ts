/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 上下文注入机制
 *
 * - prependUserContext()   : 将 context files / currentDate 注入为第一条用户消息
 *
 * 参考：system-prompts/system-prompt-assembly.md §9
 */

import type { Message } from '../protocol/transcript/message.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import type { Config } from '../config/config.js';

export function createStartupMemoryContext(
  config: Config,
): Readonly<Record<string, string>> | undefined {
  const loadedNativeMemoryContext = config
    .getMemoryContextManager?.()
    ?.getUserContext();
  const nativeMemoryContext = config.shouldSuppressNativeAutoMemoryForSdk?.()
    ? Object.fromEntries(
        Object.entries(loadedNativeMemoryContext ?? {}).filter(
          ([key]) => key !== 'autoMemory',
        ),
      )
    : loadedNativeMemoryContext;
  const sdkMemoryContext = config.getSdkMemoryContext?.();
  if (!nativeMemoryContext && !sdkMemoryContext) return undefined;
  return Object.freeze({ ...nativeMemoryContext, ...sdkMemoryContext });
}

// ---------------------------------------------------------------------------
// User context（注入为第一条用户消息）
// ---------------------------------------------------------------------------

/**
 * 将 userContext（如上下文文件、currentDate）注入为第一条用户消息。
 *
 * 格式：
 * ```
 * <system-reminder>
 * As you answer the user's questions, you can use the following context:
 * # currentDate
 * Today's date is 2026-04-14.
 *
 *       IMPORTANT: this context may or may not be relevant to your tasks...
 * </system-reminder>
 * ```
 *
 * 注入发生在 runtime Message[] 层，之后统一交给 normalizeMessagesForAPI()
 * 处理相邻 user message 合并，与 reference 的 prependUserContext 路径一致。
 */
export function prependUserContext(
  messages: readonly Message[],
  context: Readonly<Record<string, string>>,
): Message[] {
  const entries = Object.entries(context);
  if (entries.length === 0) return Array.from(messages);

  return [
    createUserMessage(renderUserContextText(context), { isMeta: true }),
    ...messages,
  ];
}

/**
 * Materialize the exact ephemeral runtime prefix used for startup memory.
 *
 * Keep this prefix as messages, rather than rebuilding it from Config inside
 * forked consumers, so the parent request and every cache-sharing fork project
 * the same bytes through normalizeMessagesForAPI().
 */
export function buildStartupMemoryPrefix(
  context: Readonly<Record<string, string>> | undefined,
): Message[] {
  return context ? prependUserContext([], context) : [];
}

/**
 * Render the exact user-context wrapper sent to the model.
 *
 * The renderer is also used to measure the incremental prompt cost of
 * auto-memory without maintaining a second copy of the wrapper template.
 */
export function renderUserContextText(
  context: Readonly<Record<string, string>>,
): string {
  const entries = Object.entries(context);
  if (entries.length === 0) return '';
  const body = entries.map(([key, value]) => `# ${key}\n${value}`).join('\n');
  return (
    `<system-reminder>\n` +
    `As you answer the user's questions, you can use the following context:\n` +
    `${body}\n\n` +
    `IMPORTANT: this context may or may not be relevant to your tasks. ` +
    `You should not respond to this context unless it is highly relevant to your task.\n` +
    `</system-reminder>\n`
  );
}
