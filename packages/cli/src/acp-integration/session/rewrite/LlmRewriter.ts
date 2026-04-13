/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { TurnContent, MessageRewriteConfig } from './types.js';

const debugLogger = createDebugLogger('MESSAGE_REWRITER');

const DEFAULT_REWRITE_PROMPT = `你是数据分析过程的展示优化助手。将 Agent 的原始输出改写为结构化的、面向业务同学的分析过程展示。

## 输出风格参考

用简洁的要点列表展示分析过程，让业务同学清晰看到"在做什么、怎么做、发现了什么"：

示例——数据理解阶段：
"数据理解完成。数据记录了全球多个游戏的销售数据及评分信息，涵盖游戏名称、平台、类型、发行商等维度。
• 涵盖游戏基本信息（名称、平台、类型、发行年份等）及全球销量
• 各地区销量（北美、欧洲、日本、其他地区）
• 媒体评分与用户评分数量"

示例——分析执行阶段：
"策略类游戏市场基本面分析
• 清洗数据：将 'tbd' 替换为空值，确保评分字段为数值型
• 计算策略类游戏的平均媒体评分与平均用户评分，并与全品类均值对比
• 分析评分与销量的相关性（如高分是否带动高销量），绘制评分-销量散点图并计算相关系数
• 识别'高分低销'与'低分高销'的异常游戏案例，初步推测原因"

示例——结论阶段：
"Central 地区盈利能力最差
• 利润率仅 7.92%，是 West 地区（14.94%）的一半
• 核心原因：折扣策略失控，平均折扣 24%，是其他地区的 2 倍
• Texas 和 Illinois 两州合计亏损占 68%"

## 规则

1. **保留的内容**：数据概览、分析模块名称和目标、计算口径（如"利润率 = SUM(利润)/SUM(销售额)"）、分析方法选择原因、数据发现和洞察（含具体数字）、结论、建议、表格
2. **过滤的内容**：文件路径、工具/Skill 名称、SQL 语句、Python 代码、技术报错信息、QWEN.md/工作流指令复述、"让我..."/"现在我来..."等自述性过渡语
3. **纯技术操作**（修复代码错误、创建目录、安装依赖等）→ 输出空字符串
4. **数据准确性**：不要改写任何数字、百分比、金额，原样保留
5. **语言**：中文，简洁，用要点列表（•）组织

只输出改写后的文本。如果输入无业务价值，返回空字符串。`;

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
      inputParts.push('[内部推理]\n' + turnContent.thoughts.join('\n'));
    }
    if (turnContent.messages.length > 0) {
      inputParts.push('[回复文本]\n' + turnContent.messages.join('\n'));
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

      const model = this.config.getModel();

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
