/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithI18n as render } from '../../test-utils/render.js';
import { ShowMoreLines } from './ShowMoreLines.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOverflowState } from '../contexts/OverflowContext.js';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { useAlternateBuffer } from '../hooks/useAlternateBuffer.js';
import { StreamingState } from '../types.js';
import { createMockSettings } from '../../test-utils/settings.js';

vi.mock('../contexts/OverflowContext.js');
vi.mock('../contexts/StreamingContext.js');
vi.mock('../hooks/useAlternateBuffer.js');

describe('ShowMoreLines', () => {
  const mockUseOverflowState = vi.mocked(useOverflowState);
  const mockUseStreamingContext = vi.mocked(useStreamingContext);
  const mockUseAlternateBuffer = vi.mocked(useAlternateBuffer);

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAlternateBuffer.mockReturnValue(false);
  });

  it.each([
    [new Set(), StreamingState.Idle, true], // No overflow
    [new Set(['1']), StreamingState.Idle, false], // Not constraining height
  ])(
    'renders nothing when: overflow=%s, streaming=%s, constrain=%s',
    async (overflowingIds, streamingState, constrainHeight) => {
      mockUseOverflowState.mockReturnValue({ overflowingIds } as NonNullable<
        ReturnType<typeof useOverflowState>
      >);
      mockUseStreamingContext.mockReturnValue(streamingState);
      const { lastFrame, unmount } = await render(
        <ShowMoreLines constrainHeight={constrainHeight} />,
      );
      expect(lastFrame({ allowEmpty: true })).toBe('');
      unmount();
    },
  );

  it('renders message in STANDARD mode when overflowing', async () => {
    mockUseAlternateBuffer.mockReturnValue(false);
    mockUseOverflowState.mockReturnValue({
      overflowingIds: new Set(['1']),
    } as NonNullable<ReturnType<typeof useOverflowState>>);
    mockUseStreamingContext.mockReturnValue(StreamingState.Idle);
    const { lastFrame, unmount } = await render(
      <ShowMoreLines constrainHeight={true} />,
    );
    expect(lastFrame().toLowerCase()).toContain(
      'press ctrl+o to view detailed transcript',
    );
    unmount();
  });

  it.each([
    [StreamingState.Idle],
    [StreamingState.WaitingForConfirmation],
    [StreamingState.Responding],
  ])(
    'renders message in ASB mode when overflowing and state is %s',
    async (streamingState) => {
      mockUseAlternateBuffer.mockReturnValue(true);
      mockUseOverflowState.mockReturnValue({
        overflowingIds: new Set(['1']),
      } as NonNullable<ReturnType<typeof useOverflowState>>);
      mockUseStreamingContext.mockReturnValue(streamingState);
      const { lastFrame, unmount } = await render(
        <ShowMoreLines constrainHeight={true} />,
      );
      expect(lastFrame().toLowerCase()).toContain(
        'press ctrl+o to view detailed transcript',
      );
      unmount();
    },
  );

  it('renders message in ASB mode when isOverflowing prop is true even if internal overflow state is empty', async () => {
    mockUseAlternateBuffer.mockReturnValue(true);
    mockUseOverflowState.mockReturnValue({
      overflowingIds: new Set(),
    } as NonNullable<ReturnType<typeof useOverflowState>>);
    mockUseStreamingContext.mockReturnValue(StreamingState.Idle);
    const { lastFrame, unmount } = await render(
      <ShowMoreLines constrainHeight={true} isOverflowing={true} />,
    );
    expect(lastFrame().toLowerCase()).toContain(
      'press ctrl+o to view detailed transcript',
    );
    unmount();
  });

  it('renders nothing when isOverflowing prop is false even if internal overflow state has IDs', async () => {
    mockUseOverflowState.mockReturnValue({
      overflowingIds: new Set(['1']),
    } as NonNullable<ReturnType<typeof useOverflowState>>);
    mockUseStreamingContext.mockReturnValue(StreamingState.Idle);
    const { lastFrame, unmount } = await render(
      <ShowMoreLines constrainHeight={true} isOverflowing={false} />,
    );
    expect(lastFrame({ allowEmpty: true })).toBe('');
    unmount();
  });

  it('localizes the action while preserving Ctrl+O', async () => {
    mockUseOverflowState.mockReturnValue({
      overflowingIds: new Set(['1']),
    } as NonNullable<ReturnType<typeof useOverflowState>>);
    mockUseStreamingContext.mockReturnValue(StreamingState.Idle);
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, unmount } = await render(
      <ShowMoreLines constrainHeight={true} />,
      undefined,
      1000,
      settings,
    );
    expect(lastFrame()).toContain('按 Ctrl+O 查看详细记录');
    unmount();
  });
});
