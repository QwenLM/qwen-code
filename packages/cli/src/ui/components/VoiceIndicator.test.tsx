/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { VoiceIndicator } from './VoiceIndicator.js';

describe('<VoiceIndicator />', () => {
  it('sanitizes streaming interim transcript text', () => {
    const { lastFrame } = render(
      <VoiceIndicator
        status="recording"
        interimText={'partial\x1b[8m hidden\x1b[0m'}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('partial\\u001b[8m hidden\\u001b[0m');
    expect(frame).not.toContain('\x1b[8m');
  });
});
