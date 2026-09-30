/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseLandlockStatus } from './landlock-status.js';

describe('Landlock execution receipts', () => {
  it.each([0, 1, 42, 125, 255])(
    'confirms a prepared helper after the payload exits %s',
    (code) => {
      expect(
        parseLandlockStatus('{"state":"prepared","abi":3}\n', code),
      ).toEqual({ state: 'confirmed', exitCode: code });
    },
  );

  it('positively identifies empty and explicit pre-exec failures', () => {
    expect(parseLandlockStatus('', 125)).toEqual({
      state: 'unconfirmed',
      payloadExitObserved: false,
    });
    expect(
      parseLandlockStatus(
        '{"state":"prepared","abi":6}\n{"state":"exec-failed","abi":6}\n',
        125,
      ),
    ).toEqual({ state: 'unconfirmed', payloadExitObserved: false });
  });

  it.each([
    ['{"state":"prepared","abi":3}', 0],
    ['{"state":"prepared","abi":2}\n', 0],
    ['{"state":"prepared","abi":3}\n{}\n', 0],
    ['x'.repeat(16 * 1024 + 1), 0],
  ])('keeps malformed or partial evidence unknown', (wire, code) => {
    expect(parseLandlockStatus(wire, code)).toEqual({ state: 'unconfirmed' });
  });
});
