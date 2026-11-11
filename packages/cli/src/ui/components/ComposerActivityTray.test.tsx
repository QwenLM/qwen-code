/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import type { Config } from '@qwen-code/core';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { ComposerActivityTray } from './ComposerActivityTray.js';

vi.mock('./messages/Todo.js', () => ({
  TodoTray: () => <Text>Tasks 1/2 · review implementation</Text>,
}));

describe('<ComposerActivityTray />', () => {
  it('keeps queued messages above tasks', async () => {
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <ComposerActivityTray
        config={{} as Config}
        messageQueue={['queued follow-up']}
        showUiDetails={true}
        hasStash={false}
      />,
      { width: 80 },
    );
    await waitUntilReady();

    const output = lastFrame();
    expect(output).toMatchSnapshot();
    expect(output.indexOf('queued follow-up')).toBeLessThan(
      output.indexOf('Tasks 1/2'),
    );
  });

  it('announces a stashed draft alongside the queue', async () => {
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <ComposerActivityTray
        config={{} as Config}
        messageQueue={[]}
        showUiDetails={true}
        hasStash={true}
      />,
      { width: 80 },
    );
    await waitUntilReady();

    expect(lastFrame()).toContain('Stashed');
  });

  it('hides the stash notice once nothing is stashed', async () => {
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <ComposerActivityTray
        config={{} as Config}
        messageQueue={[]}
        showUiDetails={true}
        hasStash={false}
      />,
      { width: 80 },
    );
    await waitUntilReady();

    expect(lastFrame()).not.toContain('Stashed');
  });

  it('hides the queue and tasks when detailed UI is hidden', async () => {
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <ComposerActivityTray
        config={{} as Config}
        messageQueue={['queued follow-up']}
        showUiDetails={false}
        hasStash={false}
      />,
      { width: 80 },
    );
    await waitUntilReady();

    expect(lastFrame({ allowEmpty: true })).toBe('');
  });
});
