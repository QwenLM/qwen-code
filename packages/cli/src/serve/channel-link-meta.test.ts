/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { channelLinkMetaForEvents } from './channel-link-meta.js';

const WORKSPACE = '/work/primary';

function loader(channels: Record<string, unknown>) {
  return vi.fn(() => channels);
}

describe('channelLinkMetaForEvents', () => {
  it('resolves user-scope channels without a cwd for the running workspace', () => {
    const load = loader({
      'my-github': {
        type: 'github',
        baseUrl: 'https://ghe.example.com/api/v3',
        token: 'super-secret',
      },
    });

    const meta = channelLinkMetaForEvents(
      [{ channel: 'my-github' }],
      WORKSPACE,
      load,
    );

    expect(meta).toEqual({
      'my-github': {
        type: 'github',
        baseUrl: 'https://ghe.example.com/api/v3',
        webOrigin: 'https://ghe.example.com',
      },
    });
    expect(load).toHaveBeenCalledWith(WORKSPACE);
  });

  it('never emits secret or unrelated config fields', () => {
    const meta = channelLinkMetaForEvents(
      [{ channel: 'bot' }],
      WORKSPACE,
      loader({
        bot: {
          type: 'github',
          token: 'super-secret',
          allowedUsers: ['alice'],
          groupPolicy: 'open',
        },
      }),
    );

    expect(meta).toEqual({
      bot: { type: 'github', webOrigin: 'https://github.com' },
    });
  });

  it('keeps workspace isolation: a channel owned by another workspace is excluded', () => {
    const load = loader({
      here: { type: 'github', cwd: WORKSPACE },
      elsewhere: { type: 'github', cwd: '/work/secondary' },
      relative: { type: 'github', cwd: 'sub/dir' },
      'home-relative': { type: 'github', cwd: '~/project' },
    });

    const meta = channelLinkMetaForEvents(
      [
        { channel: 'here' },
        { channel: 'elsewhere' },
        { channel: 'relative' },
        { channel: 'home-relative' },
      ],
      WORKSPACE,
      load,
    );

    expect(Object.keys(meta)).toEqual(['here']);
  });

  it('only resolves channels named in the events', () => {
    const meta = channelLinkMetaForEvents(
      [{ channel: 'named' }],
      WORKSPACE,
      loader({
        named: { type: 'github' },
        unnamed: { type: 'github' },
      }),
    );

    expect(meta).toEqual({
      named: { type: 'github', webOrigin: 'https://github.com' },
    });
  });

  it('returns an empty map without loading settings when there are no events', () => {
    const load = loader({ bot: { type: 'github' } });
    expect(channelLinkMetaForEvents([], WORKSPACE, load)).toEqual({});
    expect(load).not.toHaveBeenCalled();
  });

  it('skips legacy scalar entries, unknown channels, and fieldless configs', () => {
    const meta = channelLinkMetaForEvents(
      [
        { channel: 'legacy' },
        { channel: 'unknown' },
        { channel: 'fieldless' },
        { channel: 'wrong-types' },
      ],
      WORKSPACE,
      loader({
        legacy: 'github',
        fieldless: { token: 'x' },
        'wrong-types': { type: 42, baseUrl: false },
      }),
    );

    expect(meta).toEqual({});
  });

  it('skips a channel whose cwd cannot be canonicalized', () => {
    // realpath under a regular file raises ENOTDIR (not ENOENT), which
    // canonicalizeWorkspace propagates; the helper must treat it as non-owned.
    const meta = channelLinkMetaForEvents(
      [{ channel: 'broken' }],
      WORKSPACE,
      loader({ broken: { type: 'github', cwd: '/etc/passwd/sub' } }),
    );

    expect(meta).toEqual({});
  });

  it('treats a "__proto__" channel name as a plain data key', () => {
    const merged = JSON.parse(
      '{"__proto__": {"type": "github"}, "constructor": {"type": "github"}}',
    ) as Record<string, unknown>;

    const meta = channelLinkMetaForEvents(
      [{ channel: '__proto__' }, { channel: 'constructor' }],
      WORKSPACE,
      loader(merged),
    );

    expect(Object.hasOwn(meta, '__proto__')).toBe(true);
    expect(Object.hasOwn(meta, 'constructor')).toBe(true);
    expect(meta['__proto__']).toEqual({
      type: 'github',
      webOrigin: 'https://github.com',
    });
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['type']).toBeUndefined();
  });
});
