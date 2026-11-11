/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { type ReactNode, useContext, useInsertionEffect, useRef } from 'react';
import instances from '../instances.js';
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} from '../termio/dec.js';
import Box from './Box.js';
import { TerminalSizeContext } from './TerminalSizeContext.js';

/**
 * Run children in the terminal's alternate screen buffer, constrained to
 * the viewport height. While mounted:
 *
 * - Enters the alt screen (DEC 1049), clears it, homes the cursor
 * - Constrains its own height to the terminal row count, so overflow must
 *   be handled via `overflow: scroll` / flexbox (no native scrollback)
 * - Optionally enables SGR mouse tracking (wheel + click/drag)
 *
 * On unmount, disables mouse tracking and exits the alt screen, restoring
 * the main screen's content.
 *
 * Notifies the Ink instance via `setAltScreenActive()` so the renderer
 * keeps the cursor inside the viewport (preventing the cursor-restore LF
 * from scrolling content) and so signal-exit cleanup can exit the alt
 * screen if the component's own unmount doesn't run.
 */
interface AlternateScreenProps {
  children: ReactNode;
  mouseTracking?: boolean;
}

export function AlternateScreen({
  children,
  mouseTracking = true,
}: AlternateScreenProps) {
  const size = useContext(TerminalSizeContext);
  const mouseTrackingRef = useRef(mouseTracking);
  mouseTrackingRef.current = mouseTracking;

  useInsertionEffect(() => {
    const ink = instances.get(process.stdout);
    const stdout = process.stdout;
    const mt = mouseTrackingRef.current;

    // Clear main screen + scrollback BEFORE entering alt screen.
    // iTerm2/Terminal.app show main-screen scrollback when you scroll up
    // while in alt mode — so we must wipe it while still on main screen.
    // Then enter alt screen and clear the alt buffer for a fresh start.
    stdout.write(
      '\x1B[2J\x1B[3J\x1B[H' +
        ENTER_ALT_SCREEN +
        '\x1B[2J\x1B[H' +
        (mt ? ENABLE_MOUSE_TRACKING : ''),
    );
    ink?.setAltScreenActive(true, mt);

    return () => {
      ink?.setAltScreenActive(false);
      stdout.write((mt ? DISABLE_MOUSE_TRACKING : '') + EXIT_ALT_SCREEN);
    };
  }, []);

  const rows = size?.rows ?? 24;

  return (
    <Box flexDirection="column" height={rows} width="100%" flexShrink={0}>
      {children}
    </Box>
  );
}
