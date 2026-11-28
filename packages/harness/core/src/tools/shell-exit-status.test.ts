/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initializeShellParsers } from '../utils/shell-utils.js';
import {
  interpretShellExitStatus,
  prependShellExitStatus,
} from './shell-exit-status.js';

describe('interpretShellExitStatus', () => {
  beforeAll(async () => {
    await initializeShellParsers();
  });

  it.each([
    ['false', 1],
    ['./missing-script.sh', 127],
    ['node build.js', 2],
  ])('treats a non-zero status from %s as an error', (command, exitCode) => {
    expect(interpretShellExitStatus(command, exitCode, null)).toEqual({
      isError: true,
    });
  });

  it.each([
    ['grep needle file.txt', 'No matches found'],
    ['rg needle', 'No matches found'],
    ['egrep needle file.txt', 'No matches found'],
    ['fgrep needle file.txt', 'No matches found'],
    ['find . -name missing', 'Some directories were inaccessible'],
    ['diff before.txt after.txt', 'Files differ'],
    ['test -f missing', 'Condition is false'],
    ['[ -f missing ]', 'Condition is false'],
    ['git diff --exit-code', 'Files differ'],
    ['git -C repo grep needle', 'No matches found'],
  ])(
    'interprets exit code 1 from %s as an expected result',
    (command, message) => {
      expect(interpretShellExitStatus(command, 1, null)).toEqual({
        returnCodeInterpretation: message,
      });
    },
  );

  it('treats exit code 2 from an expected-one command as an error', () => {
    expect(interpretShellExitStatus('rg needle', 2, null)).toEqual({
      isError: true,
    });
  });

  it('uses the final command in a pipeline', () => {
    expect(
      interpretShellExitStatus('missing-command 2>&1 | head -100', 0, null),
    ).toEqual({});
  });

  it('treats a terminating signal as an error', () => {
    expect(interpretShellExitStatus('sleep 100', null, 9)).toEqual({
      isError: true,
    });
  });

  it.each([
    ['git --git-dir=/repo/.git grep needle', 'No matches found'],
    ['timeout 30 grep needle file.txt', 'No matches found'],
    ['FOO=bar grep needle file.txt', 'No matches found'],
  ])('resolves the effective command of %s', (command, message) => {
    expect(interpretShellExitStatus(command, 1, null)).toEqual({
      returnCodeInterpretation: message,
    });
  });

  it('does not treat an unrelated git subcommand as an expected exit 1', () => {
    expect(interpretShellExitStatus('git push origin main', 1, null)).toEqual({
      isError: true,
    });
  });

  it('does not confuse a longer exit code with an existing prefix', () => {
    expect(prependShellExitStatus('Exit code 10', 1, null)).toBe(
      'Exit code 1\nExit code 10',
    );
  });
});
