/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderWithProviders, cleanup } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';

/**
 * Alt+Enter delivery through the real input pipeline.
 *
 * Lives in its own file rather than in KeypressContext.test.tsx: that file's
 * harness writes to a MockStdin that is never wired into the provider, so none
 * of its cases actually reach a subscriber. Here the bytes go in through the
 * stdin returned by renderWithProviders, which is the path InputPrompt.test.tsx
 * uses. Fold these back in once that harness is repaired.
 */

const KeyCollector = ({ keys }: { keys: Key[] }) => {
  useKeypress(
    (key) => {
      keys.push({ ...key });
      return true;
    },
    { isActive: true },
  );
  return null;
};

async function collectKeys(sequence: string): Promise<Key[]> {
  const keys: Key[] = [];
  const { stdin } = await renderWithProviders(<KeyCollector keys={keys} />);
  stdin.write(sequence);
  await waitFor(() => {
    expect(keys.length).toBeGreaterThan(0);
  });
  return keys;
}

describe('KeypressContext – Alt+Enter over the legacy ESC prefix', () => {
  afterEach(() => {
    cleanup();
  });

  it('delivers ESC+CR as a non-insertable alt+enter', async () => {
    const keys = await collectKeys('\x1b\r');

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      name: 'enter',
      alt: true,
      ctrl: false,
      cmd: false,
      shift: false,
      // Must not be insertable: an insertable key whose sequence ends in CR is
      // fed to the coalesced-submit path, which used to send the ESC as a
      // message.
      insertable: false,
      sequence: '\x1b\r',
    });
  });

  it('delivers ESC+CRLF as alt+enter', async () => {
    const keys = await collectKeys('\x1b\r\n');

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      name: 'enter',
      alt: true,
      ctrl: false,
      insertable: false,
    });
  });

  it('leaves Option+Tab inert rather than naming it alt+tab', async () => {
    // A named alt+tab would reach handlers that match on `key.name === 'tab'`
    // alone, e.g. ghost-text acceptance and the ModelDialog persist toggle.
    const keys = await collectKeys('\x1b\t');

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: '', alt: false });
  });

  it('emits a plain shift+enter when a backslash precedes Option+Enter', async () => {
    // bufferBackslashEnter rewrites the following Enter; if it inherited alt,
    // the result would match no binding and both keys would be swallowed.
    const keys = await collectKeys('\\\x1b\r');

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      name: 'enter',
      shift: true,
      alt: false,
      ctrl: false,
      cmd: false,
      sequence: '\r',
    });
  });

  it('delivers ESC+LF as alt+enter', async () => {
    const keys = await collectKeys('\x1b\n');

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      name: 'enter',
      alt: true,
      ctrl: false,
      insertable: false,
    });
  });

  it('still remaps a bare LF to ctrl+j', async () => {
    const keys = await collectKeys('\n');

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      name: 'j',
      ctrl: true,
      alt: false,
      insertable: false,
    });
  });

  it('still delivers a bare CR as a plain enter', async () => {
    const keys = await collectKeys('\r');

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      name: 'enter',
      alt: false,
      ctrl: false,
      shift: false,
    });
  });
});
