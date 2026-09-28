/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AUX_MODEL_SELECTOR_SETTING_KEYS,
  formatAuxModelSelectorForDisplay,
  isAuxModelSelectorSettingKey,
  publicAuxModelSelectorValue,
  stripAuxSelectorBaseUrlCredential,
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

describe('stripAuxSelectorBaseUrlCredential', () => {
  it('returns a clean URL byte-identically', () => {
    expect(stripAuxSelectorBaseUrlCredential('https://a.example/v1')).toBe(
      'https://a.example/v1',
    );
  });

  it('strips userinfo from an http(s) URL', () => {
    expect(
      stripAuxSelectorBaseUrlCredential('https://user:sk-secret@a.example/v1'),
    ).toBe('https://a.example/v1');
    expect(stripAuxSelectorBaseUrlCredential('http://user@a.example/v1')).toBe(
      'http://a.example/v1',
    );
  });

  it('leaves scheme-less and unparseable endpoints unchanged', () => {
    expect(stripAuxSelectorBaseUrlCredential('localhost:8080')).toBe(
      'localhost:8080',
    );
    expect(stripAuxSelectorBaseUrlCredential('not a url')).toBe('not a url');
    expect(stripAuxSelectorBaseUrlCredential('')).toBe('');
  });

  it('fails closed on an http(s) endpoint new URL() rejects', () => {
    // These are the shapes the persist path used to write verbatim, credential
    // included — the one surface the publish path cannot scrub after the fact.
    expect(stripAuxSelectorBaseUrlCredential('https://user@host:99999')).toBe(
      'https://host:99999',
    );
    for (const unparseable of [
      'https://user:sk-secret@host.example:99999/v1',
      'https://user:sk-secret@/v1',
      'https://user:sk-secret@host name/v1',
      'https://user:sk-secret@[::1/v1',
      'https://user:sk@host:99999',
    ]) {
      const persisted = stripAuxSelectorBaseUrlCredential(unparseable);
      expect(persisted).not.toContain('sk-secret');
      expect(persisted).not.toContain('user:sk');
      expect(persisted).not.toContain('user@');
    }
  });

  it('keeps the query when failing closed', () => {
    // The suffix is the endpoint disambiguator compared by exact equality, so
    // the closed path must not start dropping the query.
    expect(
      stripAuxSelectorBaseUrlCredential('https://user:sk@host:99999/v1?x=1'),
    ).toBe('https://host:99999/v1?x=1');
  });
});
