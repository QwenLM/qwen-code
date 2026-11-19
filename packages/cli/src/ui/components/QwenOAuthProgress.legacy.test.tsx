/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { expect, it, vi } from 'vitest';
import { QwenOAuthProgress } from './QwenOAuthProgress.js';

vi.mock('../hooks/useKeypress.js', () => ({ useKeypress: vi.fn() }));
vi.mock('ink-link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

it('keeps the legacy OAuth progress UI separate from subscription sign-in', () => {
  const ui = render(
    <QwenOAuthProgress
      deviceAuth={{
        device_code: 'legacy-device',
        user_code: 'LEGACY',
        verification_uri: 'https://example.com/device',
        verification_uri_complete: 'https://example.com/device?code=LEGACY',
        expires_in: 300,
      }}
      authStatus="polling"
      onTimeout={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  try {
    expect(ui.lastFrame()).toContain('Qwen OAuth Authentication');
    expect(ui.lastFrame()).toContain('Time remaining:');
    expect(ui.lastFrame()).not.toContain('Qwen Subscription');
    expect(ui.lastFrame()).not.toContain('Opening chat.qwen.ai');
  } finally {
    ui.unmount();
  }
});
