/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseIdleConfig,
  loadIdleConfig,
  applyIdleReload,
  IdleConfigError,
  DEFAULT_IDLE_CONFIG,
} from './config.js';

describe('parseIdleConfig', () => {
  it('empty/blank document → defaults', () => {
    expect(parseIdleConfig('')).toEqual(DEFAULT_IDLE_CONFIG);
    expect(parseIdleConfig('# just a comment\n')).toEqual(DEFAULT_IDLE_CONFIG);
  });

  it('reads a full valid document', () => {
    expect(
      parseIdleConfig(
        'enabled: true\nmaxSuggestionsPerHour: 8\nmaxSuggestions: 2\n',
      ),
    ).toEqual({ enabled: true, maxSuggestionsPerHour: 8, maxSuggestions: 2 });
  });

  it('default enabled is FALSE (deliberate fork deviation from the spec)', () => {
    expect(DEFAULT_IDLE_CONFIG.enabled).toBe(false);
    expect(parseIdleConfig('maxSuggestions: 3').enabled).toBe(false);
  });

  it('IGNORES unknown / spec-only fields (idleAfterSec, syntheticPrompt) — lenient', () => {
    const cfg = parseIdleConfig(
      'enabled: true\nidleAfterSec: 60\nsyntheticPrompt: "do x"\n',
    );
    expect(cfg).toEqual({
      enabled: true,
      maxSuggestionsPerHour: DEFAULT_IDLE_CONFIG.maxSuggestionsPerHour,
      maxSuggestions: DEFAULT_IDLE_CONFIG.maxSuggestions,
    });
  });

  it('clamps out-of-range numbers rather than rejecting', () => {
    expect(
      parseIdleConfig('maxSuggestionsPerHour: 0').maxSuggestionsPerHour,
    ).toBe(1);
    expect(
      parseIdleConfig('maxSuggestionsPerHour: 999').maxSuggestionsPerHour,
    ).toBe(60);
    expect(parseIdleConfig('maxSuggestions: 100').maxSuggestions).toBe(10);
    expect(parseIdleConfig('maxSuggestions: 0').maxSuggestions).toBe(1);
  });

  it('throws IdleConfigError on a wrong-TYPE known field', () => {
    expect(() => parseIdleConfig('enabled: "yes"')).toThrow(IdleConfigError);
    expect(() => parseIdleConfig('maxSuggestionsPerHour: nope')).toThrow(
      IdleConfigError,
    );
  });

  it('throws on a non-mapping document', () => {
    expect(() => parseIdleConfig('- a\n- b')).toThrow(IdleConfigError);
    expect(() => parseIdleConfig('42')).toThrow(IdleConfigError);
  });
});

describe('applyIdleReload (hot-reload precedence)', () => {
  it('parses + applies the file value when env does not force', () => {
    expect(
      applyIdleReload('enabled: true\nmaxSuggestions: 2', {
        forceEnabled: false,
      }),
    ).toEqual({ enabled: true, maxSuggestionsPerHour: 5, maxSuggestions: 2 });
  });

  it('env force overrides a file that sets enabled:false', () => {
    const cfg = applyIdleReload('enabled: false', { forceEnabled: true });
    expect(cfg.enabled).toBe(true);
  });

  it('propagates the parse error (caller retains the previous config + audits)', () => {
    expect(() =>
      applyIdleReload('enabled: "nope"', { forceEnabled: false }),
    ).toThrow(IdleConfigError);
  });
});

describe('loadIdleConfig (boot, fail-open)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-idlecfg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('missing file → defaults, no warn', async () => {
    const warns: string[] = [];
    expect(
      await loadIdleConfig(join(dir, 'idle.yaml'), (m) => warns.push(m)),
    ).toEqual(DEFAULT_IDLE_CONFIG);
    expect(warns).toEqual([]);
  });

  it('valid file → parsed config', async () => {
    const p = join(dir, 'idle.yaml');
    await writeFile(p, 'enabled: true\nmaxSuggestionsPerHour: 4\n', 'utf8');
    expect(await loadIdleConfig(p)).toEqual({
      enabled: true,
      maxSuggestionsPerHour: 4,
      maxSuggestions: 3,
    });
  });

  it('malformed file → defaults + a warn (never throws at boot)', async () => {
    const p = join(dir, 'idle.yaml');
    await writeFile(p, 'enabled: "not a bool"\n', 'utf8');
    const warns: string[] = [];
    expect(await loadIdleConfig(p, (m) => warns.push(m))).toEqual(
      DEFAULT_IDLE_CONFIG,
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/malformed/);
  });
});
