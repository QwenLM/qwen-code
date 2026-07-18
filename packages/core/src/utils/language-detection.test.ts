/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getLanguageFromFilePath } from './language-detection.js';

describe('getLanguageFromFilePath', () => {
  it('detects languages from a normal extension', () => {
    expect(getLanguageFromFilePath('src/index.ts')).toBe('TypeScript');
    expect(getLanguageFromFilePath('main.py')).toBe('Python');
    expect(getLanguageFromFilePath('/abs/path/App.tsx')).toBe('TypeScript');
  });

  it('is case-insensitive on the extension', () => {
    expect(getLanguageFromFilePath('README.MD')).toBe('Markdown');
    expect(getLanguageFromFilePath('Main.PY')).toBe('Python');
  });

  it('detects extensionless names keyed with a leading dot', () => {
    expect(getLanguageFromFilePath('Dockerfile')).toBe('Dockerfile');
    expect(getLanguageFromFilePath('deploy/Dockerfile')).toBe('Dockerfile');
  });

  it('detects dotfiles whose basename already starts with a dot', () => {
    // Regression: these were previously probed as `..gitignore` etc. and never
    // matched, because path.extname() returns '' for a leading-dot basename.
    expect(getLanguageFromFilePath('.gitignore')).toBe('Git');
    expect(getLanguageFromFilePath('.dockerignore')).toBe('Docker');
    expect(getLanguageFromFilePath('.npmignore')).toBe('npm');
    expect(getLanguageFromFilePath('.editorconfig')).toBe('EditorConfig');
    expect(getLanguageFromFilePath('.prettierrc')).toBe('Prettier');
    expect(getLanguageFromFilePath('.eslintrc')).toBe('ESLint');
    expect(getLanguageFromFilePath('.babelrc')).toBe('Babel');
  });

  it('detects dotfiles nested in a directory', () => {
    expect(getLanguageFromFilePath('project/.gitignore')).toBe('Git');
    expect(getLanguageFromFilePath('/abs/path/.editorconfig')).toBe(
      'EditorConfig',
    );
  });

  it('returns undefined for unknown extensions and bare names', () => {
    expect(getLanguageFromFilePath('archive.zip')).toBeUndefined();
    expect(getLanguageFromFilePath('LICENSE')).toBeUndefined();
    expect(getLanguageFromFilePath('.unknownrc')).toBeUndefined();
  });
});
