/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { TurnContent, MessageRewriteConfig } from './types.js';

const debugLogger = createDebugLogger('MESSAGE_REWRITER');

const DEFAULT_REWRITE_PROMPT = `你是 ACP 消息改写助手。将 Agent 的原始输出改写为业务人员可读的版本。

规则：
- 保留：分析结论、数据发现、计算口径说明、建议、表格数据
- 过滤：文件路径、工具名称、SQL 语句、代码片段、技术调试信息、QWEN.md 指令复述
- 如果输入是纯技术操作（修复错误、创建目录、读取文件等），输出空字符串
- 风格：简洁、结论先行、中文
- 保持数据准确性，不要改写数字

只输出改写后的文本，不要解释。如果无有价值内容可输出，返回空字符串。`;

/**
 * Uses LLM to rewrite turn content into business-friendly text.
 * Called at the end of each model turn (after all chunks accumulated).
 */
export class LlmRewriter {
  private readonly prompt: string;

  constructor(
    private readonly config: Config,
    rewriteConfig: MessageRewriteConfig,
  ) {
    this.prompt = rewriteConfig.prompt || DEFAULT_REWRITE_PROMPT;
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
      inputParts.push(
        '[内部推理]\n' + turnContent.thoughts.join('\n'),
      );
    }
    if (turnContent.messages.length > 0) {
      inputParts.push(
        '[回复文本]\n' + turnContent.messages.join('\n'),
      );
    }

    const inputText = inputParts.join('\n\n');
    if (!inputText.trim()) return null;

    // Skip very short turns that are likely just transitions
    if (inputText.length < 10) return null;

    try {
      const contentGenerator = this.config.getContentGenerator();
      if (!contentGenerator) {
        debugLogger.warn('No content generator available for rewriting');
        return null;
      }

      const model =
        this.config.getSmallFastModel?.() || this.config.getModel();

      const result = await contentGenerator.generateContent(
        {
          model,
          config: {
            systemInstruction: this.prompt,
            abortSignal: signal,
            temperature: 0.3,
            maxOutputTokens: 1024,
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

      const rewritten =
        result.candidates?.[0]?.content?.parts
          ?.map((p) => p.text)
          .filter(Boolean)
          .join('') ?? '';

      // If LLM returns empty or very short, skip
      if (!rewritten.trim() || rewritten.trim().length < 5) {
        return null;
      }

      return rewritten.trim();
    } catch (error) {
      debugLogger.warn(
        `LLM rewrite failed, skipping: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
