/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

export class Event {
  private _didStopImmediatePropagation = false;

  didStopImmediatePropagation(): boolean {
    return this._didStopImmediatePropagation;
  }

  stopImmediatePropagation(): void {
    this._didStopImmediatePropagation = true;
  }
}
