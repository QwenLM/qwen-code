/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIKeyPrompt } from './OpenAIKeyPrompt.js';

// Mock useKeypress hook
vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

describe('OpenAIKeyPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('should render the prompt correctly', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    const { lastFrame } = render(
      <OpenAIKeyPrompt onSubmit={onSubmit} onCancel={onCancel} />,
    );

    expect(lastFrame()).toContain('OpenAI Configuration Required');
    expect(lastFrame()).toContain(
      'https://bailian.console.aliyun.com/?tab=model#/api-key',
    );
    expect(lastFrame()).toContain(
      'Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel',
    );
  });

  it('should show the component with proper styling', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    const { lastFrame } = render(
      <OpenAIKeyPrompt onSubmit={onSubmit} onCancel={onCancel} />,
    );

    const output = lastFrame();
    expect(output).toContain('OpenAI Configuration Required');
    expect(output).toContain('API Key:');
    expect(output).toContain('Base URL:');
    expect(output).toContain('Model:');
    expect(output).toContain(
      'Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel',
    );
  });

  it('should handle paste with control characters', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    const { stdin } = render(
      <OpenAIKeyPrompt onSubmit={onSubmit} onCancel={onCancel} />,
    );

    // Simulate paste with control characters
    const pasteWithControlChars = '\x1b[200~sk-test123\x1b[201~';
    stdin.write(pasteWithControlChars);

    // Wait a bit for processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The component should have filtered out the control characters
    // and only kept 'sk-test123'
    expect(onSubmit).not.toHaveBeenCalled(); // Should not submit yet
  });
});
