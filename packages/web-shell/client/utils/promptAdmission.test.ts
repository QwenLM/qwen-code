import { describe, expect, it } from 'vitest';
import {
  DaemonHttpError,
  DaemonPendingPromptLimitError,
} from '@qwen-code/sdk/daemon';
import {
  isDefinitelyRejectedPromptAdmission,
  isMcpAppPromptAdmissionRejected,
  PromptDispatchCancelledError,
} from './promptAdmission';

describe('MCP App admission rejection', () => {
  it.each([400, 401, 403, 404, 409, 413, 429, 501])(
    'recognizes HTTP %s rejection',
    (status) => {
      expect(
        isMcpAppPromptAdmissionRejected(
          new DaemonHttpError(status, undefined, 'refused'),
        ),
      ).toBe(true);
    },
  );

  it.each([408, 499, 500, 502, 503])(
    'leaves HTTP %s acceptance unknown',
    (status) => {
      expect(
        isMcpAppPromptAdmissionRejected(
          new DaemonHttpError(status, undefined, 'uncertain'),
        ),
      ).toBe(false);
    },
  );

  it('distinguishes a pre-dispatch veto from an aborted or lost HTTP response', () => {
    expect(
      isMcpAppPromptAdmissionRejected(
        new PromptDispatchCancelledError('source changed'),
      ),
    ).toBe(true);
    expect(
      isMcpAppPromptAdmissionRejected(
        new DaemonPendingPromptLimitError('session-a', 10, 10),
      ),
    ).toBe(true);
    expect(
      isMcpAppPromptAdmissionRejected(
        new DOMException('Aborted', 'AbortError'),
      ),
    ).toBe(false);
    expect(
      isMcpAppPromptAdmissionRejected(new TypeError('Failed to fetch')),
    ).toBe(false);
  });
});

describe('isDefinitelyRejectedPromptAdmission', () => {
  it.each([413, 501])('classifies HTTP %s as definitely rejected', (status) => {
    expect(
      isDefinitelyRejectedPromptAdmission(
        new DaemonHttpError(status, undefined, 'rejected'),
      ),
    ).toBe(true);
  });

  it.each([400, 408, 429, 499, 500, 502, 503])(
    'classifies HTTP %s as unknown',
    (status) => {
      expect(
        isDefinitelyRejectedPromptAdmission(
          new DaemonHttpError(status, undefined, 'unknown'),
        ),
      ).toBe(false);
    },
  );

  it('does not classify a non-error status as a rejection', () => {
    expect(
      isDefinitelyRejectedPromptAdmission(
        new DaemonHttpError(302, undefined, 'redirect'),
      ),
    ).toBe(false);
  });

  it('classifies transport errors as unknown', () => {
    expect(
      isDefinitelyRejectedPromptAdmission(new TypeError('disconnected')),
    ).toBe(false);
  });
});
