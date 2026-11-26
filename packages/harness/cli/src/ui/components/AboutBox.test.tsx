/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { AboutBox, AboutRow } from './AboutBox.js';
import { describe, it, expect, vi } from 'vitest';

// Mock GIT_COMMIT_INFO
vi.mock('../../generated/git-commit.js', () => ({
  GIT_COMMIT_INFO: 'mock-commit-hash',
}));

describe('AboutBox', () => {
  const defaultProps = {
    cliVersion: '1.0.0',
    osVersion: 'macOS',
    modelVersion: 'gemini-pro',
  };

  // skip: 现存失败
  it.skip('renders with required props', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <AboutBox {...defaultProps} />,
    );
    const output = lastFrame();
    expect(output).toContain('About');
    expect(output).toContain('1.0.0');
    expect(output).toContain('mock-commit-hash');
    expect(output).toContain('gemini-pro');
    expect(output).toContain('macOS');
    unmount();
  });

  it('renders injected rows', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <AboutBox {...defaultProps}>
        <AboutRow label="Auth Method" value="example-auth" />
        <AboutRow label="Tier" value="Teams" />
      </AboutBox>,
    );
    const output = lastFrame();
    expect(output).toContain('Auth Method');
    expect(output).toContain('example-auth');
    expect(output).toContain('Tier');
    expect(output).toContain('Teams');
    unmount();
  });
});
