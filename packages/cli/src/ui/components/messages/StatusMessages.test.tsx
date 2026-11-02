/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { InfoMessage } from './StatusMessages.js';

const mockLink = vi.fn(
  ({ children }: { children: React.ReactNode; url: string }): React.ReactNode =>
    children,
);

vi.mock('ink-link', () => ({
  default: (props: { children: React.ReactNode; url: string }) =>
    mockLink(props),
}));

describe('InfoMessage', () => {
  it('renders all four subscription summary lines without truncating commands', () => {
    const { lastFrame, unmount } = render(
      <InfoMessage
        presentation="subscription-success"
        text={
          '✓ Signed in successfully · user@example.com\n✓ Current plan: Qwen Plus. Qwen Code is ready.\n  Model: qwen3.8-flash\n  Common commands: /usage   /upgrade   /status   /logout'
        }
      />,
    );
    expect(lastFrame()).toContain('Signed in successfully · user@example.com');
    expect(lastFrame()).toContain('Current plan: Qwen Plus');
    expect(lastFrame()).toContain('Model: qwen3.8-flash');
    expect(lastFrame()).toContain('/usage   /upgrade   /status   /logout');
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
