/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { ContextUsageDisplay } from './ContextUsageDisplay.js';
import { describe, it, expect, vi } from 'vitest';
import { createMockSettings } from '../../test-utils/settings.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    tokenLimit: () => 10000,
  };
});

describe('ContextUsageDisplay', () => {
  it('renders correct percentage used', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={5000}
        model="gemini-pro"
        terminalWidth={120}
        contextWindowSize={10000}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('50% used');
    unmount();
  });

  it('renders correctly when usage is 0%', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={0}
        model="gemini-pro"
        terminalWidth={120}
        contextWindowSize={10000}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('0% used');
    unmount();
  });

  it('renders abbreviated label when terminal width is small', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={2000}
        model="gemini-pro"
        terminalWidth={80}
        contextWindowSize={10000}
      />,
      { width: 80 },
    );
    const output = lastFrame();
    expect(output).toContain('20%');
    expect(output).not.toContain('context used');
    unmount();
  });

  it('renders 80% correctly', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={8000}
        model="gemini-pro"
        terminalWidth={120}
        contextWindowSize={10000}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('80% used');
    unmount();
  });

  it('renders 100% when full', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={10000}
        model="gemini-pro"
        terminalWidth={120}
        contextWindowSize={10000}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('100% used');
    unmount();
  });

  it('localizes the full-width label while preserving the percentage', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={5000}
        model="gemini-pro"
        terminalWidth={120}
        contextWindowSize={10000}
      />,
      { settings },
    );
    expect(lastFrame()).toContain('已使用 50%');
    unmount();
  });
});
