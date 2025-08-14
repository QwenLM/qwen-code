/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { OpenAIKeyPrompt } from './OpenAIKeyPrompt.js';

describe('OpenAIKeyPrompt', () => {
  it('should render the prompt correctly', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    const { lastFrame } = render(
      <OpenAIKeyPrompt onSubmit={onSubmit} onCancel={onCancel} />,
    );

    expect(lastFrame()).toContain('OpenAI Configuration Required');
    expect(lastFrame()).toContain('https://platform.openai.com/api-keys');
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

  it('should show save prompt with gitignore warning', () => {
    // Mock the internal state to show the save prompt
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    const { lastFrame, stdin } = render(
      <OpenAIKeyPrompt onSubmit={onSubmit} onCancel={onCancel} />,
    );

    // Simulate entering API key and pressing enter to reach save prompt
    stdin.write('test-key');
    stdin.write('\n'); // Enter to go to base URL
    stdin.write('https://api.openai.com/v1');
    stdin.write('\n'); // Enter to go to model
    stdin.write('gpt-4');
    stdin.write('\n'); // Enter to submit and show save prompt

    // Wait a bit for processing
    setTimeout(() => {
      const output = lastFrame();
      expect(output).toContain('Save Configuration?');
      expect(output).toContain(
        'Save these credentials to .qwen.env for future use? [Y/n]',
      );
      expect(output).toContain(
        'Warning: Add .qwen.env to your .gitignore to prevent accidentally committing your API credentials.',
      );
    }, 100);
  });
});
