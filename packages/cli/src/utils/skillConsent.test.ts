/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { requestConsentInteractive } from './skillConsent.js';
import type { ConfirmationRequest } from '../ui/types.js';

describe('requestConsentInteractive', () => {
  it('clears the confirmation request after onConfirm and resolves with the user choice', async () => {
    const calls: Array<ConfirmationRequest | null> = [];
    const setConfirmationRequest = vi.fn(
      (value: ConfirmationRequest | null) => {
        calls.push(value);
      },
    );

    const pending = requestConsentInteractive(
      'proceed?',
      setConfirmationRequest,
    );

    // First call enqueues the modal.
    expect(setConfirmationRequest).toHaveBeenCalledTimes(1);
    const enqueued = calls[0];
    expect(enqueued).not.toBeNull();
    const request = enqueued as ConfirmationRequest;
    expect(request.onConfirm).toBeTypeOf('function');
    expect(request.onCancel).toBeTypeOf('function');

    // Simulate the user picking "Yes".
    request.onConfirm(true);

    await expect(pending).resolves.toBe(true);
    // Second call clears the modal — this is the regression that caused
    // `/skills link` to freeze the UI.
    expect(setConfirmationRequest).toHaveBeenCalledTimes(2);
    expect(setConfirmationRequest).toHaveBeenLastCalledWith(null);
  });

  it('treats onCancel as a "No" response and clears the modal', async () => {
    const calls: Array<ConfirmationRequest | null> = [];
    const setConfirmationRequest = vi.fn(
      (value: ConfirmationRequest | null) => {
        calls.push(value);
      },
    );

    const pending = requestConsentInteractive(
      'proceed?',
      setConfirmationRequest,
    );

    const request = calls[0] as ConfirmationRequest;
    expect(request.onCancel).toBeTypeOf('function');
    request.onCancel!();

    await expect(pending).resolves.toBe(false);
    expect(setConfirmationRequest).toHaveBeenLastCalledWith(null);
  });
});
