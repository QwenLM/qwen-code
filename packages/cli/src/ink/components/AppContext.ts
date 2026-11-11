/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { createContext } from 'react';

export type Props = {
  /**
   * Exit (unmount) the whole Ink app.
   */
  readonly exit: (error?: Error) => void;

  /**
   * Schedule a normal render. The renderer decides which terminal cells need
   * to be updated.
   */
  readonly rerender: () => void;

  /** Rebuild the main-screen viewport without clearing native scrollback. */
  readonly requestViewportReset?: () => void;

  /** Replace the active transcript and rebuild its complete native history. */
  readonly requestTranscriptReplacement?: () => void;

  // --- GMN extensions (from npm ink, not part of the core engine) ---
  // These are optional methods that GMN's AppContainer.tsx destructures
  // from InkAppContext.

  /**
   * Update runtime rendering options (e.g. stickyHeadersInBackbuffer).
   */
  readonly setOptions?: (opts: Record<string, unknown>) => void;

  /**
   * Mark the previous frame as untrustworthy so the next render does a
   * full-damage diff instead of the per-node fast path. Lighter than
   * requestViewportReset() — no immediate screen clear or stdout write.
   */
  readonly invalidatePrevFrame?: () => void;

  /** Explicitly destroy the active screen and native scrollback. */
  readonly clearConversation?: () => void;

  /**
   * Dump the current rendered frame to a file for debugging.
   */
  readonly dumpCurrentFrame?: (filename: string) => void;

  /**
   * Start recording rendered frames to a file.
   */
  readonly startRecording?: (filename: string) => void;

  /**
   * Stop recording rendered frames.
   */
  readonly stopRecording?: () => void;
};

/**
 * `AppContext` is a React context, which exposes a method to manually exit the app (unmount).
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
const AppContext = createContext<Props>({
  exit() {},
  rerender() {},
  setOptions() {},
});

// eslint-disable-next-line custom-rules/no-top-level-side-effects
AppContext.displayName = 'InternalAppContext';

export default AppContext;
