/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { mockInkSpinner } from '../../test-utils/mockSpinner.js';
import { ModelQueueProgressIndicator } from './ModelQueueProgressIndicator.js';

mockInkSpinner();

describe('<ModelQueueProgressIndicator />', () => {
  it('renders the complete queued phase as three terminal rows', async () => {
    const renderResult = await renderWithProviders(
      <ModelQueueProgressIndicator
        terminalWidth={100}
        isNarrow={false}
        elapsedTime={273}
        modelQueue={{
          status: 'queued',
          requestSetId: 'set-1',
          waitTimeMs: 90_000,
          progress: 55,
        }}
      />,
      { width: 100 },
    );
    await renderResult.waitUntilReady();

    const lines = renderResult
      .lastFrame()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Model request queued');
    expect(lines[1]).toContain('moving');
    expect(lines[2]).toContain('estimated wait 1min');
    await expect(renderResult).toMatchSvgSnapshot();
    renderResult.unmount();
  });

  it('keeps all three rows with compact labels on narrow terminals', async () => {
    const renderResult = await renderWithProviders(
      <ModelQueueProgressIndicator
        terminalWidth={40}
        isNarrow={true}
        elapsedTime={273}
        modelQueue={{
          status: 'queued',
          requestSetId: 'set-1',
          waitTimeMs: 90_000,
          progress: 55,
        }}
      />,
      { width: 40 },
    );
    await renderResult.waitUntilReady();

    const lines = renderResult
      .lastFrame()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Model queued');
    expect(lines[0]).toContain('(4m 33s)');
    expect(lines[1]).toContain('moving');
    expect(lines.every((line) => line.length <= 40)).toBe(true);
    await expect(renderResult).toMatchSvgSnapshot();
    renderResult.unmount();
  });
});
