/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyToClipboard } from '../utils/commandUtils.js';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

interface FencedCodeBlock {
  lang: string | null;
  content: string;
  index: number;
  langIndex: number | null;
}

interface SelectedCodeBlock {
  block: FencedCodeBlock;
  label: string;
}

interface LatexBlock {
  content: string;
  index: number;
}

interface SelectedLatexBlock {
  block: LatexBlock;
  label: string;
}

interface InlineLatexExpression {
  content: string;
  index: number;
}

interface SelectedInlineLatexExpression {
  expression: InlineLatexExpression;
  label: string;
}

const INLINE_MATH_REGEX =
  /(?<![\w$])\$(?![\s\d$])(?=[^$\n]{1,240}\S\$)([^$\n]{1,240})\$(?![\w$])/g;

function parseFencedCodeBlocks(markdown: string): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  const fenceRegex = /^ *(`{3,}|~{3,}) *([^`]*)$/;
  const languageCounts = new Map<string, number>();
  let activeFence: string | null = null;
  let activeLang: string | null = null;
  let activeLangIndex: number | null = null;
  let activeLines: string[] = [];

  for (const line of lines) {
    const match = line.match(fenceRegex);
    if (!activeFence) {
      if (match) {
        activeFence = match[1];
        activeLang = match[2]?.trim().split(/\s+/)[0]?.toLowerCase() || null;
        if (activeLang) {
          const nextLangIndex = (languageCounts.get(activeLang) ?? 0) + 1;
          languageCounts.set(activeLang, nextLangIndex);
          activeLangIndex = nextLangIndex;
        } else {
          activeLangIndex = null;
        }
        activeLines = [];
      }
      continue;
    }

    if (
      match &&
      match[1].startsWith(activeFence[0]) &&
      match[1].length >= activeFence.length
    ) {
      blocks.push({
        lang: activeLang,
        content: activeLines.join('\n'),
        index: blocks.length + 1,
        langIndex: activeLangIndex,
      });
      activeFence = null;
      activeLang = null;
      activeLangIndex = null;
      activeLines = [];
      continue;
    }

    activeLines.push(line);
  }

  return blocks;
}

function parseInlineLatexExpressions(
  markdown: string,
): InlineLatexExpression[] {
  const expressions: InlineLatexExpression[] = [];
  const lines = markdown.split(/\r?\n/);
  const codeFenceRegex = /^ *(`{3,}|~{3,}) *([^`]*)$/;
  const mathFenceRegex = /^ *\$\$ *$/;
  let activeCodeFence: string | null = null;
  let inLatexBlock = false;

  for (const line of lines) {
    const codeFenceMatch = line.match(codeFenceRegex);
    if (activeCodeFence) {
      if (
        codeFenceMatch &&
        codeFenceMatch[1].startsWith(activeCodeFence[0]) &&
        codeFenceMatch[1].length >= activeCodeFence.length
      ) {
        activeCodeFence = null;
      }
      continue;
    }

    if (inLatexBlock) {
      if (mathFenceRegex.test(line)) {
        inLatexBlock = false;
      }
      continue;
    }

    if (codeFenceMatch) {
      activeCodeFence = codeFenceMatch[1];
      continue;
    }

    if (mathFenceRegex.test(line)) {
      inLatexBlock = true;
      continue;
    }

    for (const match of line.matchAll(INLINE_MATH_REGEX)) {
      const content = match[1];
      if (content) {
        expressions.push({
          content,
          index: expressions.length + 1,
        });
      }
    }
  }

  return expressions;
}

function selectInlineLatexExpression(
  markdown: string,
  tokens: string[],
): SelectedInlineLatexExpression | null {
  const expressions = parseInlineLatexExpressions(markdown);
  if (expressions.length === 0) return null;

  let requestedIndex: number | null = null;
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      requestedIndex = Number(token);
    }
  }

  const selected =
    requestedIndex !== null
      ? expressions.find((expression) => expression.index === requestedIndex)
      : expressions[expressions.length - 1];

  return selected
    ? {
        expression: selected,
        label: `Inline LaTeX expression ${selected.index}`,
      }
    : null;
}

function parseLatexBlocks(markdown: string): LatexBlock[] {
  const blocks: LatexBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  const mathFenceRegex = /^ *\$\$ *$/;
  let inLatexBlock = false;
  let activeLines: string[] = [];

  for (const line of lines) {
    if (!inLatexBlock) {
      if (mathFenceRegex.test(line)) {
        inLatexBlock = true;
        activeLines = [];
      }
      continue;
    }

    if (mathFenceRegex.test(line)) {
      blocks.push({
        content: activeLines.join('\n'),
        index: blocks.length + 1,
      });
      inLatexBlock = false;
      activeLines = [];
      continue;
    }

    activeLines.push(line);
  }

  return blocks;
}

function selectLatexBlock(
  markdown: string,
  args: string,
): SelectedLatexBlock | SelectedInlineLatexExpression | null | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const firstToken = tokens[0]?.toLowerCase();
  if (
    firstToken !== 'latex' &&
    firstToken !== 'math' &&
    firstToken !== 'inline-latex'
  ) {
    return undefined;
  }

  if (firstToken === 'inline-latex') {
    return selectInlineLatexExpression(markdown, tokens.slice(1));
  }

  const selectorTokens = tokens.slice(1);
  const inlineSelectorIndex = selectorTokens.findIndex(
    (token) => token.toLowerCase() === 'inline',
  );
  if (inlineSelectorIndex !== -1) {
    return selectInlineLatexExpression(
      markdown,
      selectorTokens.filter((_, index) => index !== inlineSelectorIndex),
    );
  }

  const blocks = parseLatexBlocks(markdown);
  if (blocks.length === 0) return null;

  let requestedIndex: number | null = null;
  for (const token of selectorTokens) {
    if (/^\d+$/.test(token)) {
      requestedIndex = Number(token);
    }
  }

  const selected =
    requestedIndex !== null
      ? blocks.find((block) => block.index === requestedIndex)
      : blocks[blocks.length - 1];

  return selected
    ? { block: selected, label: `LaTeX block ${selected.index}` }
    : null;
}

function selectCodeBlock(
  markdown: string,
  args: string,
): SelectedCodeBlock | null | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const firstToken = tokens[0]?.toLowerCase();
  if (!firstToken) return undefined;

  const blocks = parseFencedCodeBlocks(markdown);
  if (blocks.length === 0) return null;

  let lang: string | null = null;
  let requestedIndex: number | null = null;
  const selectorTokens =
    firstToken === 'code' ? tokens.slice(1) : tokens.map((token) => token);
  if (firstToken !== 'code') {
    lang = firstToken;
  }

  for (const token of selectorTokens) {
    if (/^\d+$/.test(token)) {
      requestedIndex = Number(token);
    } else if (token.toLowerCase() !== 'code') {
      lang = token.toLowerCase();
    }
  }

  const candidates = lang
    ? blocks.filter((block) => block.lang === lang)
    : blocks;
  if (candidates.length === 0) return null;

  if (requestedIndex !== null) {
    const requested = lang
      ? candidates.find((block) => block.langIndex === requestedIndex)
      : blocks.find((block) => block.index === requestedIndex);
    return requested
      ? { block: requested, label: formatCodeBlockLabel(requested, lang) }
      : null;
  }

  const selected = candidates[candidates.length - 1];
  return selected
    ? { block: selected, label: formatCodeBlockLabel(selected, lang) }
    : null;
}

function formatCodeBlockLabel(
  block: FencedCodeBlock,
  selectedLanguage: string | null,
): string {
  if (selectedLanguage && block.langIndex !== null) {
    return `${selectedLanguage} code block ${block.langIndex}`;
  }
  return `Code block ${block.index}`;
}

export const copyCommand: SlashCommand = {
  name: 'copy',
  get description() {
    return t('Copy the last result or code snippet to clipboard');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (context, _args): Promise<SlashCommandActionReturn | void> => {
    const chat = await context.services.config?.getGeminiClient()?.getChat();
    const history = chat?.getHistory();

    // Get the last message from the AI (model role)
    const lastAiMessage = history
      ? history.filter((item) => item.role === 'model').pop()
      : undefined;

    if (!lastAiMessage) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No output in history',
      };
    }
    // Extract text from the parts
    const lastAiOutput = lastAiMessage.parts
      ?.filter((part) => part.text)
      .map((part) => part.text)
      .join('');

    if (lastAiOutput) {
      try {
        const selectedLatexBlock = selectLatexBlock(lastAiOutput, _args);
        if (selectedLatexBlock === null) {
          return {
            type: 'message',
            messageType: 'info',
            content:
              _args
                .trim()
                .split(/\s+/)
                .some((token) => token === 'inline') ||
              _args.trim().toLowerCase().startsWith('inline-latex')
                ? 'No matching inline LaTeX expression found in the last AI output.'
                : 'No matching LaTeX block found in the last AI output.',
          };
        }
        if (selectedLatexBlock !== undefined) {
          const copiedLatex =
            'expression' in selectedLatexBlock
              ? selectedLatexBlock.expression.content
              : selectedLatexBlock.block.content;
          await copyToClipboard(copiedLatex);

          return {
            type: 'message',
            messageType: 'info',
            content: `${selectedLatexBlock.label} copied to the clipboard`,
          };
        }

        const selectedCodeBlock = selectCodeBlock(lastAiOutput, _args);
        if (selectedCodeBlock === null) {
          return {
            type: 'message',
            messageType: 'info',
            content: 'No matching code block found in the last AI output.',
          };
        }

        const copiedText = selectedCodeBlock?.block.content ?? lastAiOutput;
        await copyToClipboard(copiedText);

        return {
          type: 'message',
          messageType: 'info',
          content: selectedCodeBlock
            ? `${selectedCodeBlock.label} copied to the clipboard`
            : 'Last output copied to the clipboard',
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.services.config?.getDebugLogger().debug(message);

        return {
          type: 'message',
          messageType: 'error',
          content: `Failed to copy to the clipboard. ${message}`,
        };
      }
    } else {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Last AI output contains no text to copy.',
      };
    }
  },
};
