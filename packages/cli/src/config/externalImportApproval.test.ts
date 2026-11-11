/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { coreEvents } from '@qwen-code/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateValue: vi.fn(),
  setValue: vi.fn(),
}));

import {
  approveExternalImportsForProject,
  enableAllExternalImports,
} from './externalImportApproval.js';
import { SettingScope, type LoadedSettings } from './settings.js';

describe('externalImportApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateValue.mockReturnValue(true);
    mocks.setValue.mockReturnValue(true);
  });

  const settings = {
    user: { path: '/user/settings.json', readOnly: false },
    updateValue: mocks.updateValue,
    setValue: mocks.setValue,
  } as unknown as LoadedSettings;

  it('appends and deduplicates projects from the value read inside the mutation', () => {
    expect(approveExternalImportsForProject('/project/new', settings)).toBe(
      true,
    );

    expect(mocks.updateValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.approvedExternalImportProjects',
      expect.any(Function),
    );
    const updater = mocks.updateValue.mock.calls[0][2] as (
      current: unknown,
    ) => unknown;
    expect(updater(['/project/existing'])).toEqual([
      '/project/existing',
      '/project/new',
    ]);
    expect(updater(['/project/new'])).toEqual(['/project/new']);
  });

  it.each([
    { path: '/user/settings.json', readOnly: true },
    { path: '', readOnly: false },
  ])(
    'rejects permanent approvals for a non-persistable User layer: %j',
    (user) => {
      const feedback = vi
        .spyOn(coreEvents, 'emitFeedback')
        .mockImplementation(() => {});
      const readonly = { ...settings, user } as LoadedSettings;
      try {
        expect(approveExternalImportsForProject('/project/new', readonly)).toBe(
          false,
        );
        expect(enableAllExternalImports(readonly)).toBe(false);
        expect(mocks.updateValue).not.toHaveBeenCalled();
        expect(mocks.setValue).not.toHaveBeenCalled();
        expect(feedback).toHaveBeenCalledWith(
          'error',
          expect.stringContaining('Cannot save permanent approval'),
        );
      } finally {
        feedback.mockRestore();
      }
    },
  );

  it('uses a scalar field mutation for the global approval flag', () => {
    expect(enableAllExternalImports(settings)).toBe(true);

    expect(mocks.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.enableAllExternalImports',
      true,
    );
  });
});
