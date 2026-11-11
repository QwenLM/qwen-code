/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getMessageHistoryPolicy } from './messageHistoryPolicy.js';
import { prepareMessageHistory } from '../utils/displayHistoryProjection.js';
import type { SessionMessageSource } from '../../session/sessionPort.js';

describe('message-source facts to CLI history policy', () => {
  it.each([
    ['live', false, false, false],
    ['live', true, true, false],
    ['recovery', false, false, true],
    ['recovery', true, true, false],
  ] as const)(
    'maps %s delivery with display history %s',
    (
      delivery,
      hasDisplayHistory,
      preferDisplayEvents,
      allowDurableDisplayFallback,
    ) => {
      expect(getMessageHistoryPolicy({ delivery, hasDisplayHistory })).toEqual({
        preferDisplayEvents,
        allowDurableDisplayFallback,
      });
    },
  );

  it.each([
    ['live', false],
    ['live', true],
    ['recovery', false],
    ['recovery', true],
  ] as const)(
    'preserves the original history selection and overlay clearing for %s / %s',
    (delivery, hasDisplayHistory) => {
      const source: SessionMessageSource = { delivery, hasDisplayHistory };
      for (const historyAvailable of [false, true]) {
        let cleared = false;
        const suppress = prepareMessageHistory(
          { historyAvailable, ...getMessageHistoryPolicy(source) },
          () => {
            cleared = true;
          },
        );
        const originalFallback = delivery === 'recovery' && !hasDisplayHistory;
        expect(suppress).toBe(
          (historyAvailable || hasDisplayHistory) && !originalFallback,
        );
        expect(cleared).toBe(originalFallback);
      }
    },
  );
});
