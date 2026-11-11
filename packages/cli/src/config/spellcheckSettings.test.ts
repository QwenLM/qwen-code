/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runLogger } from '@qwen-code/core';
import type { Settings, SettingsFile } from './settings.js';
import {
  resetSpellcheckSettingsWarningsForTesting,
  resolveSpellcheckSettings,
  type SpellcheckSettingsSource,
} from './spellcheckSettings.js';

type SpellcheckBlock = Settings['spellcheck'];

function file(spellcheck?: SpellcheckBlock): SettingsFile {
  return {
    path: '/somewhere/settings.json',
    settings: (spellcheck === undefined ? {} : { spellcheck }) as Settings,
    originalSettings: {} as Settings,
  };
}

function source(scopes: {
  user?: SpellcheckBlock;
  project?: SpellcheckBlock;
  local?: SpellcheckBlock;
  flag?: SpellcheckBlock;
}): SpellcheckSettingsSource {
  return {
    user: file(scopes.user),
    project: file(scopes.project),
    local: file(scopes.local),
    flag: file(scopes.flag),
  };
}

describe('resolveSpellcheckSettings', () => {
  beforeEach(() => {
    resetSpellcheckSettingsWarningsForTesting();
    vi.restoreAllMocks();
  });

  it('is off when nothing is configured', () => {
    expect(resolveSpellcheckSettings(source({}))).toEqual({
      enabled: false,
      checker: 'auto',
      language: undefined,
      color: undefined,
    });
  });

  it('reads the user block', () => {
    const resolved = resolveSpellcheckSettings(
      source({
        user: {
          enabled: true,
          checker: 'hunspell',
          language: 'en_GB',
          color: '#ff0000',
        },
      }),
    );
    expect(resolved).toEqual({
      enabled: true,
      checker: 'hunspell',
      language: 'en_GB',
      color: '#ff0000',
    });
  });

  it('takes the flag block whole, not merged with the user block', () => {
    const resolved = resolveSpellcheckSettings(
      source({
        user: { enabled: true, checker: 'hunspell', language: 'en_GB' },
        // A flag block that says nothing about `enabled` is still the block
        // that applies, so spell checking is off.
        flag: { checker: 'ispell' },
      }),
    );
    expect(resolved.enabled).toBe(false);
    expect(resolved.checker).toBe('ispell');
    expect(resolved.language).toBeUndefined();
  });

  it('ignores a block in project settings', () => {
    const resolved = resolveSpellcheckSettings(
      source({
        project: { enabled: true, checker: 'ispell' },
        local: { enabled: true, checker: 'ispell' },
      }),
    );
    expect(resolved.enabled).toBe(false);
    expect(resolved.checker).toBe('auto');
  });

  it('ignores project settings even alongside a user block', () => {
    const resolved = resolveSpellcheckSettings(
      source({
        user: { enabled: true },
        project: { checker: 'ispell', language: 'de_DE' },
      }),
    );
    expect(resolved.checker).toBe('auto');
    expect(resolved.language).toBeUndefined();
  });

  it('says so once when a block that cannot apply is present', () => {
    const debug = vi.spyOn(runLogger, 'debug').mockImplementation(() => {});
    const input = source({ project: { enabled: true } });

    resolveSpellcheckSettings(input);
    resolveSpellcheckSettings(input);

    const messages = debug.mock.calls.map((call) => String(call[0]));
    expect(messages.filter((m) => m.includes('project settings'))).toHaveLength(
      1,
    );
  });

  it('explains an `enabled: true` that a higher block masked', () => {
    const debug = vi.spyOn(runLogger, 'debug').mockImplementation(() => {});

    resolveSpellcheckSettings(
      source({ user: { enabled: true }, flag: { checker: 'ispell' } }),
    );

    const messages = debug.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes('does not apply'))).toBe(true);
  });

  it('stays quiet for someone who simply turned it off', () => {
    const debug = vi.spyOn(runLogger, 'debug').mockImplementation(() => {});

    resolveSpellcheckSettings(source({ user: { enabled: false } }));

    expect(debug).not.toHaveBeenCalled();
  });

  it('drops a language that is not a plain dictionary name', () => {
    const resolved = resolveSpellcheckSettings(
      source({ user: { enabled: true, language: '../../etc/passwd' } }),
    );
    expect(resolved.language).toBeUndefined();
    expect(resolved.enabled).toBe(true);
  });

  it('falls back to auto when no checker is named', () => {
    const resolved = resolveSpellcheckSettings(
      source({ user: { enabled: true } }),
    );
    expect(resolved.checker).toBe('auto');
  });
});
