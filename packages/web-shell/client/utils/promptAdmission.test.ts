import { describe, expect, it } from 'vitest';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { isDefinitelyRejectedPromptAdmission } from './promptAdmission';

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
