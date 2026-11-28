/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { useCallback, useContext, useLayoutEffect, useRef } from 'react';
import CursorDeclarationContext from '../components/CursorDeclarationContext.js';
import type { DOMElement } from '../dom.js';

/**
 * Declares where the terminal cursor should be parked after each frame.
 *
 * Terminal emulators render IME preedit text at the physical cursor
 * position, and screen readers / screen magnifiers track the native
 * cursor — so parking it at the text input's caret makes CJK input
 * appear inline and lets accessibility tools follow the input.
 *
 * Returns a ref callback to attach to the Box that contains the input.
 * The declared (line, column) is interpreted relative to that Box's
 * nodeCache rect (populated by renderNodeToOutput).
 */
export function useDeclaredCursor({
  line,
  column,
  active,
}: {
  line: number;
  column: number;
  active: boolean;
}): (element: DOMElement | null) => void {
  const setCursorDeclaration = useContext(CursorDeclarationContext);
  const nodeRef = useRef<DOMElement | null>(null);

  const setNode = useCallback((node: DOMElement | null) => {
    nodeRef.current = node;
  }, []);

  // When active, set unconditionally. When inactive, clear conditionally
  // (only if the currently-declared node is ours).
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (active && node) {
      setCursorDeclaration({ relativeX: column, relativeY: line, node });
    } else {
      setCursorDeclaration(null, node);
    }
  });

  // Clear on unmount (conditionally — another instance may own by then).
  useLayoutEffect(() => {
    return () => {
      setCursorDeclaration(null, nodeRef.current);
    };
  }, [setCursorDeclaration]);

  return setNode;
}
