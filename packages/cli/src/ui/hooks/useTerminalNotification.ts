/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * React hook and context for writing raw escape sequences to the terminal,
 * bypassing Ink's stdout interception.
 *
 * Provides per-protocol notification helpers (iTerm2 / Kitty / Ghostty / Bell)
 * and terminal progress reporting.
 *
 * Reference: Claude Code's `src/ink/useTerminalNotification.ts`
 */

import { createContext, useCallback, useContext, useMemo } from 'react';
import {
  BEL,
  wrapForMultiplexer,
  oscITerm2Notify,
  oscKittyNotify,
  oscGhosttyNotify,
} from '../../utils/osc.js';

// ── TerminalWriteContext ────────────────────────────────────────────

type WriteRaw = (data: string) => void;

export const TerminalWriteContext = createContext<WriteRaw | null>(null);

export const TerminalWriteProvider = TerminalWriteContext.Provider;

// ── Hook interface ──────────────────────────────────────────────────

export interface TerminalNotification {
  notifyITerm2: (opts: { message: string; title?: string }) => void;
  notifyKitty: (opts: { message: string; title: string; id: number }) => void;
  notifyGhostty: (opts: { message: string; title: string }) => void;
  notifyBell: () => void;
}

// ── Factory (no React context needed) ──────────────────────────────

/**
 * Build a TerminalNotification object from a raw write function.
 * Useful when the caller already has stdout.write and does not need
 * (or cannot use) TerminalWriteContext (e.g. in AppContainer's body
 * before the provider is mounted in the JSX tree).
 */
export function buildTerminalNotification(
  writeRaw: WriteRaw,
): TerminalNotification {
  return {
    notifyITerm2({ message, title }) {
      writeRaw(wrapForMultiplexer(oscITerm2Notify(title ?? '', message)));
    },
    notifyKitty({ message, title, id }) {
      for (const seq of oscKittyNotify(title, message, id)) {
        writeRaw(wrapForMultiplexer(seq));
      }
    },
    notifyGhostty({ message, title }) {
      writeRaw(wrapForMultiplexer(oscGhosttyNotify(title, message)));
    },
    notifyBell() {
      // Raw BEL — inside tmux this triggers tmux's bell-action (window flag).
      // Wrapping would make it opaque DCS payload and lose that fallback.
      writeRaw(BEL);
    },
  };
}

// ── Hook ────────────────────────────────────────────────────────────

export function useTerminalNotification(): TerminalNotification {
  const writeRaw = useContext(TerminalWriteContext);
  if (!writeRaw) {
    throw new Error(
      'useTerminalNotification must be used within TerminalWriteProvider',
    );
  }

  const notifyITerm2 = useCallback(
    ({ message, title }: { message: string; title?: string }) => {
      writeRaw(wrapForMultiplexer(oscITerm2Notify(title ?? '', message)));
    },
    [writeRaw],
  );

  const notifyKitty = useCallback(
    ({
      message,
      title,
      id,
    }: {
      message: string;
      title: string;
      id: number;
    }) => {
      for (const seq of oscKittyNotify(title, message, id)) {
        writeRaw(wrapForMultiplexer(seq));
      }
    },
    [writeRaw],
  );

  const notifyGhostty = useCallback(
    ({ message, title }: { message: string; title: string }) => {
      writeRaw(wrapForMultiplexer(oscGhosttyNotify(title, message)));
    },
    [writeRaw],
  );

  const notifyBell = useCallback(() => {
    writeRaw(BEL);
  }, [writeRaw]);

  return useMemo(
    () => ({ notifyITerm2, notifyKitty, notifyGhostty, notifyBell }),
    [notifyITerm2, notifyKitty, notifyGhostty, notifyBell],
  );
}
