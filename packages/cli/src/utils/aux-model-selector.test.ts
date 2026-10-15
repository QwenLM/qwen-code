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
  hasBaseUrlCredentials,
  isAuxModelSelectorSettingKey,
  isCleanPublicProviderBaseUrl,
  publicAuxModelSelectorValue,
  splitAuxModelSelector,
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

  it('serves a credential-free @ in the path byte-identically', () => {
    // The fold guard must not degrade into an `includes('@')` test: an `@` in
    // the path is not userinfo, and blanking the suffix would drop the very
    // endpoint pin it exists to keep.
    const value = 'openai:gpt-x\0https://host.example/v1/@org/model';
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
    ['an ASCII space', ' '],
    ['a backslash', '\\'],
    ['NBSP', '\u00a0'],
    ['U+2028', '\u2028'],
    ['an ideographic space', '\u3000'],
    ['a pipe', '|'],
    ['a double quote', '"'],
    ['a backtick', '`'],
    ['an angle bracket', '<'],
  ])('drops a suffix whose credential hides behind %s', (_label, folded) => {
    // `new URL()` succeeds on every one of these with the joining character
    // folded into the pathname, so username/password/search/hash all read
    // empty while the credential text after it is still in the string. The
    // "already clean" shortcut inspects parsed fields but returns the
    // UNPARSED input, so it must not fire on any of them. Narrowing the
    // guard back to `\p{Cc}` alone must red every non-control row.
    const hidden = `openai:gpt-x\0https://gw.example/v1${folded}https://user:sk-secret@other.example/v1`;
    expect(publicAuxModelSelectorValue(hidden)).toBe('openai:gpt-x');
  });

  it.each([
    ['a plain slash', '/'],
    ['an opening brace', '{'],
    ['a semicolon', ';'],
    ['a percent-encoded space', '%20'],
    ['a zero-width space (U+200B)', '\u200b'],
  ])(
    'drops a suffix whose second authority hides behind %s the fold guard does not list',
    (_label, join) => {
      // An input-character enumeration cannot converge: each of these joins
      // also leaves `username`/`password`/`search`/`hash` empty, and a plain
      // `/` involves no folding at all, so the "already clean" shortcut used
      // to return the UNPARSED suffix with the credential still in it. The
      // gate validates the text it is about to emit instead — a pathname that
      // embeds a second authority is not publishable — so removing that output
      // check must red every row here.
      const hidden = `openai:gpt-x\0https://gw.example/v1${join}https://user:sk-secret@other.example/v1`;
      expect(publicAuxModelSelectorValue(hidden)).toBe('openai:gpt-x');
      expect(publicAuxModelSelectorValue(hidden)).not.toContain('sk-secret');
    },
  );

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

describe('isCleanPublicProviderBaseUrl', () => {
  it('returns true for clean http/https URLs without credentials', () => {
    expect(isCleanPublicProviderBaseUrl('https://api.example.com/v1')).toBe(
      true,
    );
  });

  it('returns false for URLs containing query parameters or hash fragments', () => {
    expect(
      isCleanPublicProviderBaseUrl('https://api.example.com/v1?api-version=1'),
    ).toBe(false);
    expect(
      isCleanPublicProviderBaseUrl('https://gw.internal/v1?api-key=sk-secret'),
    ).toBe(false);
    expect(
      isCleanPublicProviderBaseUrl('https://gw.internal/v1#token=sk-secret'),
    ).toBe(false);
  });

  it('returns false for URLs containing credentials', () => {
    expect(
      isCleanPublicProviderBaseUrl('https://user:sk-secret@api.example.com/v1'),
    ).toBe(false);
    expect(
      isCleanPublicProviderBaseUrl('https://user@api.example.com/v1'),
    ).toBe(false);
  });

  it('returns false for URLs containing control or invisible characters', () => {
    expect(
      isCleanPublicProviderBaseUrl(
        'https://api.example.com/v1\0https://evil.com',
      ),
    ).toBe(false);
    expect(
      isCleanPublicProviderBaseUrl(
        'https://api.example.com/v1\u009fhttps://evil.com',
      ),
    ).toBe(false);
    expect(
      isCleanPublicProviderBaseUrl(
        'https://gw.example/v1\u200bhttps://user:sk-secret@o.e/v1',
      ),
    ).toBe(false);
    expect(
      isCleanPublicProviderBaseUrl(
        'https://gw.example/v1\u202ehttps://user:sk-secret@other.example/v1',
      ),
    ).toBe(false);
    expect(
      isCleanPublicProviderBaseUrl(
        'https://gw.example/v1\ufeffhttps://user:sk-secret@other.example/v1',
      ),
    ).toBe(false);
    expect(
      isCleanPublicProviderBaseUrl(
        'https://gw.example/v1\u2028https://user:sk-secret@other.example/v1',
      ),
    ).toBe(false);
    expect(
      isCleanPublicProviderBaseUrl(
        'https://gw.example/v1\u2029https://user:sk-secret@other.example/v1',
      ),
    ).toBe(false);
  });

  it('returns false for non-http(s) schemes or invalid URLs', () => {
    expect(isCleanPublicProviderBaseUrl('ftp://api.example.com/v1')).toBe(
      false,
    );
    expect(isCleanPublicProviderBaseUrl('not a url')).toBe(false);
    expect(isCleanPublicProviderBaseUrl('')).toBe(false);
  });

  it('returns false for ASCII-space smuggled credentials', () => {
    expect(
      isCleanPublicProviderBaseUrl(
        'https://gw.example/v1 https://user:sk-secret@o.e/v1',
      ),
    ).toBe(false);
  });

  it('rejects credential-bearing endpoints to enforce workspace tombstones', () => {
    const credentialEndpoints = [
      'https://team:sk-live-abc123@corp.example/v1',
      'https://gw.internal/v1?key=sk-secret',
      'https://gw.internal/v1#token=sk-secret',
      'https://gw.example/v1\u200bhttps://user:sk-secret@other.example/v1',
      'https://gw.example/v1 https://user:sk-secret@o.e/v1',
    ];
    for (const endpoint of credentialEndpoints) {
      expect(isCleanPublicProviderBaseUrl(endpoint)).toBe(false);
    }
    expect(
      isCleanPublicProviderBaseUrl('https://clean.provider.example/v1'),
    ).toBe(true);
  });
});

describe('splitAuxModelSelector', () => {
  it('returns undefined registryBaseUrl when no NUL delimiter is present', () => {
    expect(splitAuxModelSelector('openai:gpt-4o')).toEqual({
      modelSelector: 'openai:gpt-4o',
      registryBaseUrl: undefined,
    });
  });

  it('returns null registryBaseUrl when trailing NUL has an empty suffix', () => {
    expect(splitAuxModelSelector('openai:gpt-4o\0')).toEqual({
      modelSelector: 'openai:gpt-4o',
      registryBaseUrl: null,
    });
  });

  it('preserves exact raw suffix for availability matching while formatAuxModelSelectorForDisplay scrubs userinfo', () => {
    const raw = 'openai:adv\0https://user:sk-secret@gw.example/v1';
    expect(splitAuxModelSelector(raw)).toEqual({
      modelSelector: 'openai:adv',
      registryBaseUrl: 'https://user:sk-secret@gw.example/v1',
    });
    expect(formatAuxModelSelectorForDisplay(raw)).toBe(
      'openai:adv (https://gw.example/v1)',
    );
  });
});

describe('hasBaseUrlCredentials', () => {
  it('detects userinfo credentials', () => {
    expect(
      hasBaseUrlCredentials('https://user:sk-secret@api.example.com/v1'),
    ).toBe(true);
    expect(hasBaseUrlCredentials('https://user@api.example.com/v1')).toBe(true);
  });

  it('detects control characters and smuggled credentials', () => {
    expect(
      hasBaseUrlCredentials('https://api.example.com/v1\0https://evil.com'),
    ).toBe(true);
    expect(
      hasBaseUrlCredentials(
        'https://gw.example/v1\u200bhttps://user:sk-secret@o.e/v1',
      ),
    ).toBe(true);
  });

  it('detects whitespace and space-smuggled credentials', () => {
    expect(
      hasBaseUrlCredentials(
        'https://gw.example/v1 https://user:sk-secret@o.e/v1',
      ),
    ).toBe(true);
    expect(hasBaseUrlCredentials('https://api.example.com/v1 ')).toBe(true);
  });

  it('detects mid-string @ characters', () => {
    expect(
      hasBaseUrlCredentials('https://gw.example/v1@other.example/v1'),
    ).toBe(true);
  });

  it('returns false for clean URLs including query parameters', () => {
    expect(hasBaseUrlCredentials('https://api.example.com/v1')).toBe(false);
    expect(
      hasBaseUrlCredentials(
        'https://corp.example/openai?api-version=2024-01-01',
      ),
    ).toBe(false);
    expect(hasBaseUrlCredentials('localhost:11434')).toBe(false);
    expect(hasBaseUrlCredentials('')).toBe(false);
  });
});
