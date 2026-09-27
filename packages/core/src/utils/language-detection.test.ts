/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import { getLanguageFromFilePath } from './language-detection.js';

it.each<[string, string | undefined]>([
  ['project/.gitignore', 'Git'],
  ['/abs/path/.editorconfig', 'EditorConfig'],
  ['deploy/Dockerfile', 'Dockerfile'],
  ['README.MD', 'Markdown'],
  ['.unknownrc', undefined],
])('detects the language of %s', (file, expected) => {
  expect(getLanguageFromFilePath(file)).toBe(expected);
});
