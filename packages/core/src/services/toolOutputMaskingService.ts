/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { estimateTokenCountSync } from '../utils/tokenCalculation.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { Config } from '../config/config.js';
import { logToolOutputMasking } from '../telemetry/loggers.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolOutputMaskingEvent } from '../telemetry/types.js';

const debugLogger = createDebugLogger('TOOL_OUTPUT_MASKING');

export const DEFAULT_TOOL_PROTECTION_THRESHOLD = 50000;
export const DEFAULT_MIN_PRUNABLE_TOKENS_THRESHOLD = 30000;
export const DEFAULT_PROTECT_LATEST_TURN = true;
export const MASKING_INDICATOR_TAG = 'tool_output_masked';

export const TOOL_OUTPUTS_DIR = 'tool-outputs';

const EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  ToolNames.SKILL,
  ToolNames.MEMORY,
  ToolNames.ASK_USER_QUESTION,
  ToolNames.EXIT_PLAN_MODE,
]);

export interface MaskingResult {
  newHistory: Content[];
  maskedCount: number;
  tokensSaved: number;
}

function sanitizeFilenamePart(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class ToolOutputMaskingService {
  async mask(history: Content[], config: Config): Promise<MaskingResult> {
    const maskingConfig = await config.getToolOutputMaskingConfig();
    if (!maskingConfig.enabled || history.length === 0) {
      return { newHistory: history, maskedCount: 0, tokensSaved: 0 };
    }

    let cumulativeToolTokens = 0;
    let protectionBoundaryReached = false;
    let totalPrunableTokens = 0;
    let maskedCount = 0;

    const prunableParts: Array<{
      contentIndex: number;
      partIndex: number;
      tokens: number;
      content: string;
      originalPart: Part;
    }> = [];

    const scanStartIdx = maskingConfig.protectLatestTurn
      ? history.length - 2
      : history.length - 1;

    for (let i = scanStartIdx; i >= 0; i--) {
      const content = history[i];
      const parts = content.parts || [];

      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j];

        if (!part.functionResponse) continue;

        const toolName = part.functionResponse.name;
        if (toolName && EXEMPT_TOOLS.has(toolName)) {
          continue;
        }

        const toolOutputContent = this.getToolOutputContent(part);
        if (!toolOutputContent || this.isAlreadyMasked(toolOutputContent)) {
          continue;
        }

        const partTokens = estimateTokenCountSync([part]);

        if (!protectionBoundaryReached) {
          cumulativeToolTokens += partTokens;
          if (cumulativeToolTokens > maskingConfig.toolProtectionThreshold) {
            protectionBoundaryReached = true;
            totalPrunableTokens += partTokens;
            prunableParts.push({
              contentIndex: i,
              partIndex: j,
              tokens: partTokens,
              content: toolOutputContent,
              originalPart: part,
            });
          }
        } else {
          totalPrunableTokens += partTokens;
          prunableParts.push({
            contentIndex: i,
            partIndex: j,
            tokens: partTokens,
            content: toolOutputContent,
            originalPart: part,
          });
        }
      }
    }

    if (totalPrunableTokens < maskingConfig.minPrunableTokensThreshold) {
      return { newHistory: history, maskedCount: 0, tokensSaved: 0 };
    }

    debugLogger.debug(
      `[ToolOutputMasking] Triggering masking. Prunable tool tokens: ${totalPrunableTokens.toLocaleString()} (> ${maskingConfig.minPrunableTokensThreshold.toLocaleString()})`,
    );

    const newHistory = [...history];
    let actualTokensSaved = 0;
    let toolOutputsDir = path.join(
      config.storage.getProjectTempDir(),
      TOOL_OUTPUTS_DIR,
    );
    const sessionId = config.getSessionId();
    if (sessionId) {
      const safeSessionId = sanitizeFilenamePart(sessionId);
      toolOutputsDir = path.join(toolOutputsDir, `session-${safeSessionId}`);
    }
    await fsPromises.mkdir(toolOutputsDir, { recursive: true });

    for (const item of prunableParts) {
      const { contentIndex, partIndex, content, tokens } = item;
      const contentRecord = newHistory[contentIndex];
      const part = contentRecord.parts![partIndex];

      if (!part.functionResponse) continue;

      const toolName = part.functionResponse.name || 'unknown_tool';
      const callId = part.functionResponse.id || Date.now().toString();
      const safeToolName = sanitizeFilenamePart(toolName).toLowerCase();
      const safeCallId = sanitizeFilenamePart(callId).toLowerCase();
      const fileName = `${safeToolName}_${safeCallId}_${Math.random()
        .toString(36)
        .substring(7)}.txt`;
      const filePath = path.join(toolOutputsDir, fileName);

      await fsPromises.writeFile(filePath, content, 'utf-8');

      const originalResponse =
        (part.functionResponse.response as Record<string, unknown>) || {};

      let preview = '';
      if (toolName === ToolNames.SHELL) {
        preview = this.formatShellPreview(originalResponse);
      } else {
        if (content.length > 500) {
          preview = `${content.slice(0, 250)}\n... [TRUNCATED] ...\n${content.slice(-250)}`;
        } else {
          preview = content;
        }
      }

      const maskedSnippet = this.formatMaskedSnippet(filePath, preview);

      const maskedPart = {
        ...part,
        functionResponse: {
          ...part.functionResponse,
          response: { output: maskedSnippet },
        },
      };

      const newTaskTokens = estimateTokenCountSync([maskedPart]);
      const savings = tokens - newTaskTokens;

      if (savings > 0) {
        const newParts = [...contentRecord.parts!];
        newParts[partIndex] = maskedPart;
        newHistory[contentIndex] = { ...contentRecord, parts: newParts };
        actualTokensSaved += savings;
        maskedCount++;
      }
    }

    debugLogger.debug(
      `[ToolOutputMasking] Masked ${maskedCount} tool outputs. Saved ~${actualTokensSaved.toLocaleString()} tokens.`,
    );

    const result = {
      newHistory,
      maskedCount,
      tokensSaved: actualTokensSaved,
    };

    if (actualTokensSaved <= 0) {
      return result;
    }

    logToolOutputMasking(
      config,
      new ToolOutputMaskingEvent({
        tokens_before: totalPrunableTokens,
        tokens_after: totalPrunableTokens - actualTokensSaved,
        masked_count: maskedCount,
        total_prunable_tokens: totalPrunableTokens,
      }),
    );

    return result;
  }

  private getToolOutputContent(part: Part): string | null {
    if (!part.functionResponse) return null;
    const response = part.functionResponse.response as Record<string, unknown>;
    if (!response) return null;

    const content = JSON.stringify(response, null, 2);

    return content;
  }

  private isAlreadyMasked(content: string): boolean {
    return content.includes(`<${MASKING_INDICATOR_TAG}`);
  }

  private formatShellPreview(response: Record<string, unknown>): string {
    const content = (response['output'] || response['stdout'] || '') as string;
    if (typeof content !== 'string') {
      return typeof content === 'object'
        ? JSON.stringify(content)
        : String(content);
    }

    const sectionRegex =
      /^(Output|Error|Exit Code|Signal|Background PIDs|Process Group PGID): /m;
    const parts = content.split(sectionRegex);

    if (parts.length < 3) {
      return this.formatSimplePreview(content);
    }

    const previewParts: string[] = [];
    if (parts[0].trim()) {
      previewParts.push(this.formatSimplePreview(parts[0].trim()));
    }

    for (let i = 1; i < parts.length; i += 2) {
      const name = parts[i];
      const sectionContent = parts[i + 1]?.trim() || '';

      if (name === 'Output') {
        previewParts.push(
          `Output: ${this.formatSimplePreview(sectionContent)}`,
        );
      } else {
        previewParts.push(`${name}: ${sectionContent}`);
      }
    }

    let preview = previewParts.join('\n');

    const exitCode = response['exitCode'] ?? response['exit_code'];
    const error = response['error'];
    if (
      exitCode !== undefined &&
      exitCode !== 0 &&
      exitCode !== null &&
      !content.includes(`Exit Code: ${exitCode}`)
    ) {
      preview += `\n[Exit Code: ${exitCode}]`;
    }
    if (error && !content.includes(`Error: ${error}`)) {
      preview += `\n[Error: ${error}]`;
    }

    return preview;
  }

  private formatSimplePreview(content: string): string {
    const lines = content.split('\n');
    if (lines.length <= 20) return content;
    const head = lines.slice(0, 10);
    const tail = lines.slice(-10);
    return `${head.join('\n')}\n\n... [${
      lines.length - head.length - tail.length
    } lines omitted] ...\n\n${tail.join('\n')}`;
  }

  private formatMaskedSnippet(filePath: string, preview: string): string {
    return `<${MASKING_INDICATOR_TAG}>
${preview}

Output too large. Full output available at: ${filePath}
</${MASKING_INDICATOR_TAG}>`;
  }
}
