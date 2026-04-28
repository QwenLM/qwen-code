/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { GeminiSpinner } from './GeminiRespondingSpinner.js';

describe('<GeminiSpinner />', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses a low-frequency fixed-width indicator inside tmux', () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,12345,0');

    const { lastFrame } = render(<GeminiSpinner />);

    expect(lastFrame()).toContain('.');
  });
});
