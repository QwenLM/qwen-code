/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ErrorMessage, InfoMessage } from './StatusMessages.js';
import { initializeI18n, setLanguageAsync, t } from '../../../i18n/index.js';
import { parseAndFormatApiError } from '@qwen-code/qwen-code-core/utils/errorParsing.js';

const mockLink = vi.fn(
  ({ children }: { children: React.ReactNode; url: string }): React.ReactNode =>
    children,
);

vi.mock('ink-link', () => ({
  default: (props: { children: React.ReactNode; url: string }) =>
    mockLink(props),
}));

describe('InfoMessage', () => {
  it('renders the shared quota guidance in the CLI language', async () => {
    await initializeI18n('zh');
    const { lastFrame, unmount } = render(
      <ErrorMessage
        text={parseAndFormatApiError(
          {
            message: 'quota fallback',
            status: 402,
            subscriptionQuota: {
              type: 'subscription_quota',
              memberType: 'plus',
              resetAt: Math.floor(Date.now() / 1000) + 3 * 3600,
            },
          },
          undefined,
          t,
        )}
      />,
    );
    try {
      expect(lastFrame()).toContain('周额度已用完');
      expect(lastFrame()).toContain('3小时后恢复');
      expect(lastFrame()).toContain('/upgrade');
    } finally {
      unmount();
      await setLanguageAsync('en');
    }
  });
  it('renders all four subscription summary lines without truncating commands', () => {
    const { lastFrame, unmount } = render(
      <InfoMessage
        presentation="subscription-success"
        text={
          '✓ Signed in successfully · user@example.com\n✓ Current plan: Qwen Plus. Qwen Code is ready.\n  Model: qwen3.8-flash\n  Common commands: /usage   /upgrade   /model   /status   /logout'
        }
      />,
    );
    expect(lastFrame()).toContain('Signed in successfully · user@example.com');
    expect(lastFrame()).toContain('Current plan: Qwen Plus');
    expect(lastFrame()).toContain('Model: qwen3.8-flash');
    expect(lastFrame()).toContain(
      '/usage   /upgrade   /model   /status   /logout',
    );
    unmount();
  });

  it('renders a clickable link label when link metadata is provided', () => {
    const url = 'https://example.com/report';
    const { lastFrame } = render(
      <InfoMessage
        text="To submit your bug report, please open the following URL in your browser:"
        linkUrl={url}
        linkText="Open GitHub bug report form"
      />,
    );

    expect(lastFrame()).toContain(
      'To submit your bug report, please open the following URL in your browser:',
    );
    expect(lastFrame()).toContain('Open GitHub bug report form');
    expect(mockLink).toHaveBeenCalledWith({
      children: expect.anything(),
      url,
    });
  });
});
