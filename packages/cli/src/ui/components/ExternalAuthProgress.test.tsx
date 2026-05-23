/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ExternalAuthProgress } from './ExternalAuthProgress.js';

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

describe('ExternalAuthProgress', () => {
  it('shows cancel hint when cancel is available', () => {
    const onCancel = vi.fn();
    const { lastFrame } = render(
      <ExternalAuthProgress
        title="OpenRouter Authentication"
        message="Open the authorization page if your browser does not launch automatically."
        detail="https://openrouter.ai/auth?example=1"
        onCancel={onCancel}
      />,
    );

    expect(lastFrame()).toContain('Esc to cancel');
  });
});
