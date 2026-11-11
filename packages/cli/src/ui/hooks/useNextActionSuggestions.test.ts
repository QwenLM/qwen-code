/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';

import {
  classifyNextActionSuggestion,
  getModelNextActionSuggestions,
  useNextActionSuggestions,
} from './useNextActionSuggestions.js';

// Minimal live-text stub: the hook only reads buffer.text and calls
// setText; tests mutate .text directly to simulate user edits.
function createBufferStub(): TextBuffer {
  const buffer = {
    text: '',
    setText: vi.fn((text: string) => {
      buffer.text = text;
    }),
  };
  return buffer as unknown as TextBuffer;
}

describe('getModelNextActionSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses model suggestions as next-action items', () => {
    const suggestionSet = getModelNextActionSuggestions({
      id: 7,
      promptId: 'prompt-7',
      items: ['整理改动说明', '继续完善错误处理'],
    });

    expect(suggestionSet).toMatchObject({
      signature: 'model:7',
      items: [
        {
          kind: 'model',
          label: '整理改动说明',
          text: '整理改动说明',
        },
      ],
    });
  });

  it('skips empty suggestions and normalizes the first non-empty model suggestion', () => {
    const suggestionSet = getModelNextActionSuggestions({
      id: 8,
      promptId: 'prompt-8',
      items: ['', '  ', '1. 整理说明  ', '整理说明', '- 继续完善', '总结改动'],
    });

    expect(suggestionSet?.items.map((item) => item.text)).toEqual(['整理说明']);
  });

  it('limits model suggestions to one item', () => {
    const suggestionSet = getModelNextActionSuggestions({
      id: 9,
      promptId: 'prompt-9',
      items: ['建议一', '建议二', '建议三', '建议四'],
    });

    expect(suggestionSet?.items.map((item) => item.text)).toEqual(['建议一']);
  });

  it.each([
    ['执行 L2 轻量审查', 'L2'],
    ['Run an L3 deep review before handoff', 'L3'],
    ['扫描整个仓库', 'project_file'],
    ['对整个项目做安全扫描', 'project_file'],
    ['scan the entire repo for security issues', 'project_file'],
    ['Run an L4 security scan before release', 'project_file'],
    ['检查一下安全问题', 'unknown'],
  ] as const)('classifies security suggestion %s as %s', (text, mode) => {
    expect(classifyNextActionSuggestion(text)).toEqual({
      category: 'security_scan',
      securityMode: mode,
    });
  });

  it('keeps unrelated suggestions outside the security category', () => {
    expect(classifyNextActionSuggestion('整理改动说明')).toEqual({
      category: 'other',
    });
    expect(classifyNextActionSuggestion('优化 L2 缓存命中率')).toEqual({
      category: 'other',
    });
    expect(classifyNextActionSuggestion('扫描日志并汇总错误')).toEqual({
      category: 'other',
    });
  });

  it('clear() hides the sole model suggestion without accepting it', async () => {
    const buffer = createBufferStub();
    const { result, rerender, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 15,
          promptId: 'prompt-15',
          items: ['整理改动说明'],
        },
      }),
    );

    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    act(() => {
      result.current.clear();
    });
    rerender();
    expect(result.current.isVisible).toBe(false);
    expect(buffer.setText).not.toHaveBeenCalled();
    unmount();
  });

  it('does not accept discarded second or third model suggestions', async () => {
    const buffer = createBufferStub();
    const { result, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 16,
          promptId: 'prompt-16',
          items: ['建议一', '建议二', '建议三'],
        },
      }),
    );

    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    act(() => {
      expect(result.current.accept(1)).toBe(false);
      expect(result.current.accept(2)).toBe(false);
    });
    expect(buffer.setText).not.toHaveBeenCalled();
    unmount();
  });

  it('consumes the accept record on submission', async () => {
    const buffer = createBufferStub();
    const { result, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 13,
          promptId: 'prompt-13',
          items: ['执行 L3 深度审查'],
        },
      }),
    );

    act(() => {
      expect(result.current.accept(0)).toBe(true);
      result.current.recordSubmission('执行 L3 深度审查并输出报告');
    });

    // The submission consumed the accept record: nothing left to revert.
    expect(result.current.revertAccept()).toBe(false);
    unmount();
  });

  it('re-enables accept after a revert', async () => {
    const buffer = createBufferStub();
    const { result, rerender, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 21,
          promptId: 'prompt-21',
          items: ['整理改动说明'],
        },
      }),
    );

    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));

    // Reverting before any accept is a no-op.
    expect(result.current.revertAccept()).toBe(false);

    act(() => {
      expect(result.current.accept(0)).toBe(true);
    });
    rerender();
    // Accept hides the suggestions via the non-empty buffer, not suppression.
    expect(buffer.text).toBe('整理改动说明');
    expect(result.current.isVisible).toBe(false);

    act(() => {
      expect(result.current.revertAccept()).toBe(true);
    });
    rerender();
    // The buffer is cleared and the suggestions become visible again.
    expect(buffer.text).toBe('');
    expect(result.current.isVisible).toBe(true);

    // Re-accepting after a revert is a real user action again.
    act(() => {
      expect(result.current.accept(0)).toBe(true);
    });
    expect(buffer.text).toBe('整理改动说明');
    unmount();
  });

  it('accepts and submits the sole suggestion again after a revert', async () => {
    const buffer = createBufferStub();
    const { result, rerender, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 23,
          promptId: 'prompt-23',
          items: ['整理改动说明'],
        },
      }),
    );

    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));

    act(() => {
      expect(result.current.accept(0)).toBe(true);
    });
    rerender();
    act(() => {
      expect(result.current.revertAccept()).toBe(true);
    });
    rerender();
    act(() => {
      expect(result.current.accept(0)).toBe(true);
      result.current.recordSubmission('整理改动说明');
    });

    expect(buffer.text).toBe('整理改动说明');
    unmount();
  });

  it('does not treat retyped text as revertable after manual deletion', async () => {
    const buffer = createBufferStub();
    const { result, rerender, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 24,
          promptId: 'prompt-24',
          items: ['整理改动说明'],
        },
      }),
    );

    act(() => {
      expect(result.current.accept(0)).toBe(true);
    });
    rerender();

    // Simulate the user deleting the inserted text with backspace.
    buffer.text = '';
    rerender();

    // Retyping the exact same text must not be treated as revertable.
    buffer.text = '整理改动说明';
    rerender();
    expect(result.current.revertAccept()).toBe(false);
    expect(buffer.text).toBe('整理改动说明');
    unmount();
  });

  it('does not revert after the buffer is cleared before recording', async () => {
    const buffer = createBufferStub();
    const { result, rerender, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 25,
          promptId: 'prompt-25',
          items: ['整理改动说明'],
        },
      }),
    );

    act(() => {
      expect(result.current.accept(0)).toBe(true);
    });
    rerender();

    // Real submit order: the buffer is cleared programmatically, the async
    // onSubmit resolves, then recordSubmission runs.
    act(() => {
      buffer.setText('');
    });
    rerender();

    // ESC after the programmatic clear must not revert.
    expect(result.current.revertAccept()).toBe(false);
    act(() => {
      result.current.recordSubmission('整理改动说明');
    });
    expect(buffer.text).toBe('');
    unmount();
  });

  it('re-arms single-ESC revert only for a failed submit that began from armed', async () => {
    const buffer = createBufferStub();
    const { result, rerender, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 26,
          promptId: 'prompt-26',
          items: ['整理改动说明'],
        },
      }),
    );

    act(() => {
      expect(result.current.accept(0)).toBe(true);
    });
    rerender();

    // Submit of the accepted text: armed → submitting, then the
    // programmatic clear.
    act(() => {
      result.current.beginSubmission();
      buffer.setText('');
    });
    rerender();

    // onSubmit rejected: the buffer is restored and the submission resolves
    // back to armed, so a single ESC reverts again.
    act(() => {
      buffer.setText('整理改动说明');
      result.current.resolveFailedSubmission('整理改动说明');
    });
    rerender();
    act(() => {
      expect(result.current.revertAccept()).toBe(true);
    });
    expect(buffer.text).toBe('');
    unmount();
  });

  it('does not re-arm a failed submit of manually retyped text', async () => {
    const buffer = createBufferStub();
    const { result, rerender, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 27,
          promptId: 'prompt-27',
          items: ['整理改动说明'],
        },
      }),
    );

    act(() => {
      expect(result.current.accept(0)).toBe(true);
    });
    rerender();

    // Manual deletion and retyping: armed → pending, never re-armable.
    buffer.text = '';
    rerender();
    buffer.text = '整理改动说明';
    rerender();

    // Submitting the retyped text fails: pending must stay non-revertable.
    act(() => {
      result.current.beginSubmission();
      buffer.setText('');
    });
    rerender();
    act(() => {
      buffer.setText('整理改动说明');
      result.current.resolveFailedSubmission('整理改动说明');
    });
    rerender();
    expect(result.current.revertAccept()).toBe(false);
    expect(buffer.text).toBe('整理改动说明');
    unmount();
  });

  it('re-accepts the same item after the buffer is emptied without a revert', async () => {
    const buffer = createBufferStub();
    const { result, rerender, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 29,
          promptId: 'prompt-29',
          items: ['整理改动说明'],
        },
      }),
    );

    act(() => {
      expect(result.current.accept(0)).toBe(true);
    });
    rerender();

    // Ctrl+C / Backspace empties the buffer without an ESC revert, so the
    // suggestions come back while the accept record is still open.
    act(() => {
      buffer.setText('');
    });
    rerender();
    expect(result.current.isVisible).toBe(true);

    act(() => {
      expect(result.current.accept(0)).toBe(true);
      result.current.recordSubmission('整理改动说明');
    });
    expect(buffer.text).toBe('整理改动说明');
    unmount();
  });

  it('re-accepts the same item after a successful submit', async () => {
    const buffer = createBufferStub();
    const { result, rerender, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 30,
          promptId: 'prompt-30',
          items: ['整理改动说明'],
        },
      }),
    );

    act(() => {
      expect(result.current.accept(0)).toBe(true);
      result.current.beginSubmission();
      buffer.setText('');
      result.current.recordSubmission('整理改动说明');
    });
    rerender();
    expect(result.current.isVisible).toBe(true);

    // The submit consumed the previous accept: re-accepting the same item
    // must open a fresh accept record rather than silently reuse the spent
    // one.
    act(() => {
      expect(result.current.accept(0)).toBe(true);
      result.current.recordSubmission('整理改动说明');
    });

    expect(buffer.text).toBe('整理改动说明');
    unmount();
  });

  it('does not re-arm a kept draft that matches the accepted text', async () => {
    const buffer = createBufferStub();
    const { result, rerender, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 28,
          promptId: 'prompt-28',
          items: ['整理改动说明'],
        },
      }),
    );

    act(() => {
      expect(result.current.accept(0)).toBe(true);
    });
    rerender();

    act(() => {
      result.current.beginSubmission();
      buffer.setText('');
    });
    rerender();

    // While the submit is pending the user brings back the same text (e.g.
    // recalled from history). The failed submit keeps that draft, so null
    // signals "not restored" and the accept must stay non-revertable even
    // though the text matches.
    act(() => {
      buffer.setText('整理改动说明');
      result.current.resolveFailedSubmission(null);
    });
    rerender();
    expect(result.current.revertAccept()).toBe(false);
    expect(buffer.text).toBe('整理改动说明');
    unmount();
  });

  it('does not revert when the buffer no longer matches the accepted text', async () => {
    const buffer = createBufferStub();
    const { result, rerender, unmount } = await renderHook(() =>
      useNextActionSuggestions({
        buffer,
        active: true,
        modelSuggestions: {
          id: 22,
          promptId: 'prompt-22',
          items: ['整理改动说明'],
        },
      }),
    );

    act(() => {
      expect(result.current.accept(0)).toBe(true);
    });
    rerender();
    // Simulate the user editing the inserted text via the buffer API so the
    // buffer_changed effect (armed → pending) is exercised.
    act(() => {
      buffer.setText('整理改动说明，补充细节');
    });
    rerender();

    expect(result.current.revertAccept()).toBe(false);
    expect(buffer.text).toBe('整理改动说明，补充细节');
    unmount();
  });
});
