/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

function hasCommand(cmd: string): boolean {
  try {
    execSync(`${cmd} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    try {
      execSync(`${cmd} -h`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

export type CaptureBackend = 'sox' | 'arecord' | 'none';

export function detectBackend(): CaptureBackend {
  if (hasCommand('rec') || hasCommand('sox')) return 'sox';
  if (hasCommand('arecord')) return 'arecord';
  return 'none';
}

export async function startRecording(
  outputPath: string,
  backend: CaptureBackend,
): Promise<ChildProcess> {
  if (backend === 'sox') {
    return spawn('rec', [
      '-r',
      '16000',
      '-c',
      '1',
      '-e',
      'signed',
      '-b',
      '16',
      outputPath,
      'silence',
      '1',
      '0.1',
      '1%',
      '1',
      '1.5',
      '1%',
    ]);
  } else if (backend === 'arecord') {
    return spawn('arecord', [
      '-r',
      '16000',
      '-c',
      '1',
      '-f',
      'S16_LE',
      outputPath,
    ]);
  }
  throw new Error(
    'No audio capture backend available (install sox or alsa-utils)',
  );
}

export async function stopRecording(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGINT');
    setTimeout(() => {
      proc.kill('SIGTERM');
    }, 1000);
  });
}
