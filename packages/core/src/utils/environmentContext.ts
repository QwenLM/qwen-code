/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { getFolderStructure } from './getFolderStructure.js';

/**
 * Rough estimate: 1 token ≈ 4 characters for English text.
 * This is a conservative estimate for quick truncation before API calls.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Estimates the number of tokens in a string using character count.
 * This is a fast approximation - use the API's countTokens for accuracy.
 * @param text - The text to estimate tokens for.
 * @returns Estimated token count.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Truncates content to fit within a token budget.
 * Uses a greedy approach: removes oldest messages first until under budget.
 * Clones content objects to avoid mutating the input.
 * @param contents - Array of content items to truncate.
 * @param maxTokens - Maximum token budget.
 * @returns Truncated array of content items.
 */
export function truncateContentToTokenBudget(
  contents: Content[],
  maxTokens: number,
): Content[] {
  if (maxTokens <= 0) {
    return [];
  }

  if (contents.length === 0) {
    return [];
  }

  // Calculate total estimated tokens
  const totalTokens = contents.reduce((sum, content) => {
    const text = content.parts?.map((p) => p.text || '').join('') || '';
    return sum + estimateTokens(text);
  }, 0);

  // If already under budget, return a shallow clone to avoid mutation
  if (totalTokens <= maxTokens) {
    return contents.map((item) => ({ ...item }));
  }

  // Deep clone the first item to avoid mutating the original
  const firstItem = contents[0]
    ? {
        ...contents[0],
        parts: contents[0].parts?.map((p) => ({ ...p })),
      }
    : undefined;
  const restItems = contents.slice(1);

  // Calculate first item tokens
  const firstItemText =
    firstItem?.parts?.map((p) => p.text || '').join('') || '';
  const firstItemTokens = estimateTokens(firstItemText);

  // If first item alone exceeds budget, truncate it
  if (firstItemTokens >= maxTokens && firstItem) {
    const availableChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE;
    if (availableChars > 0 && availableChars < firstItemText.length) {
      firstItem.parts = [
        {
          text:
            firstItemText.slice(0, availableChars) +
            '... [truncated due to token budget]',
        },
      ];
    }
    return [firstItem];
  }

  // Remove items from the beginning of restItems (oldest messages first)
  // But keep at least one item if possible for truncation
  let currentTokens = totalTokens;
  const truncatedItems = [...restItems];

  while (currentTokens > maxTokens && truncatedItems.length > 1) {
    const removedItem = truncatedItems.shift()!;
    const removedText =
      removedItem.parts?.map((p) => p.text || '').join('') || '';
    currentTokens -= estimateTokens(removedText);
  }

  // If still over budget with one item remaining, truncate that item
  if (currentTokens > maxTokens && truncatedItems.length === 1) {
    // Clone the last item before mutating
    const lastItem = {
      ...truncatedItems[0],
      parts: truncatedItems[0].parts?.map((p) => ({ ...p })),
    };
    const lastText = lastItem.parts?.map((p) => p.text || '').join('') || '';

    const availableTokensForLast = maxTokens - firstItemTokens;
    const availableCharsForLast =
      availableTokensForLast * CHARS_PER_TOKEN_ESTIMATE;

    if (availableCharsForLast > 0 && availableCharsForLast < lastText.length) {
      const truncatedText =
        lastText.slice(0, availableCharsForLast) +
        '... [truncated due to token budget]';
      lastItem.parts = [{ text: truncatedText }];
    }

    // Replace the original with the cloned/truncated version
    truncatedItems[0] = lastItem;
  }

  return firstItem ? [firstItem, ...truncatedItems] : truncatedItems;
}

/**
 * Generates a string describing the current workspace directories and their structures.
 * @param {Config} config - The runtime configuration and services.
 * @returns {Promise<string>} A promise that resolves to the directory context string.
 */
export async function getDirectoryContextString(
  config: Config,
): Promise<string> {
  const workspaceContext = config.getWorkspaceContext();
  const workspaceDirectories = workspaceContext.getDirectories();

  const folderStructures = await Promise.all(
    workspaceDirectories.map((dir) =>
      getFolderStructure(dir, {
        fileService: config.getFileService(),
      }),
    ),
  );

  const folderStructure = folderStructures.join('\n');

  let workingDirPreamble: string;
  if (workspaceDirectories.length === 1) {
    workingDirPreamble = `I'm currently working in the directory: ${workspaceDirectories[0]}`;
  } else {
    const dirList = workspaceDirectories.map((dir) => `  - ${dir}`).join('\n');
    workingDirPreamble = `I'm currently working in the following directories:\n${dirList}`;
  }

  return `${workingDirPreamble}
Here is the folder structure of the current working directories:

${folderStructure}`;
}

/**
 * Retrieves environment-related information to be included in the chat context.
 * This includes the current working directory, date, operating system, and folder structure.
 * @param {Config} config - The runtime configuration and services.
 * @returns A promise that resolves to an array of `Part` objects containing environment information.
 */
export async function getEnvironmentContext(config: Config): Promise<Part[]> {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const platform = process.platform;
  const directoryContext = await getDirectoryContextString(config);

  const context = `
This is the Qwen Code. We are setting up the context for our chat.
Today's date is ${today} (formatted according to the user's locale).
My operating system is: ${platform}
${directoryContext}
        `.trim();

  return [{ text: context }];
}

/**
 * Options for configuring initial chat history.
 */
export interface GetInitialChatHistoryOptions {
  /** When true, omits accumulated session history. */
  useCleanContext?: boolean;
  /** Optional maximum token budget for context. */
  maxContextTokens?: number;
  /** Optional additional history to append. */
  extraHistory?: Content[];
}

/**
 * Retrieves the initial chat history to seed a chat session.
 * By default, includes environment context plus any accumulated session history.
 * When useCleanContext is true, only provides fresh environment context without
 * prior session history - useful for subagents to avoid context bloat.
 * @param {Config} config - The runtime configuration and services.
 * @param options - Options for configuring the initial history.
 * @returns A promise that resolves to an array of `Content` objects for chat history.
 */
export async function getInitialChatHistory(
  config: Config,
  options?: GetInitialChatHistoryOptions | Content[],
): Promise<Content[]> {
  // Backward compatibility: if options is an array, treat it as extraHistory
  let useCleanContext = false;
  let maxContextTokens: number | undefined;
  let extraHistory: Content[] | undefined;

  if (Array.isArray(options)) {
    // Legacy call pattern: getInitialChatHistory(config, extraHistory)
    extraHistory = options;
  } else if (options) {
    // New call pattern with options object
    useCleanContext = options.useCleanContext ?? false;
    maxContextTokens = options.maxContextTokens;
    extraHistory = options.extraHistory;
  }
  if (config.getSkipStartupContext()) {
    return extraHistory ? [...extraHistory] : [];
  }

  const envParts = await getEnvironmentContext(config);
  const envContextString = envParts.map((part) => part.text || '').join('\n\n');

  let history: Content[];

  // When using clean context, skip any accumulated session history
  if (useCleanContext) {
    history = [
      {
        role: 'user',
        parts: [{ text: envContextString }],
      },
      {
        role: 'model',
        parts: [{ text: 'Got it. Thanks for the context!' }],
      },
      ...(extraHistory ?? []),
    ];
  } else {
    // Default behavior: include accumulated session history
    let sessionHistory: Content[] = [];
    try {
      sessionHistory = config.getGeminiClient()?.getHistory() ?? [];
    } catch {
      // Client not initialized yet - use empty history
      sessionHistory = [];
    }

    // Strip the initial environment context + ack from session history
    // to avoid duplication when we prepend fresh context below.
    // The session history typically starts with:
    // [{role: 'user', parts: [{text: envContext}]}, {role: 'model', parts: [{text: ack}]}]
    // We remove these and keep only the actual conversation.
    let strippedSessionHistory: Content[] = sessionHistory;
    if (
      sessionHistory.length >= 2 &&
      sessionHistory[0].role === 'user' &&
      sessionHistory[1].role === 'model'
    ) {
      const firstUserText =
        sessionHistory[0].parts?.map((p) => p.text || '').join('') || '';
      const firstModelText =
        sessionHistory[1].parts?.map((p) => p.text || '').join('') || '';

      // Check if this looks like environment context (contains working directory info)
      if (
        firstUserText.includes('working in the directory') ||
        firstUserText.includes('working in the following directories')
      ) {
        // Check if model response is the standard ack
        if (
          firstModelText.includes('Got it') &&
          firstModelText.includes('context')
        ) {
          strippedSessionHistory = sessionHistory.slice(2);
        }
      }
    }

    history = [
      {
        role: 'user',
        parts: [{ text: envContextString }],
      },
      {
        role: 'model',
        parts: [{ text: 'Got it. Thanks for the context!' }],
      },
      ...strippedSessionHistory,
      ...(extraHistory ?? []),
    ];
  }

  // Apply token budget truncation if specified
  if (maxContextTokens && maxContextTokens > 0) {
    history = truncateContentToTokenBudget(history, maxContextTokens);
  }

  return history;
}
