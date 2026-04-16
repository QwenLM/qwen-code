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
