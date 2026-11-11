/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import type { MutableRefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  persistentStateMock,
  renderHookWithProviders,
} from '../../test-utils/render.js';
import type {
  TextBuffer,
  TextBufferSnapshot,
} from '../components/shared/text-buffer.js';
import { usePromptStash } from './usePromptStash.js';

/**
 * Minimal buffer stand-in: the stash only needs text, a snapshot round trip and
 * a clear, so a fake keeps these tests off the ink render path.
 */
function createFakeBuffer(initialText = ''): TextBuffer {
  let text = initialText;
  const fake = {
    get text() {
      return text;
    },
    setText: (next: string) => {
      text = next;
    },
    getSnapshot: (): TextBufferSnapshot => ({
      lines: text.split('\n'),
      cursorRow: 0,
      cursorCol: text.length,
      pastedContent: {},
      expandedPaste: null,
      imagePastedContent: {},
      nextImagePasteId: 0,
    }),
    restoreSnapshot: (snapshot: TextBufferSnapshot) => {
      text = snapshot.lines.join('\n');
    },
  };
  return fake as unknown as TextBuffer;
}

async function renderStash(buffer: TextBuffer) {
  const bufferRef: MutableRefObject<TextBuffer | null> = { current: buffer };
  const rendered = await renderHookWithProviders(() =>
    usePromptStash({ buffer, bufferRef }),
  );
  return { ...rendered, bufferRef };
}

describe('usePromptStash()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistentStateMock.setData({});
  });

  it('pushes the draft and clears the composer', async () => {
    const buffer = createFakeBuffer('a long enough draft');
    const { result } = await renderStash(buffer);

    let outcome;
    await act(async () => {
      outcome = result.current.toggleStash();
    });

    expect(outcome).toBe('push');
    expect(buffer.text).toBe('');
    expect(result.current.hasStash).toBe(true);
  });

  it('pops the draft back when the composer is empty', async () => {
    const buffer = createFakeBuffer('draft to park');
    const { result } = await renderStash(buffer);

    await act(async () => {
      result.current.toggleStash();
    });
    let outcome;
    await act(async () => {
      outcome = result.current.toggleStash();
    });

    expect(outcome).toBe('pop');
    expect(buffer.text).toBe('draft to park');
    expect(result.current.hasStash).toBe(false);
  });

  it('reports noop and changes nothing on an empty composer with no stash', async () => {
    const buffer = createFakeBuffer('');
    const { result } = await renderStash(buffer);

    let outcome;
    await act(async () => {
      outcome = result.current.toggleStash();
    });

    expect(outcome).toBe('noop');
    expect(buffer.text).toBe('');
    expect(result.current.hasStash).toBe(false);
  });

  it('treats a whitespace-only composer as empty', async () => {
    const buffer = createFakeBuffer('parked');
    const { result } = await renderStash(buffer);

    await act(async () => {
      result.current.toggleStash();
    });
    buffer.setText('   ');
    let outcome;
    await act(async () => {
      outcome = result.current.toggleStash();
    });

    expect(outcome).toBe('pop');
    expect(buffer.text).toBe('parked');
  });

  it('restores the draft after a submit clears the composer', async () => {
    const buffer = createFakeBuffer('parked draft');
    const { result, waitUntilReady } = await renderStash(buffer);

    await act(async () => {
      result.current.toggleStash();
    });
    await act(async () => {
      // Stand in for a submit: the composer is cleared, then the restore armed.
      buffer.setText('');
      result.current.markRestorePending();
    });
    await waitUntilReady();

    expect(buffer.text).toBe('parked draft');
    expect(result.current.hasStash).toBe(false);
  });

  it('keeps the stash when the user typed a new draft before the restore', async () => {
    const buffer = createFakeBuffer('parked draft');
    const { result, waitUntilReady } = await renderStash(buffer);

    await act(async () => {
      result.current.toggleStash();
    });
    await act(async () => {
      buffer.setText('something else entirely');
      result.current.markRestorePending();
    });
    await waitUntilReady();

    expect(buffer.text).toBe('something else entirely');
    expect(result.current.hasStash).toBe(true);
  });

  it('does not arm a restore when nothing is stashed', async () => {
    const buffer = createFakeBuffer('');
    const { result, waitUntilReady } = await renderStash(buffer);

    // A submit with no stash must not leave a pending flag behind: the next
    // stash would otherwise be popped back the instant it is created.
    await act(async () => {
      result.current.markRestorePending();
    });
    await waitUntilReady();

    buffer.setText('a brand new draft');
    await act(async () => {
      result.current.toggleStash();
    });
    await waitUntilReady();

    expect(buffer.text).toBe('');
    expect(result.current.hasStash).toBe(true);
  });

  it('clears the pending flag after a successful restore', async () => {
    const buffer = createFakeBuffer('first draft');
    const { result, waitUntilReady } = await renderStash(buffer);

    await act(async () => {
      result.current.toggleStash();
    });
    await act(async () => {
      buffer.setText('');
      result.current.markRestorePending();
    });
    await waitUntilReady();
    expect(buffer.text).toBe('first draft');

    // The restore consumed the flag, so this stash must stay stashed.
    await act(async () => {
      result.current.toggleStash();
    });
    await waitUntilReady();

    expect(buffer.text).toBe('');
    expect(result.current.hasStash).toBe(true);
  });

  it('marks the hint as seen once a draft has been stashed', async () => {
    const buffer = createFakeBuffer('a long enough draft');
    const { result } = await renderStash(buffer);

    await act(async () => {
      result.current.toggleStash();
    });

    expect(persistentStateMock.get('promptStashHintShown')).toBe(true);
  });
});
