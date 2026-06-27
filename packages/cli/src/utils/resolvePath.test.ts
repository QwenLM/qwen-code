/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolvePath } from './resolvePath.js';

describe('resolvePath', () => {
  it('returns an empty string unchanged', () => {
    expect(resolvePath('')).toBe('');
  });

  it('expands bare tilde to the home directory', () => {
    expect(resolvePath('~')).toBe(path.normalize(os.homedir()));
  });

  it('expands POSIX-style tilde paths', () => {
    expect(resolvePath('~/schemas/input.json')).toBe(
      path.join(os.homedir(), 'schemas', 'input.json'),
    );
  });

  it('keeps the existing POSIX-style trailing separator behavior', () => {
    expect(resolvePath('~/')).toBe(path.normalize(`${os.homedir()}/`));
  });

  it('expands Windows-style tilde paths', () => {
    expect(resolvePath('~\\schemas\\input.json')).toBe(
      path.join(os.homedir(), 'schemas', 'input.json'),
    );
  });

  it('expands USERPROFILE references case-insensitively', () => {
    expect(resolvePath('%USERPROFILE%\\schemas\\input.json')).toBe(
      path.normalize(`${os.homedir()}\\schemas\\input.json`),
    );
  });

  it('normalizes relative paths without resolving them', () => {
    expect(resolvePath('nested/../schema.json')).toBe(
      path.normalize('schema.json'),
    );
  });
});
