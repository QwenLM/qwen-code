/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseForkArgs,
  buildForkPayload,
  formatForkOutput,
} from './forkCli.js';

const SID = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';

describe('parseForkArgs', () => {
  it('parses a bare session id (defaults: mode include, no slice cap)', () => {
    const r = parseForkArgs([SID]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ sessionId: SID, mode: 'include' });
  });

  it('parses --from-event (and the --from alias) with a non-negative integer', () => {
    const r = parseForkArgs([SID, '--from-event', '5']);
    expect(r.ok && r.value.fromEventId).toBe(5);
    const r2 = parseForkArgs([SID, '--from', '0']);
    expect(r2.ok && r2.value.fromEventId).toBe(0);
  });

  it('rejects negative / non-integer / missing --from-event', () => {
    for (const bad of ['-1', '1.5', 'abc', '']) {
      const r = parseForkArgs([SID, '--from-event', bad]);
      expect(r.ok, `expected rejection of ${JSON.stringify(bad)}`).toBe(false);
    }
    const noval = parseForkArgs([SID, '--from-event']);
    expect(noval.ok).toBe(false);
  });

  it('accepts --mode include and empty', () => {
    expect(parseForkArgs([SID, '--mode', 'empty']).ok).toBe(true);
    expect(parseForkArgs([SID, '--mode', 'include']).ok).toBe(true);
  });

  it('rejects --mode summary with the deferral message', () => {
    const r = parseForkArgs([SID, '--mode', 'summary']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('deferred');
      expect(r.error).toContain('include or empty');
    }
  });

  it('rejects unknown modes', () => {
    const r = parseForkArgs([SID, '--mode', 'yolo']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('include, empty');
  });

  it('accepts a non-blank --name up to 200 chars', () => {
    expect(parseForkArgs([SID, '--name', 'my fork']).ok).toBe(true);
    expect(parseForkArgs([SID, '--name', 'x'.repeat(200)]).ok).toBe(true);
    const tooLong = parseForkArgs([SID, '--name', 'x'.repeat(201)]);
    expect(tooLong.ok).toBe(false);
    const blank = parseForkArgs([SID, '--name', '   ']);
    expect(blank.ok).toBe(false);
  });

  it('requires exactly one positional (the session id)', () => {
    expect(parseForkArgs([]).ok).toBe(false);
    expect(parseForkArgs([SID, 'extra']).ok).toBe(false);
  });

  it('rejects a syntactically invalid session id', () => {
    const r = parseForkArgs(['../etc/passwd']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('invalid session id');
  });

  it('rejects unknown flags with the usage line', () => {
    const r = parseForkArgs([SID, '--bogus']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown flag');
  });
});

describe('buildForkPayload', () => {
  it('always carries the transcript mode', () => {
    expect(buildForkPayload({ sessionId: SID, mode: 'empty' })).toEqual({
      transcript: 'empty',
    });
  });

  it('adds fromEventId and name only when present', () => {
    expect(
      buildForkPayload({
        sessionId: SID,
        mode: 'include',
        fromEventId: 7,
        name: 'n',
      }),
    ).toEqual({ transcript: 'include', fromEventId: 7, name: 'n' });
  });
});

describe('formatForkOutput', () => {
  it('prints only the new sessionId', () => {
    expect(
      formatForkOutput({
        sessionId: 'new-sid',
        parentSessionId: SID,
        forkedAt: 'x',
      }),
    ).toBe('new-sid');
  });

  it('falls back to JSON for an unexpected body', () => {
    expect(formatForkOutput({ nope: 1 })).toBe('{"nope":1}');
    expect(formatForkOutput('strange')).toBe('"strange"');
  });
});
