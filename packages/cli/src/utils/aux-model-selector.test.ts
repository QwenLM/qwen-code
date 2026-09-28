/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AUX_MODEL_SELECTOR_SETTING_KEYS,
  formatAuxModelSelectorForDisplay,
  formatSettingRowValue,
  isAuxModelSelectorSettingKey,
  publicAuxModelSelectorValue,
} from './aux-model-selector.js';

describe('AUX_MODEL_SELECTOR_SETTING_KEYS', () => {
  it('covers the five aux-model selector settings', () => {
    for (const key of [
      'visionModel',
      'imageModel',
      'advisorModel',
      'fastModel',
      'compactionModel',
    ]) {
      expect(isAuxModelSelectorSettingKey(key)).toBe(true);
      expect(AUX_MODEL_SELECTOR_SETTING_KEYS.has(key)).toBe(true);
    }
  });

  it('does not match unrelated or nested keys', () => {
    for (const key of ['model.name', 'voiceModel', 'mcpServers', 'model']) {
      expect(isAuxModelSelectorSettingKey(key)).toBe(false);
    }
  });
});

describe('publicAuxModelSelectorValue', () => {
  it('passes a plain selector without a suffix through unchanged', () => {
    expect(publicAuxModelSelectorValue('openai:gpt-x')).toBe('openai:gpt-x');
  });

  it('keeps the empty-suffix form unchanged', () => {
    expect(publicAuxModelSelectorValue('openai:gpt-x\0')).toBe(
      'openai:gpt-x\0',
    );
  });

  it('serves a clean http(s) suffix byte-identically', () => {
    const value = 'openai:gpt-x\0https://api.example.com/v1';
    expect(publicAuxModelSelectorValue(value)).toBe(value);
  });

  it('strips userinfo credentials from the suffix', () => {
    expect(
      publicAuxModelSelectorValue(
        'openai:gpt-x\0https://user:sk-secret@api.example.com/v1',
      ),
    ).toBe('openai:gpt-x\0https://api.example.com/v1');
  });

  it('strips query and hash from the suffix', () => {
    expect(
      publicAuxModelSelectorValue(
        'openai:gpt-x\0https://api.example.com/v1?api-key=sk-secret#frag',
      ),
    ).toBe('openai:gpt-x\0https://api.example.com/v1');
  });

  it('drops a non-http(s) suffix rather than emitting it', () => {
    expect(
      publicAuxModelSelectorValue('openai:gpt-x\0ftp://user:sk-secret@host/'),
    ).toBe('openai:gpt-x');
    expect(publicAuxModelSelectorValue('openai:gpt-x\0not-a-url')).toBe(
      'openai:gpt-x',
    );
  });

  it.each([
    ['a second NUL (C0)', '\0'],
    ['DEL', '\u007f'],
    ['the C1 range', '\u009f'],
  ])('drops a suffix whose credential hides behind %s', (_label, control) => {
    // `new URL()` succeeds here with the control character percent-encoded
    // into the pathname, so username/password/search/hash all read empty while
    // the credential text after it is still in the string. The "already clean"
    // shortcut inspects parsed fields but returns the UNPARSED input, so it
    // must not fire on any of these shapes. Narrowing the `\p{Cc}` guard back
    // to a C0-only class must red the DEL and C1 rows.
    const hidden = `openai:gpt-x\0https://gw.example/v1${control}https://user:sk-secret@other.example/v1`;
    expect(publicAuxModelSelectorValue(hidden)).toBe('openai:gpt-x');
    expect(publicAuxModelSelectorValue(hidden)).not.toContain('sk-secret');
  });

  it('renders a non-string value instead of throwing', () => {
    // `loadSettings` applies no type validation, so a workspace-scope
    // `settings.json` can hand a wire site `fastModel: 42`. The scrub's first
    // statement is `value.indexOf('\0')`; throwing there takes out the whole
    // enclosing status cell, not just this field.
    expect(publicAuxModelSelectorValue(42)).toBe('42');
    expect(publicAuxModelSelectorValue(true)).toBe('true');
    expect(publicAuxModelSelectorValue({ a: 1 })).toBe('[object Object]');
    expect(publicAuxModelSelectorValue(undefined)).toBe('');
  });

  it('scrubs the suffix even when the selector itself is empty', () => {
    // Malformed value (no selector): readers drop it, but the credential must
    // still not pass through.
    expect(
      publicAuxModelSelectorValue('\0https://user:sk-secret@host/v1'),
    ).toBe('\0https://host/v1');
  });
});

describe('formatAuxModelSelectorForDisplay', () => {
  it('shows a plain selector as-is', () => {
    expect(formatAuxModelSelectorForDisplay('openai:gpt-x')).toBe(
      'openai:gpt-x',
    );
  });

  it('renders a clean suffix as selector (baseUrl)', () => {
    expect(
      formatAuxModelSelectorForDisplay('openai:gpt-x\0https://a.example/v1'),
    ).toBe('openai:gpt-x (https://a.example/v1)');
  });

  it('strips userinfo credentials in the rendered baseUrl', () => {
    expect(
      formatAuxModelSelectorForDisplay(
        'openai:gpt-x\0https://user:sk-secret@a.example/v1',
      ),
    ).toBe('openai:gpt-x (https://a.example/v1)');
  });

  it('omits an unpublishable suffix from the display', () => {
    expect(formatAuxModelSelectorForDisplay('openai:gpt-x\0not-a-url')).toBe(
      'openai:gpt-x',
    );
  });

  it('emits neither a raw NUL nor the credential for a two-NUL suffix', () => {
    const twoNul =
      'openai:gpt-x\0https://gw.example/v1\0https://user:sk-secret@other.example/v1';
    const rendered = formatAuxModelSelectorForDisplay(twoNul);
    expect(rendered).toBe('openai:gpt-x');
    expect(rendered).not.toContain('sk-secret');
    expect(rendered).not.toContain('\0');
  });

  it('renders a non-string setting instead of throwing', () => {
    // Settings are not type-validated on load, and `getExtendedSystemInfo`
    // has no enclosing try: a non-string `fastModel` must render, not reject.
    expect(formatAuxModelSelectorForDisplay(42)).toBe('42');
    expect(formatAuxModelSelectorForDisplay(true)).toBe('true');
    expect(formatAuxModelSelectorForDisplay({ a: 1 })).toBe('[object Object]');
    expect(formatAuxModelSelectorForDisplay(undefined)).toBe('');
  });

  it('keeps the NUL-escaped rendering for unparseable values', () => {
    expect(formatAuxModelSelectorForDisplay('\0https://a.example/v1')).toBe(
      '\\0https://a.example/v1',
    );
  });

  it('scrubs the credential on the empty-selector branch too', () => {
    // Fail closed: `publicAuxModelSelectorValue` scrubs this same input on the
    // wire, so the display path must not be the one surface that echoes it.
    const malformed = '\0https://user:sk-secret@host/v1';
    expect(formatAuxModelSelectorForDisplay(malformed)).toBe(
      '\\0https://host/v1',
    );
    expect(formatAuxModelSelectorForDisplay(malformed)).not.toContain(
      'sk-secret',
    );
    expect(formatAuxModelSelectorForDisplay(malformed)).not.toContain('\0');
  });

  it('drops an unpublishable suffix on the empty-selector branch', () => {
    expect(formatAuxModelSelectorForDisplay('\0not-a-url')).toBe('');
    expect(formatAuxModelSelectorForDisplay('\0ftp://user:sk@host/')).toBe('');
  });
});

describe('formatSettingRowValue', () => {
  // Both `/settings` renderers route their inline rows through this one copy,
  // so neither dialog can re-render a credential-bearing suffix raw.
  const credentialSelector = 'o:f\0https://user:sk-secret@h.example/v1';

  it('redacts userinfo from every aux-model selector row', () => {
    for (const key of AUX_MODEL_SELECTOR_SETTING_KEYS) {
      expect(formatSettingRowValue(key, credentialSelector)).toBe(
        'o:f (https://h.example/v1)',
      );
    }
  });

  it('drops an unpublishable suffix instead of echoing it', () => {
    expect(formatSettingRowValue('fastModel', 'o:f\0not-a-url')).toBe('o:f');
  });

  it('keeps non-aux keys and non-string values on the legacy String() path', () => {
    expect(formatSettingRowValue('general.preferredEditor', 'nvim')).toBe(
      'nvim',
    );
    // An aux key with a non-string value is not a selector, so the suffix
    // branch must not fire; a plain number still renders as before.
    expect(formatSettingRowValue('fastModel', 42)).toBe('42');
  });
});
