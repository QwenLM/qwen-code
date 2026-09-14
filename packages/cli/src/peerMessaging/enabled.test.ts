/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isCrossSessionMessagingEnabled } from './enabled.js';

describe('isCrossSessionMessagingEnabled', () => {
  it('is on when nothing set the key', () => {
    expect(isCrossSessionMessagingEnabled(undefined)).toBe(true);
    expect(isCrossSessionMessagingEnabled({})).toBe(true);
    expect(isCrossSessionMessagingEnabled({ agents: {} })).toBe(true);
    expect(
      isCrossSessionMessagingEnabled({
        agents: { crossSessionMessaging: undefined },
      }),
    ).toBe(true);
  });

  it('is on when set to true', () => {
    expect(
      isCrossSessionMessagingEnabled({
        agents: { crossSessionMessaging: true },
      }),
    ).toBe(true);
  });

  it('is off when set to false', () => {
    expect(
      isCrossSessionMessagingEnabled({
        agents: { crossSessionMessaging: false },
      }),
    ).toBe(false);
  });

  it('fails closed on a value it does not recognize', () => {
    for (const value of ['yes', 'true', 1, null, {}, []]) {
      expect(
        isCrossSessionMessagingEnabled({
          agents: { crossSessionMessaging: value },
        }),
      ).toBe(false);
    }
  });
});
