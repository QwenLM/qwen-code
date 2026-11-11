/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLayoutEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import { Text } from '../../ink/index.js';
import { renderToAnsiString } from './staticRender.js';

const terminal = vi.hoisted(() => ({ syncOutputSupported: false }));

vi.mock('../../ink/terminal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ink/terminal.js')>()),
  get SYNC_OUTPUT_SUPPORTED() {
    return terminal.syncOutputSupported;
  },
}));

describe('renderToAnsiString', () => {
  beforeEach(() => {
    terminal.syncOutputSupported = false;
  });

  it.each([false, true])(
    'returns one complete frame with synchronized output %s',
    async (supported) => {
      terminal.syncOutputSupported = supported;

      const result = await renderToAnsiString(
        <Text>{'你好，世界\nExported answer'}</Text>,
        80,
      );

      expect(stripAnsi(result)).toBe('你好，世界\nExported answer\n');
    },
  );

  it('preserves repeated lines within a frame', async () => {
    const result = await renderToAnsiString(
      <Text>{'Repeated line\nRepeated line'}</Text>,
      80,
    );

    expect(stripAnsi(result)).toBe('Repeated line\nRepeated line\n');
  });

  it('returns the final frame after layout effects update the content', async () => {
    function SettledContent() {
      const [text, setText] = useState('Initial content');
      useLayoutEffect(() => {
        setText('Settled content');
      }, []);
      return <Text>{text}</Text>;
    }

    const result = await renderToAnsiString(<SettledContent />, 80);

    expect(stripAnsi(result)).toBe('Settled content\n');
  });

  it('returns an empty string for an empty render', async () => {
    expect(await renderToAnsiString(null, 80)).toBe('');
  });
});
