/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isBidiControlChar } from './terminalSafe.js';

type State = 'text' | 'escape' | 'intermediate' | 'csi' | 'string';

// A streaming log filter, not a terminal emulator. Retain only sequence state,
// never payloads. Newlines end incomplete sequences so a broken escape cannot
// hide subsequent log lines. Both captured streams and tail reads use this rule.
export class TaskOutputSanitizer {
  private state: State = 'text';

  get hasPendingSequence(): boolean {
    return this.state !== 'text';
  }

  write(text: string): string {
    let output = '';
    for (const char of text) {
      const code = char.codePointAt(0)!;
      if (code === 0x0a || code === 0x0d) {
        this.state = 'text';
        output += char;
        continue;
      }
      if (code === 0x1b) {
        this.state = 'escape';
        continue;
      }
      if (code === 0x18 || code === 0x1a || code === 0x9c) {
        this.state = 'text';
        continue;
      }
      if (code === 0x9b) {
        this.state = 'csi';
        continue;
      }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
        this.state = 'string';
        continue;
      }
      if (code >= 0x80 && code <= 0x9f) {
        this.state = 'text';
        continue;
      }
      if (this.state === 'string') {
        if (code === 0x07) this.state = 'text';
        continue;
      }
      if (code < 0x20 || code === 0x7f) {
        if (code === 0x09 && this.state === 'text') output += char;
        continue;
      }
      if (isBidiControlChar(code)) continue;
      if (this.state === 'escape') {
        this.state = 'text';
        if (char === '[') this.state = 'csi';
        else if (']PX^_'.includes(char)) this.state = 'string';
        else if (code >= 0x20 && code <= 0x2f) this.state = 'intermediate';
        else if (
          (code >= 0x40 && code <= 0x5f) ||
          '6789=>cno|}~'.includes(char)
        ) {
          continue;
        } else {
          output += char;
        }
        continue;
      }
      if (this.state === 'csi' || this.state === 'intermediate') {
        const firstFinal = this.state === 'csi' ? 0x40 : 0x30;
        if (code >= firstFinal && code <= 0x7e) this.state = 'text';
        continue;
      }
      output += char;
    }
    return output;
  }
}
