import type { Message } from '../adapters/types';

interface FencedCodeBlock {
  lang: string | null;
  content: string;
  index: number;
  langIndex: number | null;
}

interface LatexBlock {
  content: string;
  index: number;
}

interface InlineLatexExpression {
  content: string;
  index: number;
}

interface CopySelection {
  content: string;
  label: string | null;
}

export interface CopyCommandResult {
  status: 'info' | 'error';
  message: string;
}

export const COPY_MESSAGES = {
  NO_OUTPUT: 'No output in history',
  NO_TEXT: 'Last AI output contains no text to copy.',
  CODE_MISSING: 'No matching code block found in the last AI output.',
  LATEX_MISSING: 'No matching LaTeX block found in the last AI output.',
  INLINE_LATEX_MISSING:
    'No matching inline LaTeX expression found in the last AI output.',
  OUTPUT_COPIED: 'Last output copied to the clipboard',
  CLIPBOARD_PREFIX: 'Failed to copy to the clipboard. ',
  COPIED_SUFFIX: ' copied to the clipboard',
} as const;

type ClipboardWriter = (text: string) => Promise<void>;

const INLINE_MATH_MAX_CHARS = 1024;
const INLINE_MATH_REGEX = new RegExp(
  String.raw`(?<![\w$])\$(?![\s\d$])(?=[^$\n]{1,${INLINE_MATH_MAX_CHARS}}\S\$)([^$\n]{1,${INLINE_MATH_MAX_CHARS}})\$(?![\w$])`,
  'g',
);

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
        activeFence = match[1] ?? null;
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
      match[1]?.startsWith(activeFence[0] ?? '') &&
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

function parseLatexBlocks(markdown: string): LatexBlock[] {
  const blocks: LatexBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  const codeFenceRegex = /^ *(`{3,}|~{3,}) *([^`]*)$/;
  const mathFenceRegex = /^ *\$\$ *$/;
  let activeCodeFence: string | null = null;
  let inLatexBlock = false;
  let activeLines: string[] = [];

  for (const line of lines) {
    const codeFenceMatch = line.match(codeFenceRegex);
    if (activeCodeFence) {
      if (
        codeFenceMatch &&
        codeFenceMatch[1]?.startsWith(activeCodeFence[0] ?? '') &&
        codeFenceMatch[1].length >= activeCodeFence.length
      ) {
        activeCodeFence = null;
      }
      continue;
    }

    if (!inLatexBlock) {
      if (codeFenceMatch) {
        activeCodeFence = codeFenceMatch[1] ?? null;
        continue;
      }

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
        codeFenceMatch[1]?.startsWith(activeCodeFence[0] ?? '') &&
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
      activeCodeFence = codeFenceMatch[1] ?? null;
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

function formatCodeBlockLabel(
  block: FencedCodeBlock,
  selectedLanguage: string | null,
): string {
  if (selectedLanguage && block.langIndex !== null) {
    return `${selectedLanguage} code block ${block.langIndex}`;
  }
  return `Code block ${block.index}`;
}

function selectCodeBlock(
  markdown: string,
  args: string,
): CopySelection | null | undefined {
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
      ? {
          content: requested.content,
          label: formatCodeBlockLabel(requested, lang),
        }
      : null;
  }

  const selected = candidates[candidates.length - 1];
  return selected
    ? {
        content: selected.content,
        label: formatCodeBlockLabel(selected, lang),
      }
    : null;
}

function selectInlineLatexExpression(
  markdown: string,
  tokens: string[],
): CopySelection | null {
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
        content: selected.content,
        label: `Inline LaTeX expression ${selected.index}`,
      }
    : null;
}

function selectLatexBlock(
  markdown: string,
  args: string,
): CopySelection | null | undefined {
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
    ? { content: selected.content, label: `LaTeX block ${selected.index}` }
    : null;
}

function getLastAssistantOutput(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'assistant' && message.content) {
      return message.content;
    }
  }
  return null;
}

function defaultClipboardWriter(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return Promise.reject(new Error('Clipboard API is not available'));
  }
  return navigator.clipboard.writeText(text);
}

export async function copyFromLastAssistantMessage(
  messages: readonly Message[],
  args: string,
  writeText: ClipboardWriter = defaultClipboardWriter,
): Promise<CopyCommandResult> {
  const lastAiOutput = getLastAssistantOutput(messages);
  if (lastAiOutput === null) {
    return {
      status: 'info',
      message: COPY_MESSAGES.NO_OUTPUT,
    };
  }

  if (!lastAiOutput) {
    return {
      status: 'info',
      message: COPY_MESSAGES.NO_TEXT,
    };
  }

  try {
    const selectedLatexBlock = selectLatexBlock(lastAiOutput, args);
    if (selectedLatexBlock === null) {
      const wantsInline = args
        .trim()
        .split(/\s+/)
        .some((token) => token === 'inline');
      return {
        status: 'info',
        message:
          wantsInline || args.trim().toLowerCase().startsWith('inline-latex')
            ? COPY_MESSAGES.INLINE_LATEX_MISSING
            : COPY_MESSAGES.LATEX_MISSING,
      };
    }
    if (selectedLatexBlock !== undefined) {
      await writeText(selectedLatexBlock.content);
      return {
        status: 'info',
        message: `${selectedLatexBlock.label}${COPY_MESSAGES.COPIED_SUFFIX}`,
      };
    }

    const selectedCodeBlock = selectCodeBlock(lastAiOutput, args);
    if (selectedCodeBlock === null) {
      return {
        status: 'info',
        message: COPY_MESSAGES.CODE_MISSING,
      };
    }

    const copiedText = selectedCodeBlock?.content ?? lastAiOutput;
    await writeText(copiedText);

    return {
      status: 'info',
      message: selectedCodeBlock
        ? `${selectedCodeBlock.label}${COPY_MESSAGES.COPIED_SUFFIX}`
        : COPY_MESSAGES.OUTPUT_COPIED,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'error',
      message: `${COPY_MESSAGES.CLIPBOARD_PREFIX}${message}`,
    };
  }
}
