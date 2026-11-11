/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  makeFakeConfig,
  runLogger,
  type Config,
} from '@qwen-code/core';
import { Text } from 'ink';
import type { MutableRefObject } from 'react';
import { act, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '../../test-utils/async.js';
import {
  cleanup,
  renderWithProviders,
} from '../../test-utils/render.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { CommandKind, type SlashCommand } from '../commands/types.js';
import { InputStateProvider } from '../contexts/InputStateProvider.js';
import { useVimMode } from '../contexts/VimModeContext.js';
import { StreamingState } from '../types.js';
import { InputPrompt, type InputPromptProps } from './InputPrompt.js';
import type { TextBuffer } from './shared/text-buffer.js';

// Controllable stand-in for the clipboard image capture: tests park a
// submission on a pending capture by installing an override; everything
// else passes through to the real implementation.
const clipboardCaptureMocks = vi.hoisted(() => ({
  materialize: null as ((contents: unknown) => Promise<unknown>) | null,
}));

vi.mock('../utils/clipboardImageCapture.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../utils/clipboardImageCapture.js')
  >();
  return {
    ...actual,
    materializePendingClipboardImages: ((contents) =>
      clipboardCaptureMocks.materialize
        ? clipboardCaptureMocks.materialize(contents)
        : actual.materializePendingClipboardImages(
            contents,
          )) as typeof actual.materializePendingClipboardImages,
  };
});

const slashCommands: SlashCommand[] = Array.from(
  { length: 8 },
  (_, index) => ({
    name: `command-${index}`,
    description: `Command ${index}`,
    kind: CommandKind.BUILT_IN,
    action: vi.fn(),
  }),
);

function VimModeProbe() {
  const { vimEnabled, vimMode } = useVimMode();
  return <Text>{`vim:${vimEnabled ? vimMode : 'disabled'}`}</Text>;
}

function NextActionLifecycleHarness({
  config,
  onSubmit = vi.fn(),
  externalBufferRef,
  onEscapePromptChange,
  focusControlRef,
  streamingState = StreamingState.Idle,
}: {
  config: Config;
  onSubmit?: InputPromptProps['onSubmit'];
  externalBufferRef?: MutableRefObject<TextBuffer | null>;
  onEscapePromptChange?: InputPromptProps['onEscapePromptChange'];
  focusControlRef?: MutableRefObject<((focused: boolean) => void) | null>;
  streamingState?: StreamingState;
}) {
  const internalBufferRef = useRef<TextBuffer | null>(null);
  const bufferRef = externalBufferRef ?? internalBufferRef;
  const [shellModeActive, setShellModeActive] = useState(false);
  const [focused, setFocused] = useState(true);
  if (focusControlRef) {
    focusControlRef.current = setFocused;
  }

  return (
      <InputStateProvider
        userMessages={[]}
        shellModeActive={shellModeActive}
        showEscapePrompt={false}
        inputWidth={80}
        suggestionsWidth={80}
        getPreferredEditor={() => undefined}
        bufferRef={bufferRef}
      >
        <VimModeProbe />
        <InputPrompt
          onSubmit={onSubmit}
          onClearScreen={vi.fn()}
          config={config}
          slashCommands={slashCommands}
          commandContext={createMockCommandContext()}
          setShellModeActive={setShellModeActive}
          permissionMode="default"
          focus={focused}
          placeholder="Type a message"
          onEscapePromptChange={onEscapePromptChange}
          setQueueErrorMessage={vi.fn()}
          streamingState={streamingState}
        />
      </InputStateProvider>
  );
}

describe('InputPrompt next-action lifecycle', () => {
  afterEach(() => {
    clipboardCaptureMocks.materialize = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  it('previews in gray, accepts with Tab, and submits only after editing and Enter', async () => {
    const config = makeFakeConfig();
    const onSubmit = vi.fn();
    const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
    const rendered = await renderWithProviders(
      <NextActionLifecycleHarness
        config={config}
        onSubmit={onSubmit}
        externalBufferRef={bufferRef}
      />,
      {
        config,
        uiState: {
          modelNextActionSuggestions: {
            id: 10,
            promptId: 'prompt-10',
            items: ['Review the diff'],
          },
        },
      },
    );
    const { stdin, lastFrame, unmount } = rendered;

    await rendered.waitUntilReady();
    expect(lastFrame()).toContain('> Review the diff');
    expect(lastFrame()).not.toContain('Next');
    expect(lastFrame()).not.toContain('Type a message');
    expect(bufferRef.current?.text).toBe('');
    await expect(rendered).toMatchSvgSnapshot({ name: 'next-action-preview' });

    await act(async () => {
      stdin.write('\r');
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(bufferRef.current?.text).toBe('');

    // Shift+Tab keeps its permission-mode binding and cannot accept a preview.
    await act(async () => {
      stdin.write('\x1b[Z');
    });
    expect(bufferRef.current?.text).toBe('');

    await act(async () => {
      stdin.write('\t');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('Review the diff');
    });
    expect(onSubmit).not.toHaveBeenCalled();
    await rendered.waitUntilReady();
    await expect(rendered).toMatchSvgSnapshot({ name: 'next-action-accepted' });

    for (const character of ' and tests') {
      await act(async () => {
        stdin.write(character);
      });
    }
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('Review the diff and tests');
    });
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      stdin.write('\r');
    });
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
        'Review the diff and tests',
        expect.any(Object),
        undefined,
        'typed',
      );
    });
    unmount();
  });

  it.each([
    { delivery: 'committed', vim: false },
    { delivery: 'batched', vim: false },
    { delivery: 'coalesced', vim: false },
    { delivery: 'committed', vim: true },
    { delivery: 'batched', vim: true },
    { delivery: 'coalesced', vim: true },
  ])(
    'submits fast edits exactly once with $delivery terminal input (Vim: $vim)',
    async ({ delivery, vim }) => {
      const config = makeFakeConfig();
      const onSubmit = vi.fn();
      const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
      const rendered = await renderWithProviders(
        <NextActionLifecycleHarness
          config={config}
          onSubmit={onSubmit}
          externalBufferRef={bufferRef}
        />,
        {
          config,
          settings: createMockSettings({ general: { vimMode: vim } }),
          uiState: {
            modelNextActionSuggestions: {
              id: 20,
              promptId: 'prompt-20',
              items: ['Review the diff'],
            },
          },
        },
      );
      await rendered.waitUntilReady();
      await act(async () => {
        rendered.stdin.write('\t');
      });
      expect(bufferRef.current?.text).toBe('Review the diff');

      // Keep Enter within the fast-return window even on a busy test runner.
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      try {
        if (delivery === 'committed') {
          for (const chunk of [' and', ' tests']) {
            await act(async () => {
              rendered.stdin.write(chunk);
            });
          }
          await act(async () => {
            rendered.stdin.write('\r');
          });
        } else {
          await act(async () => {
            if (delivery === 'coalesced') {
              rendered.stdin.write(' and tests\r');
            } else {
              rendered.stdin.write(' and');
              rendered.stdin.write(' tests');
              rendered.stdin.write('\r');
            }
          });
        }
      } finally {
        now.mockRestore();
      }
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
          'Review the diff and tests',
          expect.any(Object),
          undefined,
          'typed',
        );
        expect(bufferRef.current?.text).toBe('');
      });
      rendered.unmount();
    },
  );

  it('starts a normal draft on a number and keeps the preview dismissed after deletion', async () => {
    const config = makeFakeConfig();
    const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <NextActionLifecycleHarness config={config} externalBufferRef={bufferRef} />,
      {
        config,
        uiState: {
          modelNextActionSuggestions: {
            id: 11,
            promptId: 'prompt-11',
            items: ['Review the diff'],
          },
        },
      },
    );

    await act(async () => {
      stdin.write('1');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('1');
      expect(lastFrame()).not.toContain('Review the diff');
    });
    await act(async () => {
      stdin.write('\x7f');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('');
      expect(lastFrame()).toContain('Type a message');
      expect(lastFrame()).not.toContain('Review the diff');
    });
    await act(async () => {
      stdin.write('\t');
    });
    expect(bufferRef.current?.text).toBe('');
    unmount();
  });

  it('wraps a Chinese preview with an emoji inside a narrow input frame', async () => {
    const config = makeFakeConfig();
    const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
    const suggestion = '🔍检查本次修改的输入框逻辑，并补充主动推荐确认后编辑和发送的测试';
    const rendered = await renderWithProviders(
      <NextActionLifecycleHarness config={config} externalBufferRef={bufferRef} />,
      {
        config,
        width: 40,
        uiState: {
          modelNextActionSuggestions: {
            id: 12,
            promptId: 'prompt-12',
            items: [suggestion],
          },
        },
      },
    );

    await rendered.waitUntilReady();
    expect(bufferRef.current?.text).toBe('');
    expect(rendered.lastFrame().replace(/[\s│>]/g, '')).toContain(suggestion);
    await expect(rendered).toMatchSvgSnapshot({ name: 'next-action-narrow' });
    await act(async () => {
      rendered.stdin.write('\t');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe(suggestion);
    });
    rendered.unmount();
  });

  it('hides the preview while responding and preserves an existing draft', async () => {
    const config = makeFakeConfig();
    const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
    const rendered = await renderWithProviders(
      <NextActionLifecycleHarness
        config={config}
        externalBufferRef={bufferRef}
        streamingState={StreamingState.Responding}
      />,
      {
        config,
        uiState: {
          modelNextActionSuggestions: {
            id: 13,
            promptId: 'prompt-13',
            items: ['Review the diff'],
          },
        },
      },
    );
    expect(rendered.lastFrame()).not.toContain('Review the diff');

    await act(async () => {
      bufferRef.current?.setText('My draft');
    });
    await act(async () => {
      rendered.rerender(
        <NextActionLifecycleHarness config={config} externalBufferRef={bufferRef} />,
      );
    });
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).not.toContain('Review the diff');
    await act(async () => {
      rendered.stdin.write('\t');
    });
    expect(bufferRef.current?.text).toBe('My draft');
    rendered.unmount();
  });

  it('reverts only from NORMAL mode in Vim: the INSERT ESC keeps the accepted text', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T00:00:00Z'));
    const config = makeFakeConfig();
    const settings = createMockSettings({
      general: { vimMode: true },
    });
    const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <NextActionLifecycleHarness
        config={config}
        externalBufferRef={bufferRef}
      />,
      {
        config,
        settings,
        uiState: {
          modelNextActionSuggestions: {
            id: 6,
            promptId: 'prompt-6',
            items: ['keep me until normal mode'],
          },
        },
      },
    );

    expect(lastFrame()).toContain('keep me until normal mode');
    expect(lastFrame()).toContain('vim:INSERT');

    await act(async () => {
      stdin.write('\t');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('keep me until normal mode');
      expect(lastFrame()).not.toContain('Next');
    });

    // In INSERT mode ESC belongs to the INSERT → NORMAL transition: it must
    // keep the accepted text, not revert it.
    await act(async () => {
      stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(bufferRef.current?.text).toBe('keep me until normal mode');
    expect(lastFrame()).not.toContain('Next');
    expect(lastFrame()).toContain('vim:NORMAL');

    // From NORMAL mode — where ESC has no other job — the next press
    // reverts the accepted suggestion.
    await act(async () => {
      stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(bufferRef.current?.text).toBe('');
    expect(lastFrame()).toContain('keep me until normal mode');
    expect(lastFrame()).toContain('vim:NORMAL');

    unmount();
  });

  it('closes the dropdown, defers the revert past INSERT → NORMAL, then dismisses in Vim mode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T00:00:00Z'));
    const config = makeFakeConfig();
    const settings = createMockSettings({
      general: { vimMode: true },
    });
    const onEscapePromptChange = vi.fn();
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <NextActionLifecycleHarness
        config={config}
        onEscapePromptChange={onEscapePromptChange}
      />,
      {
        config,
        settings,
        uiState: {
          modelNextActionSuggestions: {
            id: 1,
            promptId: 'prompt-1',
            items: ['/command'],
          },
        },
      },
    );

    expect(lastFrame()).toContain('/command');
    expect(lastFrame()).toContain('vim:INSERT');

    await act(async () => {
      stdin.write('\t');
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('command-0');
      expect(lastFrame()).not.toContain('Next');
    });

    // ESC with the dropdown open closes it and keeps the accepted text.
    await act(async () => {
      stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(lastFrame()).not.toContain('command-0');
    expect(lastFrame()).toContain('/command');
    expect(lastFrame()).not.toContain('Next');
    expect(lastFrame()).toContain('vim:INSERT');

    // With the dropdown closed, the next ESC performs INSERT → NORMAL and
    // still keeps the accepted text: the revert is deferred to NORMAL mode.
    await act(async () => {
      stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(lastFrame()).toContain('/command');
    expect(lastFrame()).not.toContain('Next');
    expect(lastFrame()).toContain('vim:NORMAL');

    // From NORMAL mode the next ESC reverts the accepted suggestion.
    await act(async () => {
      stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(lastFrame()).toContain('/command');
    expect(lastFrame()).not.toContain('command-0');
    expect(lastFrame()).toContain('vim:NORMAL');

    await act(async () => {
      stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(lastFrame()).not.toContain('/command');
    expect(lastFrame()).toContain('Type a message');

    // The ESC that dismissed the preview must not seed another Vim double-ESC
    // gesture. The next ESC should reach the prompt's normal escape flow.
    await act(async () => {
      stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(lastFrame()).not.toContain('/command');
    expect(onEscapePromptChange).toHaveBeenLastCalledWith(true);

    unmount();
  });

  it('forwards the dismissing ESC to Vim so INSERT still reaches NORMAL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00Z'));
    const config = makeFakeConfig();
    const settings = createMockSettings({
      general: { vimMode: true },
    });
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <NextActionLifecycleHarness config={config} />,
      {
        config,
        settings,
        uiState: {
          modelNextActionSuggestions: {
            id: 7,
            promptId: 'prompt-7',
            items: ['dismiss me from insert mode'],
          },
        },
      },
    );

    expect(lastFrame()).toContain('dismiss me from insert mode');
    expect(lastFrame()).toContain('vim:INSERT');

    // ESC with the preview visible dismisses it, but the key still belongs to
    // vim's INSERT → NORMAL transition: it must not be swallowed whole.
    await act(async () => {
      stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(lastFrame()).not.toContain('dismiss me from insert mode');
    expect(lastFrame()).toContain('vim:NORMAL');

    unmount();
  });

  it('clears a pending Vim find op with the dismissing ESC', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00Z'));
    const config = makeFakeConfig();
    const settings = createMockSettings({
      general: { vimMode: true },
    });
    const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <NextActionLifecycleHarness
        config={config}
        externalBufferRef={bufferRef}
      />,
      {
        config,
        settings,
        uiState: {
          modelNextActionSuggestions: {
            id: 8,
            promptId: 'prompt-8',
            items: ['reach normal with the list visible'],
          },
        },
      },
    );

    // Accept, ESC to NORMAL (text kept), ESC to revert: the list is visible
    // again while vim sits in NORMAL over an empty buffer.
    await act(async () => {
      stdin.write('\t');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe(
        'reach normal with the list visible',
      );
    });
    await act(async () => {
      stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(lastFrame()).toContain('reach normal with the list visible');
    expect(lastFrame()).toContain('vim:NORMAL');
    expect(bufferRef.current?.text).toBe('');

    // `f` arms vim's find-char op; the ESC that dismisses the list must
    // also cancel it, or the next key would be eaten as the find target.
    await act(async () => {
      stdin.write('f');
    });
    await act(async () => {
      stdin.write('\x1b');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(lastFrame()).not.toContain('reach normal with the list visible');

    await act(async () => {
      stdin.write('i');
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      stdin.write('xyz');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(lastFrame()).toContain('vim:INSERT');
    expect(bufferRef.current?.text).toBe('xyz');

    unmount();
  });

  it('restores and re-arms an accepted suggestion when submission rejects', async () => {
    const config = makeFakeConfig();
    const submissionError = new Error('submission failed');
    const onSubmit = vi.fn().mockRejectedValue(submissionError);
    const loggerSpy = vi
      .spyOn(runLogger, 'error')
      .mockImplementation(() => undefined);
    const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <NextActionLifecycleHarness
        config={config}
        onSubmit={onSubmit}
        externalBufferRef={bufferRef}
      />,
      {
        config,
        uiState: {
          modelNextActionSuggestions: {
            id: 2,
            promptId: 'prompt-2',
            items: ['retry the rejected action'],
          },
        },
      },
    );

    await act(async () => {
      stdin.write('\t');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('retry the rejected action');
      expect(lastFrame()).not.toContain('Next');
    });

    await act(async () => {
      stdin.write('\r');
    });
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        'retry the rejected action',
        expect.any(Object),
        undefined,
        'typed',
      );
      expect(bufferRef.current?.text).toBe('retry the rejected action');
      expect(loggerSpy).toHaveBeenCalledWith(
        'Error submitting input:',
        submissionError,
      );
    });

    await act(async () => {
      stdin.write('\x1b');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('');
      expect(lastFrame()).toContain('retry the rejected action');
    });

    await act(async () => {
      stdin.write('\t');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('retry the rejected action');
      expect(lastFrame()).not.toContain('Next');
    });

    unmount();
  });

  it('shows restored suggestions after cursor-only movement and ESC', async () => {
    const config = makeFakeConfig();
    const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <NextActionLifecycleHarness
        config={config}
        externalBufferRef={bufferRef}
      />,
      {
        config,
        uiState: {
          modelNextActionSuggestions: {
            id: 3,
            promptId: 'prompt-3',
            items: ['move the cursor safely'],
          },
        },
      },
    );

    await act(async () => {
      stdin.write('\t');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('move the cursor safely');
    });

    await act(async () => {
      stdin.write('\x01');
    });
    await waitFor(() => {
      expect(bufferRef.current?.getOffset()).toBe(0);
    });

    await act(async () => {
      stdin.write('\x1b');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('');
      expect(lastFrame()).toContain('move the cursor safely');
    });

    unmount();
  });

  it('keeps a draft typed while a failing submission is pending', async () => {
    const config = makeFakeConfig();
    let rejectSubmit: ((error: Error) => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectSubmit = reject;
        }),
    );
    const loggerSpy = vi
      .spyOn(runLogger, 'error')
      .mockImplementation(() => undefined);
    const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <NextActionLifecycleHarness
        config={config}
        onSubmit={onSubmit}
        externalBufferRef={bufferRef}
      />,
      {
        config,
        uiState: {
          modelNextActionSuggestions: {
            id: 5,
            promptId: 'prompt-5',
            items: ['submit the pending action'],
          },
        },
      },
    );

    await act(async () => {
      stdin.write('\t');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('submit the pending action');
    });

    await act(async () => {
      stdin.write('\r');
    });
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
      expect(bufferRef.current?.text).toBe('');
    });

    // A new draft typed while the submission is still pending…
    for (const ch of 'new draft') {
      await act(async () => {
        stdin.write(ch);
      });
    }
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('new draft');
    });

    // …must survive the failed submission instead of being overwritten by
    // the restored pre-submit text.
    await act(async () => {
      rejectSubmit?.(new Error('submission failed'));
    });
    await waitFor(() => {
      expect(loggerSpy).toHaveBeenCalledWith(
        'Error submitting input:',
        expect.any(Error),
      );
    });
    expect(bufferRef.current?.text).toBe('new draft');

    // The kept draft is not a revertable accepted suggestion: ESC must not
    // clear it.
    await act(async () => {
      stdin.write('\x1b');
    });
    expect(bufferRef.current?.text).toBe('new draft');
    await waitFor(() => {
      expect(lastFrame()).toContain('new draft');
    });

    unmount();
  });

  it('keeps text typed during a pending clipboard capture when the submit succeeds', async () => {
    const config = makeFakeConfig();
    let releaseCapture: (() => void) | undefined;
    clipboardCaptureMocks.materialize = (contents) =>
      new Promise((resolve) => {
        releaseCapture = () => resolve(contents);
      });
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
    const { stdin, unmount } = await renderWithProviders(
      <NextActionLifecycleHarness
        config={config}
        onSubmit={onSubmit}
        externalBufferRef={bufferRef}
      />,
      { config },
    );

    // Fill the composer programmatically: rapid per-key writes followed by
    // Enter would trip the paste-protection heuristics and skew the
    // submitted value.
    await act(async () => {
      bufferRef.current?.setText('first message');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('first message');
    });

    await act(async () => {
      stdin.write('\r');
    });
    // The submission is parked on the pending image capture; the composer
    // still shows the submitted text and stays editable.
    expect(onSubmit).not.toHaveBeenCalled();

    for (const ch of ' and next') {
      await act(async () => {
        stdin.write(ch);
      });
    }
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('first message and next');
    });

    // Capture completes and the submit succeeds: the submission carries
    // the Enter-time snapshot while the composer keeps what the user
    // typed during the wait.
    await act(async () => {
      releaseCapture?.();
    });
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        'first message',
        expect.any(Object),
        undefined,
        'typed',
      );
    });
    expect(bufferRef.current?.text).toBe('first message and next');

    unmount();
  });

  it('does not revert or clear on ESC while the prompt is unfocused', async () => {
    const config = makeFakeConfig();
    const bufferRef: MutableRefObject<TextBuffer | null> = { current: null };
    const focusControlRef: MutableRefObject<
      ((focused: boolean) => void) | null
    > = { current: null };
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <NextActionLifecycleHarness
        config={config}
        externalBufferRef={bufferRef}
        focusControlRef={focusControlRef}
      />,
      {
        config,
        uiState: {
          modelNextActionSuggestions: {
            id: 4,
            promptId: 'prompt-4',
            items: ['keep the composer intact'],
          },
        },
      },
    );

    await act(async () => {
      stdin.write('\t');
    });
    await waitFor(() => {
      expect(bufferRef.current?.text).toBe('keep the composer intact');
    });

    // E.g. a pending approval dialog takes focus away from the prompt; the
    // Chat action handlers stay registered, but ESC must not clear the
    // composer behind the user's back.
    await act(async () => {
      focusControlRef.current?.(false);
    });
    await act(async () => {
      stdin.write('\x1b');
    });
    expect(bufferRef.current?.text).toBe('keep the composer intact');
    expect(lastFrame()).not.toContain('Next');

    // A second ESC within the double-press window must not reach the
    // double-ESC clear path either — the composer stays intact.
    await act(async () => {
      stdin.write('\x1b');
    });
    expect(bufferRef.current?.text).toBe('keep the composer intact');

    unmount();
  });
});
