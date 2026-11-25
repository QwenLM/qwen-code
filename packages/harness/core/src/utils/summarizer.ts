/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from './runLogger.js';
import type { Config } from '../config/config.js';
import { mergeModelConfig } from '../provider/model/modelConfig.js';
import {
  getBusinessInfoFromContext,
  getRequestSetIdFromContext,
} from './sessionIdContext.js';
import { applyBusinessSubTask } from '../qoder/business-info.js';

const SUMMARIZE_TOOL_OUTPUT_PROMPT = `Summarize the following tool output to be a maximum of {maxOutputTokens} tokens. The summary should be concise and capture the main points of the tool output.

The summarization should be done based on the content that is provided. Here are the basic rules to follow:
1. If the text is a directory listing or any output that is structural, use the history of the conversation to understand the context. Using this context try to understand what information we need from the tool output and return that as a response.
2. If the text is text content and there is nothing structural that we need, summarize the text.
3. If the text is the output of a shell command, use the history of the conversation to understand the context. Using this context try to understand what information we need from the tool output and return a summarization along with the stack trace of any error within the <error></error> tags. The stack trace should be complete and not truncated. If there are warnings, you should include them in the summary within <warning></warning> tags.


Text to summarize:
"{textToSummarize}"

Return the summary string which should first contain an overall summarization of text followed by the full stack trace of errors and warnings in the tool output.
`;

/** Output budget of a tool-output summary. */
export const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 2000;

export async function summarizeToolOutput(
  config: Config,
  textToSummarize: string,
  abortSignal: AbortSignal,
  maxOutputTokens: number = DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
): Promise<string> {
  // There is going to be a slight difference here since we are comparing length of string with maxOutputTokens.
  // This is meant to be a ballpark estimation of if we need to summarize the tool output.
  if (!textToSummarize || textToSummarize.length < maxOutputTokens) {
    return textToSummarize;
  }
  const prompt = SUMMARIZE_TOOL_OUTPUT_PROMPT.replace(
    '{maxOutputTokens}',
    String(maxOutputTokens),
  ).replace('{textToSummarize}', textToSummarize);

  try {
    const manager = config.getModelProviderManager();
    const baseSelection = await manager.select({ purpose: 'summary' });
    const resolution = await manager.select({
      purpose: 'summary',
      overrideSelection: {
        model: baseSelection.model,
        config: mergeModelConfig(baseSelection.config, { context: { maxOutputTokens } }),
      },
    });
    abortSignal.throwIfAborted();
    const parentBusiness = getBusinessInfoFromContext();
    const request = {
      resolution,
      prompt: { messages: [{ role: 'user' as const, content: prompt }] },
      control: { signal: abortSignal },
      qoder: {
        identity: {
          sessionId: config.getSessionId(),
          requestSetId: getRequestSetIdFromContext(),
        },
        ...(parentBusiness ? { business: applyBusinessSubTask({ ...parentBusiness }) } : {}),
      },
    };
    const response = await manager.inference(request);
    const message = await response.completed;
    const summary = message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return summary || textToSummarize;
  } catch (error) {
    runLogger.warn('Failed to summarize tool output.', error);
    return textToSummarize;
  }
}
