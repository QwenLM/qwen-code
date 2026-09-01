/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isEditorAvailableMock } = vi.hoisted(() => ({
  isEditorAvailableMock: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@qwen-code/qwen-code-core')
  >();
  return {
    ...actual,
    isEditorAvailable: isEditorAvailableMock,
  };
});

import { ToolConfirmationMessage } from './ToolConfirmationMessage.js';
import type {
  Config,
  ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../../test-utils/render.js';
import type { LoadedSettings } from '../../../config/settings.js';

describe('ToolConfirmationMessage external editor availability', () => {
  const config = {
    isTrustedFolder: () => true,
    getIdeMode: () => false,
  } as unknown as Config;

  const confirmationDetails: ToolCallConfirmationDetails = {
    type: 'edit',
    title: 'Confirm Edit',
    fileName: 'test.txt',
    filePath: '/test.txt',
    fileDiff: '...diff...',
    originalContent: 'a',
    newContent: 'b',
    onConfirm: vi.fn(),
  };

  const settings = {
    merged: { general: { preferredEditor: 'vscode' } },
  } as unknown as LoadedSettings;

  beforeEach(() => {
    isEditorAvailableMock.mockReset();
  });

  it('shows the modify option when the preferred editor is available', () => {
    isEditorAvailableMock.mockReturnValue(true);

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={config}
        availableTerminalHeight={30}
        contentWidth={80}
      />,
      { settings },
    );

    expect(isEditorAvailableMock).toHaveBeenCalledWith('vscode');
    expect(lastFrame()).toContain('Modify with external editor');
  });

  it('hides the modify option when the configured editor is unavailable', () => {
    isEditorAvailableMock.mockReturnValue(false);

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={config}
        availableTerminalHeight={30}
        contentWidth={80}
      />,
      { settings },
    );

    expect(isEditorAvailableMock).toHaveBeenCalledWith('vscode');
    expect(lastFrame()).not.toContain('Modify with external editor');
  });
});
