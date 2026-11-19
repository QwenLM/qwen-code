/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import type { CliRenderer, Selection } from '@opentui/core';
import { copyText } from './clipboard.js';

/**
 * Copies any completed OpenTUI selection, regardless of which region owns it:
 * transcript, footer, composer, dialogs, and the other surfaces outside the
 * transcript scrollbox. The selection is left in place.
 *
 * `copyText` returning false (clipboard backend unavailable) suppresses the
 * confirmation callback but does not clear the selection.
 */
export function useSelectionAutoCopy(
  renderer: CliRenderer,
  onCopied: (text: string) => void,
): void {
  useEffect(() => {
    const onSelection = (selection: Selection) => {
      const text = selection.getSelectedText();
      if (text.trim().length === 0) return;
      void copyText(text).then((copied) => {
        if (copied) onCopied(text);
      });
    };

    renderer.on('selection', onSelection);
    return () => {
      renderer.off('selection', onSelection);
    };
  }, [renderer, onCopied]);
}
