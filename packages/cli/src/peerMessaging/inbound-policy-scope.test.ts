/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SettingScope, type LoadedSettings } from '../config/settings.js';
import { inboundPolicyScope } from './inbound-policy-scope.js';

type Policy = unknown;

/**
 * The merge itself is pinned in settings.test.ts; this helper only stands
 * in for its result so each case states the per-scope values and the
 * merged value the merge would have produced from them.
 */
function loaded(values: {
  merged: Policy;
  user?: Policy;
  workspace?: Policy;
  system?: Policy;
  systemDefaults?: Policy;
  isTrusted?: boolean;
  workspaceSettingsActive?: boolean;
}): LoadedSettings {
  const file = (policy: Policy) => ({
    settings:
      policy === undefined ? {} : { agents: { crossSessionInbound: policy } },
  });
  const byScope = {
    [SettingScope.User]: file(values.user),
    [SettingScope.Workspace]: file(values.workspace),
    [SettingScope.System]: file(values.system),
    [SettingScope.SystemDefaults]: file(values.systemDefaults),
  };
  return {
    merged:
      values.merged === undefined
        ? {}
        : { agents: { crossSessionInbound: values.merged } },
    forScope: (scope: SettingScope) => byScope[scope],
    isTrusted: values.isTrusted ?? true,
    workspaceSettingsActive: values.workspaceSettingsActive ?? true,
  } as unknown as LoadedSettings;
}

describe('inboundPolicyScope', () => {
  it('is undefined when no scope sets the key', () => {
    expect(inboundPolicyScope(loaded({ merged: undefined }))).toBeUndefined();
  });

  it('names the user when only the user set it', () => {
    expect(inboundPolicyScope(loaded({ merged: 'hold', user: 'hold' }))).toBe(
      'user',
    );
  });

  it('names the workspace when its stricter value is the one in force', () => {
    expect(
      inboundPolicyScope(
        loaded({ merged: 'refuse', user: 'accept', workspace: 'refuse' }),
      ),
    ).toBe('workspace');
    expect(
      inboundPolicyScope(loaded({ merged: 'hold', workspace: 'hold' })),
    ).toBe('workspace');
  });

  it('names the user when the workspace merely repeats the user value', () => {
    expect(
      inboundPolicyScope(
        loaded({ merged: 'hold', user: 'hold', workspace: 'hold' }),
      ),
    ).toBe('user');
  });

  it('names the user when the workspace value was dropped as looser', () => {
    expect(
      inboundPolicyScope(
        loaded({ merged: 'refuse', user: 'refuse', workspace: 'hold' }),
      ),
    ).toBe('user');
  });

  it('names System whenever System sets the key', () => {
    expect(
      inboundPolicyScope(
        loaded({
          merged: 'accept',
          user: 'hold',
          workspace: 'refuse',
          system: 'accept',
        }),
      ),
    ).toBe('system');
  });

  it('reports SystemDefaults as system', () => {
    expect(
      inboundPolicyScope(loaded({ merged: 'hold', systemDefaults: 'hold' })),
    ).toBe('system');
  });

  it('reports SystemDefaults when the workspace repeats its value', () => {
    expect(
      inboundPolicyScope(
        loaded({
          merged: 'hold',
          workspace: 'hold',
          systemDefaults: 'hold',
        }),
      ),
    ).toBe('system');
  });

  it('does not attribute a raw untrusted workspace value', () => {
    expect(
      inboundPolicyScope(
        loaded({ merged: 'hold', workspace: 'hold', isTrusted: false }),
      ),
    ).toBeUndefined();
  });

  it('matches an effective malformed workspace value after merge cloning', () => {
    expect(
      inboundPolicyScope(
        loaded({
          merged: { policy: 'hold' },
          user: 'accept',
          workspace: { policy: 'hold' },
        }),
      ),
    ).toBe('workspace');
  });
});
