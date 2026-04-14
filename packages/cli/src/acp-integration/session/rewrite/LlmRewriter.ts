/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { TurnContent, MessageRewriteConfig } from './types.js';

const debugLogger = createDebugLogger('MESSAGE_REWRITER');

const DEFAULT_REWRITE_PROMPT = `You are an assistant that rewrites raw coding-agent output into concise, user-friendly progress updates.

The agent is a software engineering assistant that reads files, writes code, runs commands, and uses tools. Its raw output mixes internal reasoning with user-facing information. Your job: extract what the user cares about, drop what they don't.

## Rules

1. **Strictly based on original**: only surface information already in the input. Never invent details, plans, or conclusions the agent didn't state.
2. **Keep**: goals, decisions, key findings, results, errors that affect the user, status updates.
3. **Drop**: file paths, tool/skill names, internal reasoning about which tool to call, code snippets, stack traces, "let me…" / "now I'll…" filler phrases.
4. **Progress turns**: if the agent is just starting a step (reading files, running a command, exploring code), output one short sentence describing what's happening — so the user isn't staring at silence.
5. **Rich content**: if the input already contains well-structured user-facing content (tables, lists, formatted results), do light cleanup only (remove stray paths/tool names) and preserve the structure.
6. **Pure internal ops**: if the input is entirely internal (fixing a typo in its own code, retrying a failed tool call, creating temp directories) → return empty string.
7. **Preserve data exactly**: never alter numbers, percentages, file sizes, error codes, or quoted output.

## Context continuity

If "Previous rewrite output" is provided, the user has already seen it. Don't repeat — build on it. If this turn adds nothing new, return empty string.

Output only the rewritten text, or empty string if the input has no user-facing value.`;

/**
 * Uses LLM to rewrite turn content into business-friendly text.
 * Called at the end of each model turn (after all chunks accumulated).
 */
export class LlmRewriter {
  private readonly prompt: string;
  /** Previous successful rewrite outputs, used as context for coherence */
  private outputHistory: string[] = [];
  /** How many previous outputs to include: 0=none, N=last N, Infinity=all */
  private readonly contextTurns: number;

  private readonly rewriteModel: string | undefined;

  constructor(
    private readonly config: Config,
    rewriteConfig: MessageRewriteConfig,
  ) {
    this.rewriteModel = rewriteConfig.model || undefined;
    this.contextTurns =
      rewriteConfig.contextTurns === 'all'
        ? Infinity
        : (rewriteConfig.contextTurns ?? 1);
    // promptFile takes precedence over inline prompt
    if (rewriteConfig.promptFile) {
      const filePath = resolve(rewriteConfig.promptFile);
      if (existsSync(filePath)) {
        this.prompt = readFileSync(filePath, 'utf-8').trim();
        debugLogger.info(
          `Loaded rewrite prompt from file: ${filePath} (${this.prompt.length} chars)`,
        );
      } else {
        debugLogger.warn(
          `Rewrite prompt file not found: ${filePath}, using default`,
        );
        this.prompt = DEFAULT_REWRITE_PROMPT;
      }
    } else {
      this.prompt = rewriteConfig.prompt || DEFAULT_REWRITE_PROMPT;
    }
  }

  /**
   * Rewrite a turn's content using LLM.
   * Returns null if the turn has no valuable content for users.
   */
  async rewrite(
    turnContent: TurnContent,
    signal?: AbortSignal,
  ): Promise<string | null> {
    // Build input text from turn content
    const inputParts: string[] = [];

    if (turnContent.thoughts.length > 0) {
      inputParts.push('[内部推理]\n' + turnContent.thoughts.join('\n'));
    }
    if (turnContent.messages.length > 0) {
      inputParts.push('[回复文本]\n' + turnContent.messages.join('\n'));
    }

    // Prepend previous rewrite outputs as context for coherence
    if (this.contextTurns > 0 && this.outputHistory.length > 0) {
      const contextSlice =
        this.contextTurns === Infinity
          ? this.outputHistory
          : this.outputHistory.slice(-this.contextTurns);
      inputParts.unshift('[上一轮改写结果]\n' + contextSlice.join('\n---\n'));
    }

    const inputText = inputParts.join('\n\n');
    if (!inputText.trim()) return null;

    // Skip very short turns that are likely just transitions
    if (inputText.length < 10) return null;

    debugLogger.info(
      `[REWRITE INPUT] system_prompt_len=${this.prompt.length} input_len=${inputText.length} context_turns=${this.outputHistory.length}\n` +
        `--- INPUT TEXT ---\n${inputText}\n---`,
    );

    try {
      const contentGenerator = this.config.getContentGenerator();
      if (!contentGenerator) {
        debugLogger.warn('No content generator available for rewriting');
        return null;
      }

      const model = this.rewriteModel || this.config.getModel();

      const result = await contentGenerator.generateContent(
        {
          model,
          config: {
            systemInstruction: this.prompt,
            abortSignal: signal,
            temperature: 0.3,
            maxOutputTokens: 1024,
            // Disable thinking to avoid thinking leaking into output
            thinkingConfig: { includeThoughts: false },
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: inputText }],
            },
          ],
        },
        `rewrite-turn`,
      );

      // Extract only non-thought text parts
      const rewritten =
        result.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought)
          .map((p) => p.text)
          .filter(Boolean)
          .join('') ?? '';

      // If LLM returns empty or very short, skip
      if (!rewritten.trim() || rewritten.trim().length < 5) {
        debugLogger.info(`[REWRITE OUTPUT] empty or too short, skipping`);
        return null;
      }

      const trimmed = rewritten.trim();

      debugLogger.info(
        `[REWRITE OUTPUT] len=${trimmed.length}\n` +
          `--- OUTPUT ---\n${trimmed}\n---`,
      );

      // Update context for next turn
      this.outputHistory.push(trimmed);

      return trimmed;
    } catch (error) {
      debugLogger.warn(
        `LLM rewrite failed, skipping: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
