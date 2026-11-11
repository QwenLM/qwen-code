/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MermaidBlock — draws a closed ```mermaid fence as Unicode box-drawing art.
 *
 * The renderer (`lovely-mermaid`) is loaded with a dynamic import the first
 * time a mermaid block mounts, so startup and the non-interactive output
 * modes never evaluate it. Until it resolves, and on any failure, the block
 * renders exactly like an ordinary code block:
 *   - the library throws, returns null (unsupported kind), or reports any
 *     warning (it drops unparseable statements and keeps drawing, which would
 *     show a silently wrong diagram);
 *   - the source is empty or larger than MERMAID_MAX_SOURCE_BYTES;
 *   - the art is wider than the available columns or taller than
 *     MERMAID_MAX_ROWS.
 */

import React, { createContext, useEffect, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import type { MermaidArt, Role } from 'lovely-mermaid';
import { runLogger } from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { CODE_BLOCK_PREFIX_PADDING, RenderCodeBlock } from './CodeBlock.js';

export const MERMAID_MAX_ROWS = 80;
export const MERMAID_MAX_SOURCE_BYTES = 8 * 1024;
const ART_CACHE_LIMIT = 64;

/**
 * Lets a subtree opt out of diagram rendering. Conversation export provides
 * `false` so exported text keeps the mermaid source.
 */
export const MermaidRenderContext = createContext(true);

// ---------------------------------------------------------------------------
// Lazy renderer loading
// ---------------------------------------------------------------------------

type MermaidModule = typeof import('lovely-mermaid');
type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

let loadState: LoadState = 'idle';
let mermaidModule: MermaidModule | null = null;
let loadPromise: Promise<void> | null = null;
const loadListeners = new Set<() => void>();

function subscribeLoadState(listener: () => void): () => void {
  loadListeners.add(listener);
  return () => {
    loadListeners.delete(listener);
  };
}

function getLoadState(): LoadState {
  return loadState;
}

function setLoadState(next: LoadState): void {
  loadState = next;
  for (const listener of loadListeners) listener();
}

/** Starts loading the renderer once; later calls return the same promise. */
export function loadMermaidRenderer(): Promise<void> {
  if (loadPromise) return loadPromise;
  setLoadState('loading');
  loadPromise = import('lovely-mermaid').then(
    (module) => {
      mermaidModule = module;
      setLoadState('ready');
    },
    (error: unknown) => {
      runLogger.warn('[MermaidBlock] Failed to load mermaid renderer:', error);
      setLoadState('failed');
    },
  );
  return loadPromise;
}

// ---------------------------------------------------------------------------
// Art cache
// ---------------------------------------------------------------------------

// Keyed by source, not token identity: remounts (virtualized list scrolling,
// width re-keying) and terminal resizes would otherwise re-run layout. `null`
// is a cached result too, so an unsupported diagram is not re-parsed and
// re-logged on every frame. Insertion-order eviction is enough here.
const artCache = new Map<string, MermaidArt | null>();

/** Test hook: drops cached layouts. */
export function clearMermaidArtCache(): void {
  artCache.clear();
}

function getMermaidArt(
  source: string,
  mermaid: MermaidModule,
): MermaidArt | null {
  if (!source.trim()) return null;
  if (Buffer.byteLength(source, 'utf8') > MERMAID_MAX_SOURCE_BYTES) return null;
  if (artCache.has(source)) return artCache.get(source) ?? null;

  let art: MermaidArt | null = null;
  try {
    art = mermaid.render(source);
  } catch (error) {
    runLogger.warn('[MermaidBlock] Failed to render mermaid diagram:', error);
  }
  if (art && art.warnings.length > 0) art = null;

  if (artCache.size >= ART_CACHE_LIMIT) {
    const oldest = artCache.keys().next().value;
    if (oldest !== undefined) artCache.delete(oldest);
  }
  artCache.set(source, art);
  return art;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Theme color for a diagram cell role; `none` stays uncolored. */
export function mermaidRoleColor(role: Role): string | undefined {
  switch (role) {
    case 'border':
      return theme.border.default;
    case 'text':
      return theme.text.primary;
    case 'edge':
    case 'title':
      return theme.text.accent;
    case 'edgeLabel':
      return theme.text.secondary;
    default:
      return undefined;
  }
}

interface MermaidBlockProps {
  /** Fence body, without the fence lines. */
  source: string;
  /** Info string, passed through to the code-block fallback. */
  lang: string | null;
  terminalWidth: number;
  shrinkToContent?: boolean;
}

const MermaidBlockInternal: React.FC<MermaidBlockProps> = ({
  source,
  lang,
  terminalWidth,
  shrinkToContent = false,
}) => {
  // Re-render on settings (theme) changes, like RenderCodeBlock.
  useSettings();
  const state = useSyncExternalStore(subscribeLoadState, getLoadState);

  useEffect(() => {
    if (state === 'idle') void loadMermaidRenderer();
  }, [state]);

  const contentWidth = terminalWidth - CODE_BLOCK_PREFIX_PADDING;
  const art =
    state === 'ready' && mermaidModule && contentWidth > 0
      ? getMermaidArt(source, mermaidModule)
      : null;

  if (
    !art ||
    art.width > contentWidth ||
    art.plain.length > MERMAID_MAX_ROWS
  ) {
    return (
      <RenderCodeBlock
        content={source}
        lang={lang}
        terminalWidth={terminalWidth}
        shrinkToContent={shrinkToContent}
      />
    );
  }

  return (
    <Box
      paddingLeft={CODE_BLOCK_PREFIX_PADDING}
      flexDirection="column"
      width={shrinkToContent ? undefined : terminalWidth}
      maxWidth={terminalWidth}
      flexShrink={0}
    >
      {art.styled.map((spans, row) => {
        // Trailing unstyled padding only adds width; drop it.
        const end = spans.findLastIndex((span) => span.role !== 'none') + 1;
        // An empty <Text> can collapse to zero height; keep blank rows.
        if (end === 0) return <Text key={row}> </Text>;
        return (
          // truncate-end: if a wide glyph measures differently in the
          // terminal, losing a column beats reflowing the grid.
          <Text key={row} wrap="truncate-end">
            {spans.slice(0, end).map((span, index) => (
              <Text
                key={index}
                color={mermaidRoleColor(span.role)}
                bold={span.role === 'title'}
              >
                {span.text}
              </Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
};

export const MermaidBlock = React.memo(MermaidBlockInternal);
