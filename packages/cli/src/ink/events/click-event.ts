/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { Event } from './event.js';

/**
 * Mouse click event. Fired on left-button release without drag, only when
 * mouse tracking is enabled (i.e. inside <AlternateScreen>).
 *
 * Bubbles from the deepest hit node up through parentNode. Call
 * stopImmediatePropagation() to prevent ancestors' onClick from firing.
 */
export class ClickEvent extends Event {
  /** 0-indexed screen column of the click */
  readonly col: number;
  /** 0-indexed screen row of the click */
  readonly row: number;

  /**
   * True if the clicked cell has no visible content (unwritten in the
   * screen buffer — both packed words are 0). Handlers can check this to
   * ignore clicks on blank space to the right of text, so accidental
   * clicks on empty terminal space don't toggle state.
   */
  readonly cellIsBlank: boolean;

  constructor(col: number, row: number, cellIsBlank: boolean) {
    super();
    this.col = col;
    this.row = row;
    this.cellIsBlank = cellIsBlank;
  }
}
