/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { ModelQueueMessage } from './ModelQueueMessage.js';

describe('<ModelQueueMessage />', () => {
  it('renders queued progress without queue position or percentage', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelQueueMessage
        terminalWidth={90}
        modelQueue={{
          status: 'queued',
          requestSetId: 'set-1',
          modelKey: 'qmodel',
          queueCount: 42,
          initialQueueCount: 100,
          waitTimeMs: 90_000,
          waitElapsedMs: 30_000,
          maxWaitMs: 3_600_000,
          progress: 55,
        }}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Model request queued');
    expect(output).toContain('moving');
    expect(output).not.toContain('55%');
    expect(output).not.toContain('42 requests ahead');
    expect(output).toContain('estimated wait 1min');
    expect(output).not.toContain('waited');
    expect(output).not.toContain('max 60min');
    expect(output).not.toContain('qmodel');
    unmount();
  });

  it('renders ready without a progress bar', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelQueueMessage
        terminalWidth={90}
        modelQueue={{
          status: 'ready',
          requestSetId: 'set-1',
          modelKey: 'qmodel',
          queueCount: 42,
          waitTimeMs: 90_000,
          progress: 100,
        }}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Model is available, continuing request');
    expect(output).not.toContain('100%');
    expect(output).not.toContain('42 requests ahead');
    expect(output).not.toContain('estimated wait');
    expect(output).not.toContain('qmodel');
    unmount();
  });

  it('labels progress as moving when queue position is unavailable', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelQueueMessage
        terminalWidth={90}
        modelQueue={{
          status: 'queued',
          requestSetId: 'set-1',
          waitTimeMs: 90_000,
          waitElapsedMs: 65_000,
          maxWaitMs: 3_600_000,
          progress: 12,
        }}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Model request queued');
    expect(output).toContain('moving');
    expect(output).not.toContain('12%');
    expect(output).toContain('estimated wait 1min');
    expect(output).not.toContain('waited');
    expect(output).not.toContain('max 60min');
    unmount();
  });

  it.each([
    [0, 'less than 1min'],
    [59_000, 'less than 1min'],
    [60_000, '1min'],
    [119_000, '1min'],
    [120_000, '2min'],
    [570_000, '10min'],
    [599_000, '10min'],
    [600_000, 'over 10min'],
  ])('formats server wait time %i ms as %s', async (waitTimeMs, expected) => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelQueueMessage
        terminalWidth={90}
        modelQueue={{
          status: 'queued',
          requestSetId: 'set-1',
          waitTimeMs,
          progress: 0,
        }}
      />,
    );

    const output = lastFrame();
    expect(output).toContain(`estimated wait ${expected}`);
    unmount();
  });

  it('does not expose auxiliary service availability', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelQueueMessage
        terminalWidth={90}
        modelQueue={{
          status: 'queued',
          requestSetId: 'set-1',
          queueCount: 42,
          waitTimeMs: 90_000,
          serviceAvailable: false,
          progress: 20,
        }}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Model request queued');
    expect(output).not.toContain('service temporarily unavailable');
    unmount();
  });
});
