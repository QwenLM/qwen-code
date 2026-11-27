/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_USER_DIALOG_TIMEOUT_MS } from '@qwen-code/core';
import {
  DEFAULT_DIALOG_TIMEOUT_MS,
  NO_TIMEOUT,
  resolveDialogTimeoutMs,
  resolvePeerApprovalTimeoutMs,
} from './dialogExpiry.js';
import type { LoadedSettings } from './settings.js';

/** Settings stand-in; only the scopes the resolver reads are populated. */
function makeSettings(values: Record<string, string | undefined> = {}) {
  const file = (value: string | undefined, path: string) => ({
    path,
    settings: value === undefined ? {} : { general: { dialogExpiry: value } },
  });
  return {
    user: file(values['user'], '/home/dev/.qwen/settings.json'),
    project: file(values['project'], '/repo/.qwen/settings.json'),
    local: file(values['local'], '/repo/.qwen/settings.local.json'),
    flag: file(values['flag'], '/tmp/flag.json'),
  } as unknown as LoadedSettings;
}

describe('dialogExpiry', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[ENV_USER_DIALOG_TIMEOUT_MS];
    delete process.env[ENV_USER_DIALOG_TIMEOUT_MS];
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_USER_DIALOG_TIMEOUT_MS];
    else process.env[ENV_USER_DIALOG_TIMEOUT_MS] = previous;
  });

  describe('resolveDialogTimeoutMs', () => {
    it('[AC9] defaults to five minutes', () => {
      expect(resolveDialogTimeoutMs(makeSettings())).toBe(
        DEFAULT_DIALOG_TIMEOUT_MS,
      );
    });

    it('[AC9] maps each configured value', () => {
      expect(resolveDialogTimeoutMs(makeSettings({ user: '60s' }))).toBe(60_000);
      expect(resolveDialogTimeoutMs(makeSettings({ user: '5m' }))).toBe(300_000);
      expect(resolveDialogTimeoutMs(makeSettings({ user: '10m' }))).toBe(600_000);
    });

    // NO_TIMEOUT is 0 meaning "no timer", not "expire immediately"; every
    // consumer guards with `> 0`.
    it('[AC9] maps never to no timer at all', () => {
      expect(resolveDialogTimeoutMs(makeSettings({ user: 'never' }))).toBe(
        NO_TIMEOUT,
      );
      expect(NO_TIMEOUT).toBe(0);
    });

    it('[AC9] prefers the flag scope over user settings', () => {
      expect(
        resolveDialogTimeoutMs(makeSettings({ flag: '60s', user: '10m' })),
      ).toBe(60_000);
    });

    // A timeout has no severity order, so there is no safe direction in which
    // a repository could move it. The repo scopes are simply not read.
    it('[AC9] ignores project and local project values', () => {
      expect(
        resolveDialogTimeoutMs(makeSettings({ project: '60s', local: '60s' })),
      ).toBe(DEFAULT_DIALOG_TIMEOUT_MS);
    });

    it('[AC9] lets the env override beat a configured value', () => {
      process.env[ENV_USER_DIALOG_TIMEOUT_MS] = '1234';
      expect(resolveDialogTimeoutMs(makeSettings({ user: '10m' }))).toBe(1234);
    });

    it('[AC9] ignores a malformed env override', () => {
      process.env[ENV_USER_DIALOG_TIMEOUT_MS] = 'soon';
      expect(resolveDialogTimeoutMs(makeSettings({ user: '60s' }))).toBe(60_000);
    });

    it('ignores an unrecognized setting value', () => {
      expect(resolveDialogTimeoutMs(makeSettings({ user: '3h' }))).toBe(
        DEFAULT_DIALOG_TIMEOUT_MS,
      );
    });
  });

  describe('resolvePeerApprovalTimeoutMs', () => {
    it('[AC10] clamps never back to the default', () => {
      expect(resolvePeerApprovalTimeoutMs(makeSettings({ user: 'never' }))).toBe(
        DEFAULT_DIALOG_TIMEOUT_MS,
      );
    });

    it('[AC10] leaves every bounded value alone', () => {
      expect(resolvePeerApprovalTimeoutMs(makeSettings({ user: '60s' }))).toBe(
        60_000,
      );
      expect(resolvePeerApprovalTimeoutMs(makeSettings())).toBe(
        DEFAULT_DIALOG_TIMEOUT_MS,
      );
    });

    // One approval is outstanding at a time, so an env override of 0 would
    // otherwise let a single unanswered prompt mute every later one.
    it('[AC10] clamps an unbounded env override too', () => {
      process.env[ENV_USER_DIALOG_TIMEOUT_MS] = '0';
      expect(resolvePeerApprovalTimeoutMs(makeSettings())).toBe(
        DEFAULT_DIALOG_TIMEOUT_MS,
      );
      expect(resolveDialogTimeoutMs(makeSettings())).toBe(NO_TIMEOUT);
    });
  });
});
