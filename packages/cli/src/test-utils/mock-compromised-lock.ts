/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import lockfile from 'proper-lockfile';
import { vi } from 'vitest';

/**
 * Simulates a proper-lockfile compromise on the next `lockfile.lock` call.
 * After a real compromise, proper-lockfile marks the lock released before
 * invoking `onCompromised`, so the later `release()` rejects with
 * `ERELEASED`; the mocked release reproduces that exact state.
 */
export function mockCompromisedLock() {
  let onCompromised: ((error: Error) => void) | undefined;
  let lockedFile: string | undefined;
  const lockSpy = vi
    .spyOn(lockfile, 'lock')
    .mockImplementationOnce(async (file, options) => {
      lockedFile = file;
      onCompromised = options?.onCompromised;
      onCompromised?.(
        Object.assign(new Error('lock lost'), { code: 'ECOMPROMISED' }),
      );
      return () =>
        Promise.reject(
          Object.assign(new Error('Lock is already released'), {
            code: 'ERELEASED',
          }),
        );
    });
  return {
    lockSpy,
    getLockedFile: () => lockedFile,
    getOnCompromised: () => onCompromised,
  };
}
