/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  formatBashInput,
  formatBashOutput,
  formatCommandInput,
  formatCommandOutput,
  formatRawCommandInput,
} from './commandFormat.js';

// Escape policy:
//   - User-authored input (command name / args / bash input) is inserted
//     verbatim. The user is the author of their own transcript text.
//   - External / tool output (bash stdout/stderr, local command stdout) is
//     XML-escaped so the model cannot be confused by tags emitted by tools.

describe('formatCommandInput', () => {
  it('passes through safe names and empty args verbatim', () => {
    expect(formatCommandInput('vim', '')).toBe(
      '<command-message>vim</command-message>\n<command-name>/vim</command-name>',
    );
  });

  it('keeps namespaced names with colons intact', () => {
    expect(formatCommandInput('foo:bar', 'hello')).toBe(
      '<command-message>foo:bar</command-message>\n<command-name>/foo:bar</command-name>\n<command-args>hello</command-args>',
    );
  });

  it('inserts user-authored args verbatim (no XML escape)', () => {
    const out = formatCommandInput('vim', '</command-args><x>');
    expect(out).toContain('<command-args></command-args><x></command-args>');
  });

  it('inserts user-authored command names verbatim (no sanitization)', () => {
    const out = formatCommandInput('foo<script>', '');
    expect(out).toContain('<command-name>/foo<script></command-name>');
    expect(out).toContain('<command-message>foo<script></command-message>');
  });

  it('preserves non-ASCII command names verbatim', () => {
    const out = formatCommandInput('中文', 'arg');
    expect(out).toContain('<command-name>/中文</command-name>');
    expect(out).toContain('<command-args>arg</command-args>');
  });
});

describe('formatRawCommandInput', () => {
  it('returns null for non-slash input', () => {
    expect(formatRawCommandInput('hello')).toBeNull();
  });

  it('parses commandName and args', () => {
    const out = formatRawCommandInput('/export session.txt');
    expect(out).toContain('<command-name>/export</command-name>');
    expect(out).toContain('<command-args>session.txt</command-args>');
  });

  it('keeps nested subcommands in command arguments', () => {
    expect(formatRawCommandInput('/goal set demo')).toBe(
      '<command-message>goal</command-message>\n<command-name>/goal</command-name>\n<command-args>set demo</command-args>',
    );
  });
});

describe('formatCommandOutput', () => {
  it('escapes XML in output payload', () => {
    const out = formatCommandOutput('a<b>c');
    expect(out).toContain('a&lt;b&gt;c');
  });
});

describe('formatBash helpers', () => {
  it('inserts bash input verbatim (no XML escape)', () => {
    expect(formatBashInput('echo <x>')).toBe('<bash-input>echo <x></bash-input>');
  });

  it('escapes bash stdout/stderr from external processes', () => {
    expect(formatBashOutput('a<b>', 'err&z')).toBe(
      '<bash-stdout>a&lt;b&gt;</bash-stdout><bash-stderr>err&amp;z</bash-stderr>',
    );
  });
});
