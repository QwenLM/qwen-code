/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { describe, expect, it } from 'vitest';
import {
  buildDateReminder,
  DATE_REMINDER_METADATA,
} from '@qwen-code/qwen-code-core/core/environmentContext.js';
import {
  CONTEXT_DATE,
  contextDate,
  isDateReminder,
  startupContext,
  startupContextPart,
  userTurns,
} from './prompt-date.js';

// A startup context that told the model an earlier date, as the history of a
// session running past midnight carries.
const announcedOn = (today: string): Content => ({
  role: 'user',
  parts: [
    {
      ...startupContextPart(today),
      partMetadata: { [DATE_REMINDER_METADATA]: today },
    },
  ],
});

describe('prompt dates', () => {
  it('masks the date the startup context renders', () => {
    expect(
      JSON.stringify(startupContext(contextDate(5))).replace(
        CONTEXT_DATE,
        '<DATE>',
      ),
    ).toContain("Today's date is <DATE>.");
  });

  it('sets the date reminder aside, not the startup context', () => {
    const reminder = buildDateReminder(
      [announcedOn(contextDate(5))],
      contextDate(6),
    );
    expect(reminder).toBeDefined();
    expect(isDateReminder(reminder)).toBe(true);
    expect(isDateReminder(startupContextPart(contextDate(5)))).toBe(false);
    expect(
      userTurns([
        { role: 'user', content: [{ text: 'Second question.' }, reminder] },
      ]),
    ).toBe(1);
  });
});
