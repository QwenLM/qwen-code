/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateTheme } from './theme.js';

const mockFindThemeByName = vi.fn();
vi.mock('../ui/themes/theme-manager.js', () => ({
  themeManager: {
    findThemeByName: (...args: unknown[]) => mockFindThemeByName(...args),
  },
}));

vi.mock('../i18n/index.js', () => ({
  t: (msg: string, params?: Record<string, string>) => {
    if (params) {
      return msg.replace(
        /\{\{(\w+)\}\}/g,
        (_, key) => params[key] ?? `{{${key}}}`,
      );
    }
    return msg;
  },
}));

describe('validateTheme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null when no theme is configured', () => {
    const settings = { merged: { ui: {} } };
    const result = validateTheme(settings as never);
    expect(result).toBeNull();
  });

  it('should return null when theme is found', () => {
    mockFindThemeByName.mockReturnValue({ name: 'dark' });
    const settings = { merged: { ui: { theme: 'dark' } } };

    const result = validateTheme(settings as never);

    expect(result).toBeNull();
    expect(mockFindThemeByName).toHaveBeenCalledWith('dark');
  });

  it('should return error message when theme is not found', () => {
    mockFindThemeByName.mockReturnValue(undefined);
    const settings = { merged: { ui: { theme: 'nonexistent-theme' } } };

    const result = validateTheme(settings as never);

    expect(result).toBe('Theme "nonexistent-theme" not found.');
  });

  it('should return null when ui section is undefined', () => {
    const settings = { merged: {} };
    const result = validateTheme(settings as never);
    expect(result).toBeNull();
  });
});
