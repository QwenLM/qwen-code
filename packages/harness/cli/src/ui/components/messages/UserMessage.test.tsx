/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../../test-utils/render.js';
import { UserMessage } from './UserMessage.js';
import { UserShellMessage } from './UserShellMessage.js';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { makeFakeConfig } from '@qwen-code/core';

// Mock the commandUtils to control isSlashCommand behavior
vi.mock('../../utils/commandUtils.js', () => ({
  isSlashCommand: vi.fn((text: string) => text.startsWith('/')),
}));
describe('UserMessage', () => {
  const createConfigWithBackground = () => {
    const config = makeFakeConfig({});
    vi.spyOn(config, 'getUseBackgroundColor').mockReturnValue(true);
    return config;
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders normal user message with correct prefix', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <UserMessage text="Hello Gemini" width={80} />,
      { width: 80 },
    );
    const output = lastFrame();

    expect(output).toMatchSnapshot();
    unmount();
  });

  it('renders slash command message', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <UserMessage text="/help" width={80} />,
      { width: 80 },
    );
    const output = lastFrame();

    expect(output).toMatchSnapshot();
    unmount();
  });

  it('renders multiline user message', async () => {
    const message = 'Line 1\nLine 2';
    const { lastFrame, unmount } = await renderWithProviders(
      <UserMessage text={message} width={80} />,
      { width: 80 },
    );
    const output = lastFrame();

    expect(output).toMatchSnapshot();
    unmount();
  });

  it('transforms image paths in user message', async () => {
    const message = 'Check out this image: @/path/to/my-image.png';
    const { lastFrame, unmount } = await renderWithProviders(
      <UserMessage text={message} width={80} />,
      { width: 80 },
    );
    const output = lastFrame();

    expect(output).toContain('[Image my-image.png]');
    expect(output).toMatchSnapshot();
    unmount();
  });

  it('renders a compact message band without half-block edges', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <UserMessage text="Hello Gemini" width={80} />,
      { width: 80, config: createConfigWithBackground() },
    );

    expect(lastFrame()).toBe(' > Hello Gemini\n');
    expect(lastFrame()).not.toMatch(/[▀▄]/);
    unmount();
  });

  it('applies the solid format to shell user messages', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <UserShellMessage text="!ls -la" width={80} />,
      { width: 80, config: createConfigWithBackground() },
    );

    expect(lastFrame()).not.toContain('▄');
    expect(lastFrame()).not.toContain('▀');
    expect(lastFrame()).toContain('ls -la');
    unmount();
  });
});
