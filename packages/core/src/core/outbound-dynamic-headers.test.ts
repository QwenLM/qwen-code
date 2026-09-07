/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  applyDynamicHeaderValues,
  expandDynamicHeaders,
  hasDynamicPlaceholder,
  resolveDynamicHeaderValue,
} from './outbound-dynamic-headers.js';

function config({
  sessionId = 'session-1',
  allow = true,
}: { sessionId?: string; allow?: boolean } = {}): Config {
  return {
    getSessionId: vi.fn().mockReturnValue(sessionId),
    getOutboundAllowDynamicHeaderValues: vi.fn().mockReturnValue(allow),
  } as unknown as Config;
}

describe('hasDynamicPlaceholder', () => {
  it.each([
    '${session_id}',
    'sess-${session_id}',
    '${session_id}-${session_id}',
  ])('detects a placeholder in %s', (value) => {
    expect(hasDynamicPlaceholder(value)).toBe(true);
  });

  it.each(['req-123', '', '$session_id', '${SESSION_ID}', '{session_id}'])(
    'leaves %j alone',
    (value) => {
      expect(hasDynamicPlaceholder(value)).toBe(false);
    },
  );
});

describe('resolveDynamicHeaderValue', () => {
  it('returns a placeholder-free value untouched', () => {
    // The no-op path for every customHeaders entry configured today.
    const cliConfig = config({ allow: false });
    expect(resolveDynamicHeaderValue('req-123', cliConfig)).toBe('req-123');
    expect(
      cliConfig.getOutboundAllowDynamicHeaderValues,
    ).not.toHaveBeenCalled();
  });

  it('expands the session ID when the gate is open', () => {
    expect(resolveDynamicHeaderValue('${session_id}', config())).toBe(
      'session-1',
    );
  });

  it('expands a placeholder embedded in a larger value, repeatedly', () => {
    expect(
      resolveDynamicHeaderValue('a-${session_id}-b-${session_id}', config()),
    ).toBe('a-session-1-b-session-1');
  });

  // The gate is the consent decision; default-off must drop the header
  // rather than put a literal `${session_id}` on the wire.
  it('drops the value when the gate is closed', () => {
    expect(
      resolveDynamicHeaderValue('${session_id}', config({ allow: false })),
    ).toBeUndefined();
  });

  it('drops the value when the session ID is empty', () => {
    expect(
      resolveDynamicHeaderValue('${session_id}', config({ sessionId: '' })),
    ).toBeUndefined();
  });

  it('drops the value when Config cannot answer', () => {
    const broken = {
      getOutboundAllowDynamicHeaderValues: vi.fn(() => {
        throw new TypeError('not a function');
      }),
    } as unknown as Config;
    expect(resolveDynamicHeaderValue('${session_id}', broken)).toBeUndefined();
  });
});

describe('applyDynamicHeaderValues', () => {
  it('rewrites only the placeholder-bearing headers', () => {
    const headers = new Headers({
      'x-opencode-session': '${session_id}',
      'x-static': 'req-123',
    });
    applyDynamicHeaderValues(headers, config());
    expect(headers.get('x-opencode-session')).toBe('session-1');
    expect(headers.get('x-static')).toBe('req-123');
  });

  it('deletes the header instead of sending a literal placeholder', () => {
    const headers = new Headers({
      'x-opencode-session': '${session_id}',
      'x-static': 'req-123',
    });
    applyDynamicHeaderValues(headers, config({ allow: false }));
    expect(headers.has('x-opencode-session')).toBe(false);
    expect(headers.get('x-static')).toBe('req-123');
  });

  it('is a no-op when nothing carries a placeholder', () => {
    const headers = new Headers({ 'x-static': 'req-123' });
    applyDynamicHeaderValues(headers, config({ allow: false }));
    expect([...headers.entries()]).toEqual([['x-static', 'req-123']]);
  });
});

describe('expandDynamicHeaders', () => {
  it('returns only the entries that needed expanding', () => {
    expect(
      expandDynamicHeaders(
        { 'x-opencode-session': '${session_id}', 'x-static': 'req-123' },
        config(),
      ),
    ).toEqual({ 'x-opencode-session': 'session-1' });
  });

  it('omits an entry the gate refuses rather than emitting the literal', () => {
    expect(
      expandDynamicHeaders(
        { 'x-opencode-session': '${session_id}' },
        config({ allow: false }),
      ),
    ).toEqual({});
  });

  it('returns an empty object for no customHeaders', () => {
    expect(expandDynamicHeaders(undefined, config())).toEqual({});
  });
});
