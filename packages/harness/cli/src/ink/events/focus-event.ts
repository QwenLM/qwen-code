/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { type EventTarget, TerminalEvent } from './terminal-event.js';

/**
 * Focus event for component focus changes.
 *
 * Dispatched when focus moves between elements. 'focus' fires on the
 * newly focused element, 'blur' fires on the previously focused one.
 * Both bubble, matching react-dom's use of focusin/focusout semantics
 * so parent components can observe descendant focus changes.
 */
export class FocusEvent extends TerminalEvent {
  readonly relatedTarget: EventTarget | null;

  constructor(
    type: 'focus' | 'blur',
    relatedTarget: EventTarget | null = null,
  ) {
    super(type, { bubbles: true, cancelable: false });
    this.relatedTarget = relatedTarget;
  }
}
