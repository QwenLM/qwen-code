/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
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

  // Regression: Footer.tsx renders <GeminiSpinner /> inside a <Text> wrapper
  // ('<Text>...<GeminiSpinner /> {msg}</Text>'). Ink forbids <Box> from being
  // nested inside <Text>, so the tmux branch must return a <Text>, not a
  // <Box>-wrapped one — otherwise the CLI throws on startup inside tmux.
  it('renders without throwing when nested inside a <Text> (Footer context)', () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,12345,0');

    expect(() =>
      render(
        <Text>
          <GeminiSpinner /> startup message
        </Text>,
      ),
    ).not.toThrow();
  });
});
