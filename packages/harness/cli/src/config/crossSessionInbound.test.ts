/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveCrossSessionInbound } from './crossSessionInbound.js';
import type { LoadedSettings } from './settings.js';

type Scope = 'user' | 'project' | 'local' | 'flag';

/**
 * Minimal LoadedSettings stand-in exposing only the four scopes we read.
 *
 * `isTrusted` defaults to true because that is the ordinary case; the resolver
 * gates the local project scope on it, so the untrusted case gets its own
 * tests rather than being the silent default here.
 */
function settings(
  values: Partial<Record<Scope, string>>,
  isTrusted = true,
): LoadedSettings {
  const file = (value: string | undefined, path: string) => ({
    path,
    settings:
      value === undefined ? {} : { security: { crossSessionInbound: value } },
  });
  return {
    user: file(values.user, '/home/dev/.qwen/settings.json'),
    project: file(values.project, '/repo/.qwen/settings.json'),
    local: file(values.local, '/repo/.qwen/settings.local.json'),
    flag: file(values.flag, '/tmp/flag-settings.json'),
    isTrusted,
  } as unknown as LoadedSettings;
}

function policyOf(values: Partial<Record<Scope, string>>, isTrusted = true) {
  return resolveCrossSessionInbound(settings(values, isTrusted))?.policy;
}

describe('resolveCrossSessionInbound', () => {
  it('returns undefined when no scope sets a value', () => {
    expect(policyOf({})).toBeUndefined();
  });

  it('reads the user scope', () => {
    expect(policyOf({ user: 'hold' })).toBe('hold');
  });

  it('lets the flag scope win over the user scope', () => {
    expect(policyOf({ flag: 'accept', user: 'refuse' })).toBe('accept');
  });

  describe('local project is the reader\'s own scope', () => {
    it('lets a local value loosen the user value', () => {
      // The reason this scope is not grouped with the repository's file: a
      // user-wide hold that cannot be relaxed for one project is a setting the
      // per-project override file exists to relax.
      expect(policyOf({ user: 'hold', local: 'accept' })).toBe('accept');
    });

    it('lets the flag scope win over a local value', () => {
      expect(policyOf({ flag: 'refuse', local: 'accept' })).toBe('refuse');
    });

    it('ignores the local scope in an untrusted project', () => {
      // `LoadedSettings` empties an untrusted `project` but not `local`, so
      // without the resolver's own gate this would loosen the user's hold.
      expect(policyOf({ user: 'hold', local: 'accept' }, false)).toBe('hold');
    });
  });

  describe('the repository scope may only tighten', () => {
    it('ignores a project value that loosens the user value', () => {
      expect(policyOf({ user: 'hold', project: 'accept' })).toBe('hold');
    });

    it('honours a project value that tightens the user value', () => {
      expect(policyOf({ user: 'accept', project: 'refuse' })).toBe('refuse');
    });

    it('tightens a local project value it outranks in severity', () => {
      // Trusting the local scope does not exempt it: the repository may still
      // pull any resolved value in the one direction it is allowed to move.
      expect(policyOf({ project: 'refuse', local: 'accept' })).toBe('refuse');
    });

    it('applies a repo value when no trusted scope set one', () => {
      expect(policyOf({ project: 'hold' })).toBe('hold');
    });

    it('treats an unset trusted scope as accept for the comparison', () => {
      // project:accept must not become the answer just because it is set,
      // but it also must not be treated as a tightening of nothing.
      expect(policyOf({ project: 'accept' })).toBeUndefined();
    });
  });

  it('ignores values outside the enum', () => {
    expect(policyOf({ user: 'yolo' })).toBeUndefined();
  });

  describe('attribution', () => {
    it('reports the user scope and its file', () => {
      expect(resolveCrossSessionInbound(settings({ user: 'hold' }))).toEqual({
        policy: 'hold',
        source: 'user',
        scope: 'user',
        path: '/home/dev/.qwen/settings.json',
      });
    });

    it('classifies the project scope as a repository source', () => {
      const resolved = resolveCrossSessionInbound(
        settings({ project: 'refuse' }),
      );
      expect(resolved).toMatchObject({
        source: 'repo',
        scope: 'project',
        path: '/repo/.qwen/settings.json',
      });
    });

    it('classifies local project as a user source', () => {
      // Attribution drives more than the wording in `/peers`: a `repo` source
      // becomes the `repo-setting` hold cause, which asks per message instead
      // of honouring the value as a standing instruction.
      expect(
        resolveCrossSessionInbound(settings({ local: 'refuse' })),
      ).toMatchObject({
        source: 'user',
        scope: 'local',
        path: '/repo/.qwen/settings.local.json',
      });
    });

    it('attributes to the repo when a repo value overrides the user', () => {
      // The case a user cannot otherwise explain: their own accept is ignored.
      expect(
        resolveCrossSessionInbound(
          settings({ user: 'accept', project: 'hold' }),
        ),
      ).toMatchObject({ policy: 'hold', source: 'repo', scope: 'project' });
    });

    it('treats the flag scope as trusted rather than repo', () => {
      expect(
        resolveCrossSessionInbound(settings({ flag: 'hold' })),
      ).toMatchObject({ source: 'user', scope: 'flag' });
    });
  });
});
