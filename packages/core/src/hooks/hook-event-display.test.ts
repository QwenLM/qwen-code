/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_DISPLAY, hookEventDisplay } from './hook-event-display.js';
import { HookEventName } from './types.js';

const allEvents = Object.values(HookEventName);

const DEDICATED_MESSAGE_EVENTS = [
  HookEventName.Stop,
  HookEventName.UserPromptSubmit,
  HookEventName.PreToolUse,
  HookEventName.UserPromptExpansion,
  HookEventName.TodoCreated,
  HookEventName.TodoCompleted,
];

describe('HOOK_EVENT_DISPLAY', () => {
  it('classifies every hook event and nothing else', () => {
    expect(allEvents).toHaveLength(23);
    expect(Object.keys(HOOK_EVENT_DISPLAY).sort()).toEqual(
      [...allEvents].sort(),
    );
  });

  it('marks MessageDisplay as high frequency', () => {
    expect(hookEventDisplay(HookEventName.MessageDisplay).highFrequency).toBe(
      true,
    );
  });

  it.each(allEvents.filter((event) => event !== HookEventName.MessageDisplay))(
    'does not mark %s as high frequency',
    (event) => {
      expect(hookEventDisplay(event).highFrequency).toBe(false);
    },
  );

  it.each(DEDICATED_MESSAGE_EVENTS)(
    'says a blocked %s already has its own message',
    (event) => {
      expect(hookEventDisplay(event).hasDedicatedMessage).toBe(true);
    },
  );

  it.each(
    allEvents.filter((event) => !DEDICATED_MESSAGE_EVENTS.includes(event)),
  )('says a blocked %s has no message of its own', (event) => {
    expect(hookEventDisplay(event).hasDedicatedMessage).toBe(false);
  });

  it('treats an event name this build does not know as ordinary', () => {
    expect(hookEventDisplay('FutureEvent' as HookEventName)).toEqual({
      highFrequency: false,
      hasDedicatedMessage: false,
    });
  });

  it('cannot be changed by a consumer', () => {
    const entry = HOOK_EVENT_DISPLAY[HookEventName.MessageDisplay];
    expect(Object.isFrozen(HOOK_EVENT_DISPLAY)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
