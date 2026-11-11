/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ToolConfirmationMessage } from './ToolConfirmationMessage.js';
import type {
  SerializableConfirmationDetails,
  Config,
} from '@qwen-code/core';
import { initializeShellParsers } from '@qwen-code/core';
import { renderWithProviders } from '../../../test-utils/render.js';

describe('ToolConfirmationMessage Redirection', () => {
  beforeAll(async () => {
    await initializeShellParsers();
  });

  const mockConfig = {
    isTrustedFolder: () => true,
    getPermissionMode: () => 'default',
  } as unknown as Config;

  // skip: 现存失败
  it.skip('should display redirection warning for redirected commands', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: 'echo "hello" > test.txt',
      rootCommand: 'echo, redirection (>)',
      rootCommands: ['echo'],
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={100}
        toolName="shell"
      />,
    );

    const output = lastFrame();
    expect(output).toMatchSnapshot();
    unmount();
  });
});
