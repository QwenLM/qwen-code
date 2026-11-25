/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { sessionCommandEvidenceText } from './hosted-session-command-session.js';

describe('issue #14063 member-message timeout guidance', () => {
  it.each(['accepting', 'unknown'] as const)(
    'does not suggest inspecting the board or resending for %s',
    (state) => {
      const text = sessionCommandEvidenceText(state, 'member_message');

      expect(text).not.toMatch(/read the board/i);
      expect(text).toMatch(/do not send it again/i);
      expect(text).toMatch(/recipients.*(?:already|later)/i);
    },
  );

  it.each(['accepting', 'unknown'] as const)(
    'preserves non-message guidance for %s',
    (state) => {
      for (const kind of [
        'board_read',
        'board_write',
        'plan_submit',
      ] as const) {
        expect(sessionCommandEvidenceText(state, kind)).toBe(
          sessionCommandEvidenceText(state),
        );
      }
      expect(sessionCommandEvidenceText(state)).toMatch(/read the board/i);
    },
  );

  it.each(['planned', 'rejected', 'cancelled'] as const)(
    'preserves the known non-delivery guidance for %s',
    (state) => {
      expect(sessionCommandEvidenceText(state, 'member_message')).toBe(
        sessionCommandEvidenceText(state),
      );
    },
  );
});
