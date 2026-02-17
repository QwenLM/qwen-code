/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import stripJsonComments from 'strip-json-comments';
import os from 'node:os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';

const argv = yargs(hideBin(process.argv)).option('q', {
  alias: 'quiet',
  type: 'boolean',
  default: false,
}).argv;

let qwenSandbox = process.env.QWEN_SANDBOX;

if (!qwenSandbox) {
  const userSettingsFile = join(os.homedir(), '.qwen', 'settings.json');
  if (existsSync(userSettingsFile)) {
    const settings = JSON.parse(
      stripJsonComments(readFileSync(userSettingsFile, 'utf-8')),
    );
    if (settings.sandbox) {
      qwenSandbox = settings.sandbox;
    }
  }
}

if (!qwenSandbox) {
  let currentDir = process.cwd();
  while (true) {
    const qwenEnv = join(currentDir, '.qwen', '.env');
    const regularEnv = join(currentDir, '.env');
    if (existsSync(qwenEnv)) {
      dotenv.config({ path: qwenEnv, quiet: true });
      break;
    } else if (existsSync(regularEnv)) {
      dotenv.config({ path: regularEnv, quiet: true });
      break;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  qwenSandbox = process.env.QWEN_SANDBOX;
}

qwenSandbox = (qwenSandbox || '').toLowerCase();

const commandExists = (cmd) => {
  // Use 'where.exe' (not 'where') on Windows because PowerShell aliases
  // 'where' to 'Where-Object', which breaks command detection.
  const checkCommand = os.platform() === 'win32' ? 'where.exe' : 'command -v';
  try {
    execSync(`${checkCommand} ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    if (os.platform() === 'win32' && !cmd.endsWith('.exe')) {
      try {
        execSync(`${checkCommand} ${cmd}.exe`, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
};

let command = '';
if (['1', 'true'].includes(qwenSandbox)) {
  if (commandExists('docker')) {
    command = 'docker';
  } else if (commandExists('podman')) {
    command = 'podman';
  } else {
    console.error(
      'ERROR: install docker or podman or specify command in QWEN_SANDBOX',
    );
    process.exit(1);
  }
} else if (qwenSandbox && !['0', 'false'].includes(qwenSandbox)) {
  if (commandExists(qwenSandbox)) {
    command = qwenSandbox;
  } else {
    console.error(
      `ERROR: missing sandbox command '${qwenSandbox}' (from QWEN_SANDBOX)`,
    );
    process.exit(1);
  }
} else {
  if (os.platform() === 'darwin' && process.env.SEATBELT_PROFILE !== 'none') {
    if (commandExists('sandbox-exec')) {
      command = 'sandbox-exec';
    } else {
      process.exit(1);
    }
  } else {
    process.exit(1);
  }
}

if (!argv.q) {
  console.log(command);
}
process.exit(0);
