/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { internalGitArgs, internalGitEnv } from '@qwen-code/core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Run internal Git with the shared policy, without a shell or argument rewriting. */
export async function execInternalGit(
  args: string[],
  cwd: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    [...internalGitArgs(), ...args],
    {
      cwd,
      env: internalGitEnv(),
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    },
  );
  return stdout;
}
