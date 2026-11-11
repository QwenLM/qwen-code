/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createLoadedSettings } from '../config/settings.js';
import type {
  LoadedSettings} from '../config/settings.js';
import {
  createTestMergedSettings,
  type SettingsError,
} from '../config/settings.js';

export interface MockSettingsFile {
  settings: any;
  originalSettings: any;
  path: string;
  readOnly?: boolean;
}

interface CreateMockSettingsOptions {
  user?: MockSettingsFile;
  project?: MockSettingsFile;
  isTrusted?: boolean;
  errors?: SettingsError[];
  merged?: any;
  [key: string]: any;
}

/**
 * Creates a mock LoadedSettings object for testing.
 *
 * @param overrides - Partial settings or LoadedSettings properties to override.
 *                   If 'merged' is provided, it overrides the computed merged settings.
 *                   Any functions in overrides are assigned directly to the LoadedSettings instance.
 */
export const createMockSettings = (
  overrides: CreateMockSettingsOptions = {},
): LoadedSettings => {
  const {
    user,
    project,
    isTrusted,
    errors,
    merged: mergedOverride,
    ...settingsOverrides
  } = overrides;

  const loaded = createLoadedSettings(
    (user as any) || {
      path: '',
      settings: settingsOverrides,
      originalSettings: settingsOverrides,
    },
    (project as any) || { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} } as any,
    isTrusted ?? true,
    errors || [],
  );

  if (mergedOverride) {
    // @ts-expect-error - overriding private field for testing
    loaded._merged = createTestMergedSettings(mergedOverride);
  }

  // Assign any function overrides (e.g., vi.fn() for methods)
  for (const key in overrides) {
    if (typeof overrides[key] === 'function') {
      (loaded as any)[key] = overrides[key];
    }
  }

  return loaded;
};
