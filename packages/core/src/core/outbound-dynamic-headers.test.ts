/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { resolveEnvVarsInString } from '../utils/envVarResolver.js';
import {
  applyDynamicHeaderValues,
  expandDynamicHeaders,
  hasDynamicPlaceholder,
  resolveDynamicHeaderValue,
  warnIfDynamicHeadersDisabled,
} from './outbound-dynamic-headers.js';
import { wrapFetchWithSessionId } from './outbound-session-id.js';

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
    '$session_id',
    '${SESSION_ID}',
    '${QWEN_CODE_SESSION_ID}',
    '$QWEN_CODE_SESSION_ID',
    '${qwen_code_session_id}',
    'sess-${session_id}',
    '${session_id}-${session_id}',
  ])('detects a placeholder in %s', (value) => {
    expect(hasDynamicPlaceholder(value)).toBe(true);
  });

  it.each(['req-123', '', '$session_id_suffix', '{session_id}'])(
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

  it.each([
    ['$session_id', 'session-1'],
    ['${SESSION_ID}', 'session-1'],
    ['$QWEN_CODE_SESSION_ID', 'session-1'],
    ['${qwen_code_session_id}', 'session-1'],
    ['sess=$QWEN_CODE_SESSION_ID', 'sess=session-1'],
  ])('expands the session ID alias %s through the gate', (value, expected) => {
    expect(resolveDynamicHeaderValue(value, config())).toBe(expected);
    expect(
      resolveDynamicHeaderValue(value, config({ allow: false })),
    ).toBeUndefined();
  });

  it('keeps runtime session environment values behind the consent gate', () => {
    const value = resolveEnvVarsInString('sess=$QWEN_CODE_SESSION_ID', {
      QWEN_CODE_SESSION_ID: 'ambient-session',
    });

    expect(value).toBe('sess=$QWEN_CODE_SESSION_ID');
    expect(
      resolveDynamicHeaderValue(value, config({ allow: false })),
    ).toBeUndefined();
    expect(resolveDynamicHeaderValue(value, config())).toBe('sess=session-1');
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

  it('ignores non-string runtime values', () => {
    const numericValue = 30 as unknown as string;
    expect(
      expandDynamicHeaders(
        {
          'x-timeout': numericValue,
          'x-opencode-session': '${session_id}',
        },
        config(),
      ),
    ).toEqual({ 'x-opencode-session': 'session-1' });
    expect(resolveDynamicHeaderValue(numericValue, config())).toBeUndefined();
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

describe('warnIfDynamicHeadersDisabled', () => {
  // #10995 treats writing the placeholder into a provider entry as the
  // opt-in, so a user can reasonably arrive with the gate still off.
  // Their symptom is otherwise a gateway rejecting every request with
  // nothing on screen to explain it.
  it('names the header and the switch when the gate is closed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnIfDynamicHeadersDisabled(
        { 'x-opencode-session': '${session_id}' },
        config({ allow: false }),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('x-opencode-session'),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('outboundCorrelation.allowDynamicHeaderValues'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet when the gate is open or nothing has a placeholder', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnIfDynamicHeadersDisabled(
        { 'x-only-here-open': '${session_id}' },
        config({ allow: true }),
      );
      warnIfDynamicHeadersDisabled(
        { 'x-static': 'req-123' },
        config({ allow: false }),
      );
      warnIfDynamicHeadersDisabled(undefined, config({ allow: false }));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not throw on a Config that cannot answer', () => {
    const broken = {} as unknown as Config;
    expect(() =>
      warnIfDynamicHeadersDisabled({ 'x-a': '${session_id}' }, broken),
    ).not.toThrow();
  });
});

// End-to-end through the seam the providers actually construct, which is
// the part that makes the issue's config work rather than just the
// resolver in isolation.
describe('placeholder expansion through the provider fetch wrapper', () => {
  async function send(
    customHeaders: Record<string, string>,
    cliConfig: Config,
  ): Promise<Headers> {
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const wrapped = wrapFetchWithSessionId(baseFetch, cliConfig, customHeaders);
    // The SDK merges `defaultHeaders` into each request before calling
    // the custom fetch, so the placeholder arrives here in `init`.
    await wrapped('https://opencode.ai/zen/go/v1/chat/completions', {
      headers: customHeaders,
    });
    return new Headers(baseFetch.mock.calls[0][1]?.headers);
  }

  it('sends the expanded value to a non-first-party gateway', async () => {
    const headers = await send(
      { 'x-opencode-session': '${session_id}', 'x-static': 'req-123' },
      config(),
    );
    expect(headers.get('x-opencode-session')).toBe('session-1');
    expect(headers.get('x-static')).toBe('req-123');
  });

  it('drops the header, never the literal, when the gate is closed', async () => {
    const headers = await send(
      { 'x-opencode-session': '${session_id}' },
      config({ allow: false }),
    );
    expect(headers.has('x-opencode-session')).toBe(false);
  });

  it('rotates the value when the session changes, without a new client', async () => {
    const cliConfig = config();
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const custom = { 'x-opencode-session': '${session_id}' };
    const wrapped = wrapFetchWithSessionId(baseFetch, cliConfig, custom);

    await wrapped('https://opencode.ai/v1', { headers: custom });
    vi.mocked(cliConfig.getSessionId).mockReturnValue('session-2');
    await wrapped('https://opencode.ai/v1', { headers: custom });

    expect(
      new Headers(baseFetch.mock.calls[0][1]?.headers).get(
        'x-opencode-session',
      ),
    ).toBe('session-1');
    expect(
      new Headers(baseFetch.mock.calls[1][1]?.headers).get(
        'x-opencode-session',
      ),
    ).toBe('session-2');
  });

  it('leaves a provider with no placeholder on the untouched path', async () => {
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const wrapped = wrapFetchWithSessionId(
      baseFetch,
      config({ allow: false }),
      {
        'x-static': 'req-123',
      },
    );
    await wrapped('https://api.openai.com/v1');
    // Same early return as before this feature existed: init passed through.
    expect(baseFetch.mock.calls[0][1]).toBeUndefined();
  });
});
