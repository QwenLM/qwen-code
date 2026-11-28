/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import stringWidth from 'string-width';

type TerminalRow = {
  readonly id: number;
  cells: string[];
  backgrounds: Array<string | undefined>;
};

export type TerminalCursor = {
  readonly x: number;
  readonly y: number;
};

/**
 * Minimal VT model for renderer protocol tests. It intentionally implements
 * only the control sequences emitted by Ink's main-screen paths.
 */
export class PhysicalTerminalModel {
  private readonly active: TerminalRow[];
  private scrollback: TerminalRow[] = [];
  private nextRowId = 1;
  private cursorX = 0;
  private cursorY = 0;
  private savedCursor: TerminalCursor | undefined;
  private currentBackground: string | undefined;
  private viewedTopRowId: number | undefined;

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    if (columns <= 0 || rows <= 0) {
      throw new Error('Terminal dimensions must be positive');
    }
    this.active = Array.from({ length: rows }, () => this.createRow());
  }

  get cursor(): TerminalCursor {
    return { x: this.cursorX, y: this.cursorY };
  }

  get activeRowIds(): number[] {
    return this.active.map((row) => row.id);
  }

  get scrollbackRowIds(): number[] {
    return this.scrollback.map((row) => row.id);
  }

  get scrollbackLines(): string[] {
    return this.scrollback.map((row) => row.cells.join('').trimEnd());
  }

  get activeLines(): string[] {
    return this.active.map((row) => row.cells.join('').trimEnd());
  }

  get activeBackgroundMask(): string[] {
    return this.active.map((row) => this.backgroundMask(row));
  }

  get scrollbackBackgroundMask(): string[] {
    return this.scrollback.map((row) => this.backgroundMask(row));
  }

  get viewedTopIdentity(): number {
    if (
      this.viewedTopRowId !== undefined &&
      this.allRows().some((row) => row.id === this.viewedTopRowId)
    ) {
      return this.viewedTopRowId;
    }
    return this.active[0]!.id;
  }

  scrollViewportToScrollbackRow(index: number): void {
    const row = this.scrollback[index];
    if (!row) {
      throw new Error(`No scrollback row at index ${index}`);
    }
    this.viewedTopRowId = row.id;
  }

  write(input: string): void {
    for (let index = 0; index < input.length; ) {
      const char = input[index]!;
      if (char === '\x1b') {
        index = this.consumeEscape(input, index);
        continue;
      }
      if (char === '\r') {
        this.cursorX = 0;
        index++;
        continue;
      }
      if (char === '\n') {
        this.lineFeed();
        index++;
        continue;
      }
      if (char >= ' ') {
        const codePoint = input.codePointAt(index);
        if (codePoint === undefined) break;
        const grapheme = String.fromCodePoint(codePoint);
        this.writeChar(grapheme);
        index += grapheme.length;
        continue;
      }
      index++;
    }
  }

  private createRow(): TerminalRow {
    return {
      id: this.nextRowId++,
      cells: Array.from({ length: this.columns }, () => ' '),
      backgrounds: Array.from({ length: this.columns }),
    };
  }

  private allRows(): TerminalRow[] {
    return [...this.scrollback, ...this.active];
  }

  private writeChar(char: string): void {
    const width = stringWidth(char);
    if (width === 0) {
      if (this.cursorX > 0) {
        this.active[this.cursorY]!.cells[this.cursorX - 1] += char;
      }
      return;
    }

    if (this.cursorX >= this.columns || this.cursorX + width > this.columns) {
      this.cursorX = 0;
      this.lineFeed();
    }
    const row = this.active[this.cursorY]!;
    row.cells[this.cursorX] = char;
    row.backgrounds[this.cursorX] = this.currentBackground;
    for (let offset = 1; offset < width; offset++) {
      row.cells[this.cursorX + offset] = '';
      row.backgrounds[this.cursorX + offset] = this.currentBackground;
    }
    this.cursorX += width;
  }

  private lineFeed(): void {
    if (this.cursorY + 1 < this.rows) {
      this.cursorY++;
      return;
    }
    this.scrollback.push(this.active.shift()!);
    this.active.push(this.createRow());
  }

  private consumeEscape(input: string, start: number): number {
    const introducer = input[start + 1];
    if (introducer === '[') {
      let end = start + 2;
      while (end < input.length) {
        const code = input.charCodeAt(end);
        if (code >= 0x40 && code <= 0x7e) {
          const body = input.slice(start + 2, end);
          this.applyCsi(body, input[end]!);
          return end + 1;
        }
        end++;
      }
      return input.length;
    }

    if (introducer === ']') {
      let end = start + 2;
      while (end < input.length) {
        if (input[end] === '\x07') return end + 1;
        if (input[end] === '\x1b' && input[end + 1] === '\\') {
          return end + 2;
        }
        end++;
      }
      return input.length;
    }

    if (introducer === '7') {
      this.savedCursor = this.cursor;
      return Math.min(start + 2, input.length);
    }

    if (introducer === '8') {
      if (this.savedCursor) {
        this.cursorX = Math.min(this.columns - 1, this.savedCursor.x);
        this.cursorY = Math.min(this.rows - 1, this.savedCursor.y);
      }
      return Math.min(start + 2, input.length);
    }

    return Math.min(start + 2, input.length);
  }

  private applyCsi(body: string, command: string): void {
    const params = body
      .replace(/^[?>]/, '')
      .split(';')
      .map((value) => (value === '' ? 0 : Number.parseInt(value, 10)));
    const param = (index: number, fallback: number): number => {
      const value = params[index];
      return value === undefined || Number.isNaN(value) || value === 0
        ? fallback
        : value;
    };

    switch (command) {
      case 'H':
      case 'f':
        this.cursorY = Math.min(this.rows - 1, param(0, 1) - 1);
        this.cursorX = Math.min(this.columns - 1, param(1, 1) - 1);
        break;
      case 'A':
        this.cursorY = Math.max(0, this.cursorY - param(0, 1));
        break;
      case 'B':
        this.cursorY = Math.min(
          this.rows - 1,
          this.cursorY + param(0, 1),
        );
        break;
      case 'C':
        this.cursorX = Math.min(
          this.columns - 1,
          this.cursorX + param(0, 1),
        );
        break;
      case 'D':
        this.cursorX = Math.max(0, this.cursorX - param(0, 1));
        break;
      case 'G':
        this.cursorX = Math.min(this.columns - 1, param(0, 1) - 1);
        break;
      case 'J':
        if ((params[0] ?? 0) === 0) {
          this.eraseCells(
            this.active[this.cursorY]!,
            this.cursorX,
            this.columns - 1,
          );
          for (let row = this.cursorY + 1; row < this.rows; row++) {
            this.eraseRow(this.active[row]!);
          }
        } else if (params[0] === 2) {
          for (const row of this.active) this.eraseRow(row);
        } else if (params[0] === 3) {
          this.scrollback = [];
        }
        break;
      case 'K':
        this.eraseLine(params[0] ?? 0);
        break;
      case 'm':
        this.applySgr(params);
        break;
      default:
        break;
    }
  }

  private eraseRow(row: TerminalRow): void {
    this.eraseCells(row, 0, this.columns - 1);
  }

  private eraseLine(mode: number): void {
    const row = this.active[this.cursorY]!;
    if (mode === 1) {
      this.eraseCells(row, 0, this.cursorX);
    } else if (mode === 2) {
      this.eraseRow(row);
    } else {
      this.eraseCells(row, this.cursorX, this.columns - 1);
    }
  }

  private eraseCells(row: TerminalRow, start: number, end: number): void {
    const from = Math.max(0, start);
    const to = Math.min(this.columns - 1, end);
    for (let index = from; index <= to; index++) {
      row.cells[index] = ' ';
      row.backgrounds[index] = this.currentBackground;
    }
  }

  private applySgr(params: number[]): void {
    for (let index = 0; index < params.length; index++) {
      const code = params[index] ?? 0;
      if (code === 0 || code === 49) {
        this.currentBackground = undefined;
      } else if (
        (code >= 40 && code <= 47) ||
        (code >= 100 && code <= 107)
      ) {
        this.currentBackground = `ansi-${code}`;
      } else if (code === 48) {
        const colorMode = params[index + 1];
        if (colorMode === 5 && params[index + 2] !== undefined) {
          this.currentBackground = `indexed-${params[index + 2]}`;
          index += 2;
        } else if (
          colorMode === 2 &&
          params[index + 2] !== undefined &&
          params[index + 3] !== undefined &&
          params[index + 4] !== undefined
        ) {
          this.currentBackground =
            `rgb-${params[index + 2]}-${params[index + 3]}-${params[index + 4]}`;
          index += 4;
        }
      }
    }
  }

  private backgroundMask(row: TerminalRow): string {
    return row.backgrounds
      .map((background) => (background === undefined ? ' ' : '#'))
      .join('')
      .trimEnd();
  }
}
