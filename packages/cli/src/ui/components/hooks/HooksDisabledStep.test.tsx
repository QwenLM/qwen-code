/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { HooksDisabledStep } from './HooksDisabledStep.js';

// Mock i18n module
vi.mock('../../../i18n/index.js', () => ({
  t: vi.fn((key: string, options?: { count?: string }) => {
    // Handle pluralization
    if (key === '{{count}} configured hook' && options?.count) {
      return `${options.count} configured hook`;
    }
    if (key === '{{count}} configured hooks' && options?.count) {
      return `${options.count} configured hooks`;
    }
    // Handle interpolation for main message
    if (
      key ===
        'All hooks are currently disabled. You have {{count}} that are not running.' &&
      options?.count
    ) {
      return `All hooks are currently disabled. You have ${options.count} that are not running.`;
    }
    return key;
  }),
}));

// Mock semantic-colors
vi.mock('../../semantic-colors.js', () => ({
  theme: {
    text: {
      primary: 'white',
      secondary: 'gray',
    },
    status: {
      warning: 'yellow',
      error: 'red',
      success: 'green',
    },
  },
}));

describe('HooksDisabledStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render disabled title', () => {
    const { lastFrame } = render(
      <HooksDisabledStep configuredHooksCount={2} />,
    );

    expect(lastFrame()).toContain('Hook Configuration - Disabled');
  });

  it('should show configured hooks count', () => {
    const { lastFrame } = render(
      <HooksDisabledStep configuredHooksCount={2} />,
    );

    expect(lastFrame()).toContain('2 configured hooks');
  });

  it('should show singular form for single hook', () => {
    const { lastFrame } = render(
      <HooksDisabledStep configuredHooksCount={1} />,
    );

    expect(lastFrame()).toContain('1 configured hook');
  });

  it('should show zero hooks message', () => {
    const { lastFrame } = render(
      <HooksDisabledStep configuredHooksCount={0} />,
    );

    expect(lastFrame()).toContain('0 configured hooks');
  });

  it('should show explanation items', () => {
    const { lastFrame } = render(
      <HooksDisabledStep configuredHooksCount={2} />,
    );

    const output = lastFrame();
    expect(output).toContain('When hooks are disabled:');
    expect(output).toContain('No hook commands will execute');
    expect(output).toContain('StatusLine will not be displayed');
    expect(output).toContain(
      'Tool operations will proceed without hook validation',
    );
  });

  it('should show re-enable instructions', () => {
    const { lastFrame } = render(
      <HooksDisabledStep configuredHooksCount={2} />,
    );

    expect(lastFrame()).toContain('To re-enable hooks');
    expect(lastFrame()).toContain('disableAllHooks');
    expect(lastFrame()).toContain('settings.json');
  });

  it('should show Esc hint', () => {
    const { lastFrame } = render(
      <HooksDisabledStep configuredHooksCount={2} />,
    );

    expect(lastFrame()).toContain('Esc to close');
  });

  it('should handle large hook counts', () => {
    const { lastFrame } = render(
      <HooksDisabledStep configuredHooksCount={100} />,
    );

    expect(lastFrame()).toContain('100 configured hooks');
  });
});
