/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { TerminalRenderer } from './terminalRenderer.js';

describe('TerminalRenderer', () => {
  it('renders basic terminal output', async () => {
    const renderer = new TerminalRenderer(20, 5);

    renderer.write('hello\r\nworld');
    const snapshot = await renderer.snapshot(5);
    renderer.dispose();

    expect(snapshot.screen).toBe('hello\nworld');
    expect(snapshot.cursor).toEqual({ x: 5, y: 1 });
  });

  it('renders clear-screen output as the final screen state', async () => {
    const renderer = new TerminalRenderer(20, 5);

    renderer.write('before');
    renderer.write('\u001b[2J\u001b[Hafter');
    const snapshot = await renderer.snapshot(5);
    renderer.dispose();

    expect(snapshot.screen).toBe('after');
  });

  it('limits rendered output after trimming surrounding empty screen rows', async () => {
    const renderer = new TerminalRenderer(20, 12);

    renderer.write('A\r\nB\r\nC\r\nD\r\nE\r\nF\r\nG\r\nH');
    const snapshot = await renderer.snapshot(3);
    renderer.dispose();

    expect(snapshot.screen).toBe('F\nG\nH');
  });

  it('preserves blank lines inside the rendered output', async () => {
    const renderer = new TerminalRenderer(20, 8);

    renderer.write('A\r\nB\r\n\r\nC');
    const snapshot = await renderer.snapshot(3);
    renderer.dispose();

    expect(snapshot.screen).toBe('B\n\nC');
  });

  it('does not include scrollback lines when rendering the current screen', async () => {
    const renderer = new TerminalRenderer(20, 5);

    renderer.write('1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\r\n');
    const snapshot = await renderer.snapshot(5);
    renderer.dispose();

    expect(snapshot.screen).toBe('5\n6\n7\n8');
  });

  it('preserves leading blank lines in the current screen', async () => {
    const renderer = new TerminalRenderer(20, 5);

    renderer.write('\r\n\r\ncentered');
    const snapshot = await renderer.snapshot(5);
    renderer.dispose();

    expect(snapshot.screen).toBe('\n\ncentered');
  });
});
