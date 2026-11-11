/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/**
 * Ink Engine — barrel export for GMN.
 *
 * This file re-exports everything that GMN's 200+ application files
 * import from 'ink'. The tsconfig path alias `"ink" → "./src/ink/index.ts"`
 * ensures all existing `import { ... } from 'ink'` statements resolve here
 * with zero code changes.
 */

// --- Components ---
export { default as Box } from './components/Box.js';
export type { Props as BoxProps } from './components/Box.js';
export { default as Text } from './components/Text.js';
export type { Props as TextProps } from './components/Text.js';
export { default as Newline } from './components/Newline.js';
export { default as Spacer } from './components/Spacer.js';
export { Ansi } from './components/Ansi.js';

// GMN-specific components (not available in core engine)
export { StaticRender } from './compat/StaticRender.js';
export { default as Transform } from './compat/Transform.js';

// --- Hooks ---
export { default as useInput } from './hooks/use-input.js';
export { default as useApp } from './hooks/use-app.js';
export { default as useStdout } from './compat/use-stdout.js';
export { default as useStdin } from './compat/use-stdin.js';
export { useStdinInternal } from './compat/use-stdin-internal.js';
export { default as InternalStdinContext } from './components/StdinContext.js';
export { default as useIsScreenReaderEnabled } from './compat/use-is-screen-reader-enabled.js';
export { useTerminalViewport } from './hooks/use-terminal-viewport.js';

// --- Measurement ---
export { default as measureElement } from './measure-element.js';
export {
  AFTER_LAYOUT_PRIORITY,
  useAfterLayout,
} from './hooks/use-after-layout.js';
export { getBoundingBox } from './compat/getBoundingBox.js';

// --- DOM types ---
export type { DOMElement, DOMNode } from './dom.js';

// --- Utilities ---
export {
  default as ResizeObserver,
  ResizeObserverEntry,
} from './compat/ResizeObserver.js';

// --- AppContext (GMN's AppContainer.tsx imports AppContext and AppProps) ---
export { default as AppContext } from './components/AppContext.js';
export type { Props as AppProps } from './components/AppContext.js';

// --- Styled text utilities (GMN-specific, from npm ink) ---
export {
  StyledLine,
  toStyledCharacters,
  styledCharsWidth,
  wordBreakStyledChars,
  widestLineFromStyledChars,
  wrapStyledChars,
  styledLineToString,
} from './compat/styled-text.js';

// --- Render entry point ---
export { render } from './render.js';
export type { Instance, GMNRenderOptions as RenderOptions } from './render.js';

// --- Re-export engine internals that advanced GMN code may need ---
export { renderSync, createRoot } from './root.js';
export type { RenderOptions as CoreRenderOptions } from './root.js';
export { default as inkInstances } from './instances.js';
