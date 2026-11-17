/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  crossSessionMessagingOffScope,
  crossSessionMessagingSuppression,
  isCrossSessionMessagingActive,
  isCrossSessionMessagingEnabled,
  isCrossSessionMessagingOptedIn,
} from './enabled.js';

describe('isCrossSessionMessagingEnabled', () => {
  it('is on when nothing set the key', () => {
    expect(isCrossSessionMessagingEnabled(undefined)).toBe(true);
    expect(isCrossSessionMessagingEnabled({})).toBe(true);
    expect(isCrossSessionMessagingEnabled({ agents: {} })).toBe(true);
    expect(
      isCrossSessionMessagingEnabled({
        agents: { crossSessionMessaging: undefined },
      }),
    ).toBe(true);
  });

  it('is on when set to true', () => {
    expect(
      isCrossSessionMessagingEnabled({
        agents: { crossSessionMessaging: true },
      }),
    ).toBe(true);
  });

  it('is off when set to false', () => {
    expect(
      isCrossSessionMessagingEnabled({
        agents: { crossSessionMessaging: false },
      }),
    ).toBe(false);
  });

  it('fails closed on a value it does not recognize', () => {
    for (const value of ['yes', 'true', 1, null, {}, []]) {
      expect(
        isCrossSessionMessagingEnabled({
          agents: { crossSessionMessaging: value },
        }),
      ).toBe(false);
    }
  });
});

describe('crossSessionMessagingSuppression', () => {
  it('names the session-level suppression in force', () => {
    expect(crossSessionMessagingSuppression({ isSafeMode: () => true })).toBe(
      'safe-mode',
    );
    expect(crossSessionMessagingSuppression({ getBareMode: () => true })).toBe(
      'bare',
    );
    // Both on: safe mode is the stronger claim about what this session may
    // touch, so it is the more useful one to name.
    expect(
      crossSessionMessagingSuppression({
        isSafeMode: () => true,
        getBareMode: () => true,
      }),
    ).toBe('safe-mode');
  });

  it('is undefined when neither flag is set, or no config can answer', () => {
    expect(
      crossSessionMessagingSuppression({
        isSafeMode: () => false,
        getBareMode: () => false,
      }),
    ).toBeUndefined();
    // `CommandContext['services']['config']` is `Config | null`, and a test
    // double may model neither flag. Neither absence is a suppression: they
    // are what a reader with no runtime to consult sees.
    expect(crossSessionMessagingSuppression(null)).toBeUndefined();
    expect(crossSessionMessagingSuppression(undefined)).toBeUndefined();
    expect(crossSessionMessagingSuppression({})).toBeUndefined();
  });
});

describe('isCrossSessionMessagingActive', () => {
  const on = { agents: { crossSessionMessaging: true } };
  const off = { agents: { crossSessionMessaging: false } };
  const unrestricted = { isSafeMode: () => false, getBareMode: () => false };

  it('is on when the setting is on and no suppression is in force', () => {
    expect(isCrossSessionMessagingActive(on, unrestricted)).toBe(true);
    // An unset key is on, so it stays on with nothing suppressing it.
    expect(isCrossSessionMessagingActive({}, unrestricted)).toBe(true);
  });

  // Each suppression on its own: a gate answering for only one of them
  // would leave the other binding an inbox and publishing its socket path.
  it('is off under either suppression whatever the setting says', () => {
    expect(isCrossSessionMessagingActive(on, { isSafeMode: () => true })).toBe(
      false,
    );
    expect(isCrossSessionMessagingActive(on, { getBareMode: () => true })).toBe(
      false,
    );
  });

  it('is off when the setting is off even with no suppression', () => {
    expect(isCrossSessionMessagingActive(off, unrestricted)).toBe(false);
  });
});

const file = (crossSessionMessaging: unknown) => ({
  settings: { agents: { crossSessionMessaging } },
});

describe('isCrossSessionMessagingOptedIn', () => {
  it('counts a true the user wrote', () => {
    expect(
      isCrossSessionMessagingOptedIn({
        merged: { agents: { crossSessionMessaging: true } },
        user: file(true),
      }),
    ).toBe(true);
  });

  it('counts a true in this workspace only while its settings are in force', () => {
    const scopes = {
      merged: {},
      workspace: file(true),
    };
    expect(isCrossSessionMessagingOptedIn(scopes)).toBe(false);
    expect(
      isCrossSessionMessagingOptedIn({
        ...scopes,
        isTrusted: true,
        workspaceSettingsActive: true,
      }),
    ).toBe(true);
  });

  it('does not count an operator-provided true', () => {
    // A fleet's system-defaults file was not written by the person at
    // this session; the merged value is true all the same.
    for (const operator of ['system', 'systemDefaults'] as const) {
      expect(
        isCrossSessionMessagingOptedIn({
          merged: { agents: { crossSessionMessaging: true } },
          [operator]: file(true),
        }),
      ).toBe(false);
    }
  });
});

describe('crossSessionMessagingOffScope', () => {
  const off = { agents: { crossSessionMessaging: false } };

  it('is undefined while messaging is on', () => {
    expect(crossSessionMessagingOffScope({ merged: {} })).toBeUndefined();
  });

  it('names System whenever System sets the key', () => {
    expect(
      crossSessionMessagingOffScope({
        merged: off,
        system: file(false),
        user: file(false),
      }),
    ).toBe('system');
  });

  it('names the user scope when its value is the one in force', () => {
    expect(
      crossSessionMessagingOffScope({ merged: off, user: file(false) }),
    ).toBe('user');
    // An unrecognized value is off too, and is still the user's.
    expect(
      crossSessionMessagingOffScope({
        merged: { agents: { crossSessionMessaging: 'yes' } },
        user: file('yes'),
      }),
    ).toBe('user');
  });

  it('keeps system defaults apart from System', () => {
    expect(
      crossSessionMessagingOffScope({
        merged: off,
        systemDefaults: file(false),
      }),
    ).toBe('system-defaults');
  });

  it('names the workspace when a kept workspace false outranks a user true', () => {
    expect(
      crossSessionMessagingOffScope({
        merged: off,
        user: file(true),
        workspace: file(false),
        isTrusted: true,
        workspaceSettingsActive: true,
      }),
    ).toBe('workspace');
  });

  it('cannot trace a value when only merged settings are known', () => {
    expect(crossSessionMessagingOffScope({ merged: off })).toBeUndefined();
  });
});
