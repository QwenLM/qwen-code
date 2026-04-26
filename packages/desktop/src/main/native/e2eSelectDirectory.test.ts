/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getE2eSelectedDirectory,
  parseE2eSelectDirectories,
  resetE2eSelectedDirectoryForTest,
} from './e2eSelectDirectory.js';

describe('parseE2eSelectDirectories', () => {
  it('parses a single directory path', () => {
    expect(parseE2eSelectDirectories('/tmp/project-one')).toEqual([
      '/tmp/project-one',
    ]);
  });

  it('parses a JSON directory list', () => {
    expect(
      parseE2eSelectDirectories(
        JSON.stringify(['/tmp/project-one', ' /tmp/project-two ', '', 42]),
      ),
    ).toEqual(['/tmp/project-one', '/tmp/project-two']);
  });

  it('falls back to delimiter-separated directory lists', () => {
    expect(
      parseE2eSelectDirectories('/tmp/project-one:: /tmp/project-two ', ':'),
    ).toEqual(['/tmp/project-one', '/tmp/project-two']);
  });
});

describe('getE2eSelectedDirectory', () => {
  beforeEach(() => {
    resetE2eSelectedDirectoryForTest();
  });

  it('is disabled outside E2E mode', () => {
    expect(
      getE2eSelectedDirectory({
        QWEN_DESKTOP_TEST_SELECT_DIRECTORY: '/tmp/project-one',
      }),
    ).toBeNull();
  });

  it('returns configured directories in order and repeats the final entry', () => {
    const env = {
      QWEN_DESKTOP_E2E: '1',
      QWEN_DESKTOP_TEST_SELECT_DIRECTORY: JSON.stringify([
        '/tmp/project-one',
        '/tmp/project-two',
      ]),
    };

    expect(getE2eSelectedDirectory(env)).toBe('/tmp/project-one');
    expect(getE2eSelectedDirectory(env)).toBe('/tmp/project-two');
    expect(getE2eSelectedDirectory(env)).toBe('/tmp/project-two');
  });

  it('resets the sequence when the configured directory list changes', () => {
    const env = {
      QWEN_DESKTOP_E2E: '1',
      QWEN_DESKTOP_TEST_SELECT_DIRECTORY: JSON.stringify([
        '/tmp/project-one',
        '/tmp/project-two',
      ]),
    };

    expect(getE2eSelectedDirectory(env)).toBe('/tmp/project-one');
    env.QWEN_DESKTOP_TEST_SELECT_DIRECTORY = JSON.stringify([
      '/tmp/project-three',
    ]);

    expect(getE2eSelectedDirectory(env)).toBe('/tmp/project-three');
  });
});
