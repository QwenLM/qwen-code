/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ManagedSessionEvent } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { monitorNotificationText } from './hosted-monitor-notification.js';
import { pendingSessionInputs } from './hosted-wake-intake.js';

describe('monitor task-notification envelope', () => {
  it('wraps one observation with the Legacy tag shape and escapes content', () => {
    const text = monitorNotificationText({
      monitorId: 'watch-1<&',
      toolUseId: 'call-1',
      description: 'build watch ' + '\u0007',
      eventCount: 7,
      lines: ['built 1<&', 'warn "quoted"'],
    });
    expect(text).toBe(
      [
        '<task-notification>',
        '<task-id>watch-1&lt;&amp;</task-id>',
        '<tool-use-id>call-1</tool-use-id>',
        '<kind>monitor</kind>',
        '<status>running</status>',
        '<event-count>7</event-count>',
        '<summary>Monitor "build watch" emitted event #7.</summary>',
        '<result>built 1&lt;&amp;\nwarn &quot;quoted&quot;</result>',
        '</task-notification>',
      ].join('\n'),
    );
    expect(text.endsWith('</task-notification>')).toBe(true);
  });

  it('omits a null tool-use id and joins window lines in order', () => {
    const text = monitorNotificationText({
      monitorId: 'watch-2',
      toolUseId: null,
      description: 'du watcher',
      eventCount: 1,
      lines: ['a', 'b', 'c'],
    });
    expect(text).not.toContain('tool-use-id');
    expect(text).toContain('<result>a\nb\nc</result>');
  });

  it('caps each result line at Legacy’s 2000 with the truncated marker', () => {
    const text = monitorNotificationText({
      monitorId: 'watch-3',
      toolUseId: null,
      description: 'chatty watch',
      eventCount: 3,
      lines: ['x'.repeat(2_100), 'short'],
    });
    expect(text).toContain('...[truncated]');
    expect(text).not.toContain('x'.repeat(2_000) + 'x');
    expect(text).toContain('\nshort</result>');
  });
});

describe('pending session inputs', () => {
  function event(
    kind: ManagedSessionEvent['kind'],
    sequence: number,
    payload: Record<string, unknown>,
  ): ManagedSessionEvent {
    return {
      v: 1,
      sequence,
      eventId: `e-${sequence}`,
      sessionKey: { tenantId: 't', workspaceId: 'w', sessionId: 's' },
      kind,
      occurredAt: sequence,
      payload: payload as ManagedSessionEvent['payload'],
    };
  }

  it('keeps an accepted input pending until a turn settles under its turnId', () => {
    const events = [
      event('input.accepted', 3, {
        inputId: 'monitor-1:notify:1',
        turnId: 'monitor-1:notify:1',
        source: 'monitor',
        contentRef: { resourceId: 'r1' },
      }),
      event('input.accepted', 5, {
        inputId: 'channel-input:2',
        turnId: 'channel-turn:2',
        source: 'channel',
        contentRef: { resourceId: 'r2' },
      }),
      event('turn.settled', 6, { turnId: 'channel-turn:2' }),
      event('input.accepted', 7, {
        inputId: 'monitor-1:notify:2',
        turnId: 'monitor-1:notify:2',
        source: 'monitor',
        contentRef: { resourceId: 'r3' },
      }),
    ];
    expect(pendingSessionInputs(events).map((e) => e.inputId)).toEqual([
      'monitor-1:notify:1',
      'monitor-1:notify:2',
    ]);
    expect(pendingSessionInputs(events)[0]).toMatchObject({
      source: 'monitor',
      sequence: 3,
      contentRef: { resourceId: 'r1' },
    });
  });

  it('settling before admission still consumes the input with the same id', () => {
    const events = [
      event('turn.settled', 2, { turnId: 'odd-turn' }),
      event('input.accepted', 3, {
        inputId: 'odd-turn:notify:1',
        turnId: 'odd-turn',
        source: 'monitor',
        contentRef: { resourceId: 'r4' },
      }),
    ];
    expect(pendingSessionInputs(events)).toEqual([]);
  });
});
