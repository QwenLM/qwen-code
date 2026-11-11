/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { InitModeSelector } from './InitModeSelector.js';
import { initCommand } from './initCommand.js';

describe('InitModeSelector', () => {
  it('cancels /init on Escape without submitting an initialization prompt', async () => {
    const context = createMockCommandContext({
      services: {
        agentContext: {
          config: {
            isInteractive: () => true,
            getCurrentContextFileName: () => 'CUSTOM.md',
          },
        },
      },
    });
    const action = initCommand.action!(context, '');
    const dialog = vi.mocked(context.ui.setCustomDialog).mock.calls[0][0];
    const view = await renderWithProviders(dialog as ReactElement);
    await view.waitUntilReady();

    await act(async () => {
      view.stdin.write('\u001b');
    });
    await view.waitUntilReady();

    expect(await action).toBeUndefined();
    expect(context.ui.setCustomDialog).toHaveBeenLastCalledWith(null);
    view.unmount();
  });

  it.each(['AGENTS.md', 'CUSTOM.md'])(
    'shows %s in the heading and Quick description',
    async (contextFileName) => {
      const result = await renderWithProviders(
        <InitModeSelector
          contextFileName={contextFileName}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />,
        { width: 120 },
      );
      await result.waitUntilReady();

      const frame = result.lastFrame();
      expect(frame).toContain(
        `How would you like to set up ${contextFileName}?`,
      );
      expect(frame).toContain(
        `Automatically analyze the codebase and generate ${contextFileName}`,
      );
      if (contextFileName !== 'AGENTS.md') {
        expect(frame).not.toContain('AGENTS.md');
      }
      expect(frame).toMatchSnapshot();
      result.unmount();
    },
  );
});
