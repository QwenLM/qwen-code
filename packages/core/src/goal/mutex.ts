/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Promise-based async mutex for serializing access to shared
 * runtime state within GoalManager.
 */

export class AsyncMutex {
  private _locked = false;
  private _waiting: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    while (this._locked) {
      await new Promise<void>((resolve) => this._waiting.push(resolve));
    }
    this._locked = true;
    return () => {
      this._locked = false;
      const next = this._waiting.shift();
      if (next) next();
    };
  }
}
