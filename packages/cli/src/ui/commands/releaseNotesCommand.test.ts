/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { isValidElement } from 'react';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  createReleaseNotesCommand,
  releaseNotesCommand,
} from './releaseNotesCommand.js';

describe('release-notes', () => {
  it('passes the configured URL resolver and description to the shared dialog', async () => {
    const getUrl = () => 'https://example.test/notes';
    const command = createReleaseNotesCommand({
      getUrl,
      description: 'Custom release history',
      isInteractive: () => true,
    });
    const result = await command.action!(createMockCommandContext(), '');
    expect(command.description).toBe('Custom release history');
    if (
      result?.type !== 'custom_dialog' ||
      !isValidElement<{ getUrl: unknown }>(result.component)
    ) {
      throw new Error('Expected dialog');
    }
    expect(result.component.props.getUrl).toBe(getUrl);
  });
  it('opens a local dialog and closes through the command UI', async () => {
    const context = createMockCommandContext({
      services: { agentContext: { config: { isInteractive: () => true } } },
      ui: { removeComponent: vi.fn() },
    });
    const result = await releaseNotesCommand.action!(context, '');
    expect(result?.type).toBe('custom_dialog');
    if (result?.type !== 'custom_dialog') throw new Error('Expected dialog');
    expect(isValidElement(result.component)).toBe(true);
    if (!isValidElement<{ onClose: () => void }>(result.component)) {
      throw new Error('Expected a React element');
    }
    result.component.props.onClose();
    expect(context.ui.removeComponent).toHaveBeenCalledOnce();
  });

  it('returns an unrendered dialog outside interactive mode', async () => {
    const context = createMockCommandContext({
      services: { agentContext: { config: { isInteractive: () => false } } },
      ui: { removeComponent: vi.fn() },
    });
    const result = await releaseNotesCommand.action!(context, '');
    expect(result).toEqual({ type: 'custom_dialog', component: null });
    expect(context.ui.removeComponent).not.toHaveBeenCalled();
  });

  it('returns an unrendered dialog without an agent context', async () => {
    const result = await releaseNotesCommand.action!(
      createMockCommandContext(),
      '',
    );
    expect(result).toEqual({ type: 'custom_dialog', component: null });
  });
});
