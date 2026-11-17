/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

interface ShellComment {
  start: number;
  end: number;
}

/** Shared comment context for scanners that already track quotes and escapes. */
export class ShellCommentContext {
  private parameterQuotes: boolean[] = [];
  private wordStart = true;
  private pendingDollar = false;
  private backticks = false;
  private comment: ShellComment | undefined;

  read(
    command: string,
    index: number,
    singleQuoted: boolean,
    doubleQuoted: boolean,
  ): ShellComment | undefined {
    const afterDollar = this.pendingDollar;
    this.pendingDollar = false;
    if (this.comment) {
      if (index < this.comment.end) return this.comment;
      this.comment = undefined;
      this.wordStart = true;
    }

    const character = command[index]!;
    if (this.backticks) {
      if (character === '`') this.backticks = false;
      this.wordStart = false;
      return undefined;
    }
    if (singleQuoted) {
      this.wordStart = false;
      return undefined;
    }
    if (character === '\\') {
      if (command[index + 1] === '\n') this.pendingDollar = afterDollar;
      else this.wordStart = false;
      return undefined;
    }
    if (character === '`') {
      this.backticks = true;
      this.wordStart = false;
      return undefined;
    }

    if (character === '$') {
      this.pendingDollar = !afterDollar;
      if (!afterDollar) {
        let next = index + 1;
        while (command.startsWith('\\\n', next)) next += 2;
        if (command[next] === '{') this.parameterQuotes.push(doubleQuoted);
      }
    } else if (
      character === '}' &&
      this.parameterQuotes.at(-1) === doubleQuoted
    ) {
      this.parameterQuotes.pop();
    }

    if (
      character === '#' &&
      !doubleQuoted &&
      this.parameterQuotes.length === 0 &&
      this.wordStart
    ) {
      const newline = command.indexOf('\n', index);
      this.comment = {
        start: index,
        end: newline < 0 ? command.length : newline,
      };
      return this.comment;
    }

    // A closing substitution/group can still be part of the current word.
    this.wordStart = !doubleQuoted && /[ \t\n;&|(<>]/.test(character);
    return undefined;
  }
}
