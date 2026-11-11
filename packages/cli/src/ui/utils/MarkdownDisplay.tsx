/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MarkdownDisplay — renders markdown content in the terminal via Ink.
 *
 * Architecture (post-migration):
 *   markdown text → marked.lexer() → Token[]
 *     ├─ code tokens  → <RenderCodeBlock> (Ink component, syntax highlighting)
 *     │    └─ closed ```mermaid fences → <MermaidBlock> (box-drawing diagram)
 *     ├─ table tokens → <TableRenderer>   (Ink component, box-drawing layout)
 *     └─ other tokens → formatToken()     → ANSI string → <Text>
 */

import React, { useContext, useRef } from 'react';
import { Text, Box } from 'ink';
import type { Token, Tokens } from 'marked';
import { colorizeCode } from './CodeColorizer.js';
import { TableRenderer } from './TableRenderer.js';
import { CODE_BLOCK_PREFIX_PADDING, RenderCodeBlock } from './CodeBlock.js';
import { MermaidBlock, MermaidRenderContext } from './MermaidBlock.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { useAlternateBuffer } from '../hooks/useAlternateBuffer.js';
import {
  createStreamingMarkdownLexerState,
  isFencedCodeClosed,
  isMermaidLang,
  lexMarkdown,
  lexStreamingMarkdown,
} from './markdownTokenizer.js';
import {
  buildMarkdownChunks,
  createMarkdownChunkCache,
} from './markdownChunks.js';

interface MarkdownDisplayProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
  renderMarkdown?: boolean;
  /** Let a preview frame shrink to its content within terminalWidth. */
  shrinkToContent?: boolean;
}

const MarkdownDisplayInternal: React.FC<MarkdownDisplayProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  terminalWidth,
  renderMarkdown = true,
  shrinkToContent = false,
}) => {
  const settings = useSettings();
  const isAlternateBuffer = useAlternateBuffer();
  const streamingLexerState = useRef(createStreamingMarkdownLexerState());
  const chunkCache = useRef(createMarkdownChunkCache());
  const mermaidAllowed = useContext(MermaidRenderContext);
  // Box-drawing art is noise to assistive tech. Config folds in the
  // --screen-reader flag; many hosts (and test harnesses) render markdown
  // under a partial config, so fall back to the setting when it is absent.
  const config = useContext(ConfigContext);
  const screenReaderEnabled =
    typeof config?.getScreenReader === 'function'
      ? config.getScreenReader()
      : (settings.merged.ui.accessibility?.screenReader ?? false);
  const renderMermaid =
    mermaidAllowed &&
    !screenReaderEnabled &&
    settings.merged.ui.renderMermaid !== false;

  if (!text) return <></>;

  // Raw markdown mode - display syntax-highlighted markdown without rendering
  if (!renderMarkdown) {
    const colorizedMarkdown = colorizeCode({
      code: text,
      language: 'markdown',
      availableHeight: isAlternateBuffer ? undefined : availableTerminalHeight,
      maxWidth: terminalWidth - CODE_BLOCK_PREFIX_PADDING,
      settings,
      hideLineNumbers: true,
    });
    return (
      <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING} flexDirection="column">
        {colorizedMarkdown}
      </Box>
    );
  }

  // Parse markdown into AST tokens
  const tokens = isPending
    ? lexStreamingMarkdown(text, streamingLexerState.current)
    : lexMarkdown(text);
  const elements: React.ReactNode[] = [];
  // Keys are derived from token position, never from a running element
  // counter: a run that gains a chunk mid-stream would otherwise shift every
  // later key by one and remount the code blocks below it.
  let runTokens: Token[] = [];
  let runStartIndex = 0;

  const flushRun = () => {
    if (runTokens.length === 0) return;
    const chunks = buildMarkdownChunks(runTokens, chunkCache.current);
    for (let index = 0; index < chunks.length; index++) {
      elements.push(
        <Text key={`text-${runStartIndex}-${index}`} wrap="wrap">
          {chunks[index]}
        </Text>,
      );
    }
    runTokens = [];
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'code') {
      // Code blocks are rendered as Ink components for syntax highlighting
      flushRun();
      const codeToken = token as Tokens.Code;
      const lang = codeToken.lang || null;
      // Mermaid switches to a diagram only once its fence closes. An
      // unclosed fence swallows every later line into this token, so drawing
      // it would hide the rest of the message.
      const drawMermaid =
        renderMermaid && isMermaidLang(lang) && isFencedCodeClosed(codeToken);
      elements.push(
        drawMermaid ? (
          <MermaidBlock
            key={`code-${index}`}
            source={codeToken.text}
            lang={lang}
            shrinkToContent={shrinkToContent}
            terminalWidth={terminalWidth}
          />
        ) : (
          <RenderCodeBlock
            key={`code-${index}`}
            content={codeToken.text}
            lang={lang}
            shrinkToContent={shrinkToContent}
            terminalWidth={terminalWidth}
          />
        ),
      );
    } else if (token.type === 'table') {
      // Tables are rendered as Ink components for box-drawing layout
      flushRun();
      const tableToken = token as Tokens.Table;
      // Pass raw text to TableRenderer — it handles inline formatting
      // via parseMarkdownToANSI internally. Passing pre-formatted ANSI
      // strings would cause double-processing.
      const headers = tableToken.header.map((cell) => cell.text);
      const rows = tableToken.rows.map((row) => row.map((cell) => cell.text));
      elements.push(
        <RenderTable
          key={`table-${index}`}
          headers={headers}
          rows={rows}
          terminalWidth={terminalWidth}
        />,
      );
    } else {
      // Everything else → one or more ANSI chunks via buildMarkdownChunks
      if (runTokens.length === 0) runStartIndex = index;
      runTokens.push(token);
    }
  }
  flushRun();

  // flexShrink={0} is load-bearing, not cosmetic. Every <Text wrap="wrap">
  // carries flexShrink: 1, which on a column is the main axis: under a
  // height-constrained ancestor yoga spreads the shrink across all siblings,
  // so k chunks would each lose interior rows and overpaint each other where
  // one <Text> merely lost its tail. Pinning the whole message as a single
  // non-shrinking unit matches what RenderCodeBlock already declares.
  return (
    <Box
      flexDirection="column"
      width={shrinkToContent ? undefined : terminalWidth}
      maxWidth={terminalWidth}
      flexShrink={0}
    >
      {elements}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Table wrapper (delegates to TableRenderer)
// ---------------------------------------------------------------------------

interface RenderTableProps {
  headers: string[];
  rows: string[][];
  terminalWidth: number;
}

const RenderTableInternal: React.FC<RenderTableProps> = ({
  headers,
  rows,
  terminalWidth,
}) => (
  <TableRenderer headers={headers} rows={rows} terminalWidth={terminalWidth} />
);

const RenderTable = React.memo(RenderTableInternal);

export const MarkdownDisplay = React.memo(MarkdownDisplayInternal);
