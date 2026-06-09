/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseFrontMatter, substitute } from './parse.js';

describe('parseFrontMatter', () => {
  it('splits valid front-matter from the body', () => {
    const text =
      '---\nname: triage\ndescription: do it\n---\nBody line one\nline two';
    const result = parseFrontMatter(text);
    expect(result).not.toBeNull();
    expect(result!.frontMatter).toEqual({
      name: 'triage',
      description: 'do it',
    });
    expect(result!.body).toBe('Body line one\nline two');
  });

  it('returns null when there is no opening delimiter', () => {
    expect(parseFrontMatter('no front matter here')).toBeNull();
  });

  // M1: a CRLF-authored file must not carry a trailing \r into the last
  // front-matter field's value (e.g. `scope: write\r`).
  it('normalizes CRLF so the last front-matter field has no trailing \\r', () => {
    const text =
      '---\r\nname: lint\r\ndescription: do it\r\nscope: write\r\n---\r\nnpm run lint\r\n';
    const result = parseFrontMatter(text);
    expect(result).not.toBeNull();
    expect(result!.frontMatter).toEqual({
      name: 'lint',
      description: 'do it',
      scope: 'write',
    });
    expect(result!.body).toBe('npm run lint\n');
  });

  it('returns null when there is no closing delimiter', () => {
    expect(parseFrontMatter('---\nname: triage\nno closing')).toBeNull();
  });

  it('returns null when front-matter is not a mapping', () => {
    expect(parseFrontMatter('---\n- just\n- a\n- list\n---\nbody')).toBeNull();
  });

  it('returns null when front-matter is a scalar', () => {
    expect(parseFrontMatter('---\njust a string\n---\nbody')).toBeNull();
  });

  it('trims a single leading newline from the body', () => {
    const result = parseFrontMatter('---\nname: x\n---\nhello');
    expect(result!.body).toBe('hello');
  });
});

describe('substitute', () => {
  const ctx = {
    args: ['alpha', 'beta', 'gamma'],
    named: { key: 'val', other: 'thing' },
    file: 'foo.ts',
  };

  it('${args} joins all positional args with a single space', () => {
    expect(substitute('all: ${args}', ctx)).toBe('all: alpha beta gamma');
  });

  it('${arg} is the first positional', () => {
    expect(substitute('first: ${arg}', ctx)).toBe('first: alpha');
  });

  it('${arg.N} is the Nth positional (0-indexed)', () => {
    expect(substitute('${arg.0}/${arg.1}/${arg.2}', ctx)).toBe(
      'alpha/beta/gamma',
    );
  });

  it('${named.KEY} reads the named map', () => {
    expect(substitute('${named.key}-${named.other}', ctx)).toBe('val-thing');
  });

  it('${file} reads the file context', () => {
    expect(substitute('file=${file}', ctx)).toBe('file=foo.ts');
  });

  it('missing named key → empty string', () => {
    expect(substitute('[${named.nope}]', ctx)).toBe('[]');
  });

  it('${arg.N} out of range → empty string', () => {
    expect(substitute('[${arg.9}]', ctx)).toBe('[]');
  });

  it('unknown placeholder → empty string', () => {
    expect(substitute('[${whatever}]', ctx)).toBe('[]');
  });

  it('missing args/named/file → empty strings', () => {
    expect(
      substitute('${args}|${arg}|${arg.0}|${named.k}|${file}', {
        args: [],
        named: {},
      }),
    ).toBe('||||');
  });

  it('a substituted value containing ${args} is NOT re-expanded', () => {
    const result = substitute('${arg}', { args: ['${args}'], named: {} });
    expect(result).toBe('${args}');
  });
});
