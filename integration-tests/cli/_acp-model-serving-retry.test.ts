/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  isTransientModelServingError,
  withTransientModelServingRetry,
} from './_acp-model-serving-retry.js';

// The failure shape the macOS E2E leg received twice from the shared gateway
// (#11271): the agent wraps the upstream model-serving error as a JSON-RPC
// -32603, and the test client's handleResponse rejects the waiter with the
// error object stashed on `error.response`.
const OBSERVED_GATEWAY_ERROR = {
  code: -32603,
  message: 'Internal error',
  data: {
    details:
      'An error occurred in model serving, error message is: ' +
      '[An internal error occurred while processing the request. ' +
      'Please try again later.]',
  },
};

function rejectionWith(response: unknown): Error {
  const error = new Error('Internal error');
  (error as Error & { response?: unknown }).response = response;
  return error;
}

describe('isTransientModelServingError', () => {
  it('matches the observed gateway -32603', () => {
    expect(
      isTransientModelServingError(rejectionWith(OBSERVED_GATEWAY_ERROR)),
    ).toBe(true);
  });

  it('does not match a -32603 raised by the agent itself', () => {
    expect(
      isTransientModelServingError(
        rejectionWith({
          code: -32603,
          message: 'Internal error',
          data: { details: 'Loop protection stopped this turn' },
        }),
      ),
    ).toBe(false);
  });

  it('does not match other failures a waiter can reject with', () => {
    expect(
      isTransientModelServingError(
        rejectionWith({
          code: -32602,
          message: 'Invalid params',
          data: { details: 'model serving wording elsewhere does not count' },
        }),
      ),
    ).toBe(false);
    expect(isTransientModelServingError(new Error('timed out'))).toBe(false);
  });
});

describe('withTransientModelServingRetry', () => {
  it('resolves without retrying when the prompt succeeds first try', async () => {
    const sendPrompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    await expect(
      withTransientModelServingRetry(sendPrompt, 0),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('re-issues the prompt after a transient model-serving -32603', async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(rejectionWith(OBSERVED_GATEWAY_ERROR))
      .mockResolvedValue({ stopReason: 'end_turn' });

    await expect(
      withTransientModelServingRetry(sendPrompt, 0),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(sendPrompt).toHaveBeenCalledTimes(2);
  });

  it('still fails a persistent outage after a bounded number of attempts', async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValue(rejectionWith(OBSERVED_GATEWAY_ERROR));

    await expect(
      withTransientModelServingRetry(sendPrompt, 0),
    ).rejects.toMatchObject({ response: OBSERVED_GATEWAY_ERROR });
    expect(sendPrompt).toHaveBeenCalledTimes(3);
  });

  it('does not retry a -32603 the gateway did not cause', async () => {
    const agentBug = rejectionWith({
      code: -32603,
      message: 'Internal error',
      data: { details: 'Loop protection stopped this turn' },
    });
    const sendPrompt = vi.fn().mockRejectedValue(agentBug);

    await expect(withTransientModelServingRetry(sendPrompt, 0)).rejects.toBe(
      agentBug,
    );
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });
});
