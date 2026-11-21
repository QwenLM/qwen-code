/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthClient } from 'google-auth-library';
import type { Config } from '../config/config.js';
import { CodeAssistServer } from './server.js';
import {
  InvalidNumericProjectIdError,
  resetUserDataCacheForTesting,
  setupUser,
} from './setup.js';
import type { ValidationRequiredError } from './setup.js';
import {
  IneligibleTierReasonCode,
  type LoadCodeAssistResponse,
} from './types.js';

const client = {} as AuthClient;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const config = { getSessionId: () => 'session-1' } as Config;

describe('setupUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUserDataCacheForTesting();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('uses an existing paid tier before the current tier', async () => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      cloudaicompanionProject: 'project-1',
      currentTier: { id: 'free-tier', name: 'Free' },
      paidTier: { id: 'standard-tier', name: 'Paid' },
    });
    const onboard = vi.spyOn(CodeAssistServer.prototype, 'onboardUser');

    await expect(setupUser(client, config)).resolves.toMatchObject({
      projectId: 'project-1',
      userTier: 'standard-tier',
      userTierName: 'Paid',
    });
    expect(onboard).not.toHaveBeenCalled();
  });

  it('omits the project for free-tier onboarding', async () => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      allowedTiers: [{ id: 'free-tier', name: 'Free', isDefault: true }],
    });
    const onboard = vi
      .spyOn(CodeAssistServer.prototype, 'onboardUser')
      .mockResolvedValue({
        done: true,
        response: { cloudaicompanionProject: { id: 'managed-project' } },
      });
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'user-project');

    await expect(setupUser(client, config)).resolves.toMatchObject({
      projectId: 'managed-project',
      userTier: 'free-tier',
    });
    expect(onboard).toHaveBeenCalledWith(
      expect.objectContaining({ cloudaicompanionProject: undefined }),
      expect.any(AbortSignal),
    );
  });

  it('polls an unfinished onboarding operation', async () => {
    vi.useFakeTimers();
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      allowedTiers: [
        { id: 'standard-tier', name: 'Standard', isDefault: true },
      ],
    });
    vi.spyOn(CodeAssistServer.prototype, 'onboardUser').mockResolvedValue({
      done: false,
      name: 'operations/onboard-1',
    });
    const getOperation = vi
      .spyOn(CodeAssistServer.prototype, 'getOperation')
      .mockResolvedValue({
        done: true,
        response: { cloudaicompanionProject: { id: 'project-after-poll' } },
      });
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'user-project');

    const pending = setupUser(client, config);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toMatchObject({
      projectId: 'project-after-poll',
    });
    expect(getOperation).toHaveBeenCalledWith(
      'operations/onboard-1',
      expect.any(AbortSignal),
    );
  });

  it('rejects a numeric project number before network access', async () => {
    const load = vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '123456789');
    await expect(setupUser(client, config)).rejects.toBeInstanceOf(
      InvalidNumericProjectIdError,
    );
    expect(load).not.toHaveBeenCalled();
  });

  it('surfaces validation-required responses with a validation link', async () => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      ineligibleTiers: [
        {
          reasonCode: IneligibleTierReasonCode.VALIDATION_REQUIRED,
          reasonMessage: 'Verify this account',
          validationUrl: 'https://validation.test',
        },
      ],
    });
    await expect(setupUser(client, config)).rejects.toMatchObject({
      name: 'ValidationRequiredError',
      validationLink: 'https://validation.test',
    } satisfies Partial<ValidationRequiredError>);
  });

  it('uses a paid tier even when currentTier is absent', async () => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      cloudaicompanionProject: 'project-paid',
      paidTier: { id: 'standard-tier', name: 'Paid' },
    });
    const onboard = vi.spyOn(CodeAssistServer.prototype, 'onboardUser');
    await expect(setupUser(client, config)).resolves.toMatchObject({
      projectId: 'project-paid',
      userTier: 'standard-tier',
      userTierName: 'Paid',
    });
    expect(onboard).not.toHaveBeenCalled();
  });

  it('keeps the tier id and name from the same tier', async () => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      cloudaicompanionProject: 'project-free',
      currentTier: { id: 'free-tier', name: 'Free' },
      paidTier: { name: 'Paid without an id' },
    });
    await expect(setupUser(client, config)).resolves.toMatchObject({
      userTier: 'free-tier',
      userTierName: 'Free',
    });
  });

  it('isolates caller cancellation and does not expire a pending setup', async () => {
    vi.useFakeTimers();
    const loaded = deferred<LoadCodeAssistResponse>();
    const load = vi
      .spyOn(CodeAssistServer.prototype, 'loadCodeAssist')
      .mockReturnValue(loaded.promise);
    const first = new AbortController();
    const second = new AbortController();
    const firstResult = setupUser(client, config, {}, first.signal);
    const secondResult = setupUser(client, config, {}, second.signal);
    await vi.advanceTimersByTimeAsync(31_000);
    first.abort(new Error('first caller cancelled'));
    await expect(firstResult).rejects.toThrow('first caller cancelled');
    loaded.resolve({
      cloudaicompanionProject: 'shared-project',
      currentTier: { id: 'free-tier', name: 'Free' },
    });
    await expect(secondResult).resolves.toMatchObject({
      projectId: 'shared-project',
    });
    expect(load).toHaveBeenCalledOnce();
    expect(load.mock.calls[0]?.[1]).not.toBe(first.signal);
    await expect(
      setupUser(client, config, {}, second.signal),
    ).resolves.toMatchObject({ projectId: 'shared-project' });
    second.abort(new Error('cached caller cancelled'));
    await expect(setupUser(client, config, {}, second.signal)).rejects.toThrow(
      'cached caller cancelled',
    );
    expect(load).toHaveBeenCalledOnce();
  });

  it('uses a normalized default tier id in the actual onboarding request', async () => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      allowedTiers: [{ name: 'Standard', isDefault: true }],
    });
    const onboard = vi
      .spyOn(CodeAssistServer.prototype, 'onboardUser')
      .mockResolvedValue({
        done: true,
        response: { cloudaicompanionProject: { id: 'backend-project' } },
      });
    await expect(setupUser(client, config)).resolves.toMatchObject({
      projectId: 'backend-project',
      userTier: 'standard-tier',
    });
    expect(onboard).toHaveBeenCalledWith(
      expect.objectContaining({ tierId: 'standard-tier' }),
      expect.anything(),
    );
  });

  it('rejects an incomplete operation with no name instead of claiming success', async () => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      allowedTiers: [{ id: 'free-tier', isDefault: true }],
    });
    vi.spyOn(CodeAssistServer.prototype, 'onboardUser').mockResolvedValue({
      done: false,
    });
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'user-project');
    await expect(setupUser(client, config)).rejects.toThrow(
      'returned no operation name',
    );
  });

  it.each(['immediate', 'polled'])('rejects an %s LRO error', async (kind) => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      allowedTiers: [{ id: 'standard-tier', isDefault: true }],
    });
    vi.spyOn(CodeAssistServer.prototype, 'onboardUser').mockResolvedValue(
      kind === 'immediate'
        ? { done: true, error: { message: 'onboard denied' } }
        : { done: false, name: 'operations/one' },
    );
    vi.spyOn(CodeAssistServer.prototype, 'getOperation').mockResolvedValue({
      done: true,
      error: { message: 'poll denied' },
    });
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'user-project');
    if (kind === 'polled') vi.useFakeTimers();
    const outcome = setupUser(client, config).catch((error: unknown) => error);
    if (kind === 'polled') await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toMatchObject({
      message: expect.stringContaining(
        kind === 'immediate' ? 'onboard denied' : 'poll denied',
      ),
    });
  });

  it('stops an unfinished operation at the setup deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      allowedTiers: [{ id: 'standard-tier', isDefault: true }],
    });
    vi.spyOn(CodeAssistServer.prototype, 'onboardUser').mockResolvedValue({
      done: false,
      name: 'operations/never-finished',
    });
    const poll = vi
      .spyOn(CodeAssistServer.prototype, 'getOperation')
      .mockResolvedValue({ done: false, name: 'operations/never-finished' });
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'user-project');
    const outcome = setupUser(client, config).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await outcome).toMatchObject({
      message: 'Code Assist setup timed out after 60 seconds.',
    });
    expect(poll).toHaveBeenCalled();
  });

  it('classifies validation-required without a URL and preserves its message', async () => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      ineligibleTiers: [
        {
          reasonCode: IneligibleTierReasonCode.VALIDATION_REQUIRED,
          validationErrorMessage: 'Verify with your administrator',
        },
      ],
    });
    const onboard = vi.spyOn(CodeAssistServer.prototype, 'onboardUser');
    await expect(setupUser(client, config)).rejects.toMatchObject({
      name: 'ValidationRequiredError',
      validationDescription: 'Verify with your administrator',
    } satisfies Partial<ValidationRequiredError>);
    expect(onboard).not.toHaveBeenCalled();
  });

  it('rejects ordinary ineligibility without an allowed default tier', async () => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      ineligibleTiers: [
        { reasonCode: IneligibleTierReasonCode.INELIGIBLE_ACCOUNT },
      ],
    });
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'user-project');
    const onboard = vi.spyOn(CodeAssistServer.prototype, 'onboardUser');
    await expect(setupUser(client, config)).rejects.toMatchObject({
      name: 'IneligibleTierError',
    });
    expect(onboard).not.toHaveBeenCalled();
  });

  it('requires a user project before a tier that declares one', async () => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      allowedTiers: [
        {
          id: 'standard-tier',
          isDefault: true,
          userDefinedCloudaicompanionProject: true,
        },
      ],
    });
    const onboard = vi.spyOn(CodeAssistServer.prototype, 'onboardUser');
    await expect(setupUser(client, config)).rejects.toMatchObject({
      name: 'ProjectIdRequiredError',
    });
    expect(onboard).not.toHaveBeenCalled();
  });

  it('does not fall back to the user project for a free managed tier', async () => {
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      allowedTiers: [{ id: 'free-tier', isDefault: true }],
    });
    vi.spyOn(CodeAssistServer.prototype, 'onboardUser').mockResolvedValue({
      done: true,
      response: {},
    });
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'user-project');
    await expect(setupUser(client, config)).rejects.toThrow(
      'returned no managed project ID',
    );
  });
});
