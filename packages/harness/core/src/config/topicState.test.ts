/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `TopicState` is the choke point every naming path shares — `/rename`, the
 * `SetTopic` tool, hook-supplied titles, `--name` and session resume — so the
 * announcement it makes is what keeps a peer's address book current. See
 * docs/designs/2026-08-10-cross-session-peer-identity.md §6.2.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreEvent, coreEvents } from '../utils/events.js';
import { TopicState } from './topicState.js';

describe('TopicState', () => {
  afterEach(() => {
    coreEvents.removeAllListeners(CoreEvent.SessionTitleChanged);
  });

  it('announces a new title', () => {
    const listener = vi.fn();
    coreEvents.on(CoreEvent.SessionTitleChanged, listener);

    new TopicState(() => 'test-session').setTopic('fix login', undefined);

    expect(listener).toHaveBeenCalledWith({
      sessionId: 'test-session',
      title: 'fix login',
    });
  });

  it('announces the sanitized title, not the raw one', () => {
    const listener = vi.fn();
    coreEvents.on(CoreEvent.SessionTitleChanged, listener);

    new TopicState(() => 'test-session').setTopic('  fix\nlogin  ', undefined);

    expect(listener).toHaveBeenCalledWith({
      sessionId: 'test-session',
      title: 'fix login',
    });
  });

  it('stays quiet when the title is unchanged', () => {
    const state = new TopicState(() => 'test-session');
    state.setTopic('same', undefined);

    const listener = vi.fn();
    coreEvents.on(CoreEvent.SessionTitleChanged, listener);
    state.setTopic('same', undefined);

    expect(listener).not.toHaveBeenCalled();
  });

  it('stays quiet when only the intent changes', () => {
    const state = new TopicState(() => 'test-session');
    state.setTopic('title', 'first intent');

    const listener = vi.fn();
    coreEvents.on(CoreEvent.SessionTitleChanged, listener);
    state.setTopic(undefined, 'second intent');

    expect(listener).not.toHaveBeenCalled();
    expect(state.getIntent()).toBe('second intent');
  });

  it('stays quiet when nothing valid was supplied', () => {
    const listener = vi.fn();
    coreEvents.on(CoreEvent.SessionTitleChanged, listener);

    expect(new TopicState(() => 'test-session').setTopic('   ', undefined)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('announces every subsequent rename', () => {
    const state = new TopicState(() => 'test-session');
    const listener = vi.fn();
    coreEvents.on(CoreEvent.SessionTitleChanged, listener);

    state.setTopic('first', undefined);
    state.setTopic('second', undefined);
    state.setTopic('third', undefined);

    expect(listener).toHaveBeenCalledTimes(3);
    expect(state.getTopic()).toBe('third');
  });
});
