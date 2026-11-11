/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import xtermHeadless from '@xterm/headless';
import type { Terminal as XtermTerminal } from '@xterm/headless';

const { Terminal } = xtermHeadless as typeof import('@xterm/headless');

export interface TerminalScreenSnapshot {
  screen: string;
  cursor: {
    x: number;
    y: number;
  };
  bufferType: 'normal' | 'alternate';
}

export class TerminalRenderer {
  private readonly terminal: XtermTerminal;
  private renderQueue: Promise<void> = Promise.resolve();
  private rows: number;

  constructor(cols: number, rows: number) {
    this.rows = rows;
    this.terminal = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 10000,
    });
  }

  write(data: string): void {
    this.renderQueue = this.renderQueue.then(
      () =>
        new Promise<void>((resolve) => {
          this.terminal.write(data, resolve);
        }),
    );
  }

  async flush(): Promise<void> {
    await this.renderQueue;
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.flush();
    this.terminal.resize(cols, rows);
    this.rows = rows;
  }

  async snapshot(maxLines = 80): Promise<TerminalScreenSnapshot> {
    await this.flush();
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    const start = Math.max(0, buffer.length - this.rows);

    for (let i = start; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      lines.push(line?.translateToString(true) ?? '');
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    const visibleLines =
      maxLines > 0 ? lines.slice(-maxLines) : lines;

    return {
      screen: visibleLines.join('\n'),
      cursor: {
        x: buffer.cursorX,
        y: buffer.cursorY,
      },
      bufferType: buffer.type,
    };
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
