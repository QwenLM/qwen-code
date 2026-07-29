/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface LauncherState {
  unit: string;
  url: string;
  host: string;
  port: number;
  certExpiry?: string;
}

const FILE = 'launcher-state.json';

export function readState(dir: string): LauncherState | null {
  const p = join(dir, FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LauncherState;
  } catch {
    return null;
  }
}

export function writeState(dir: string, s: LauncherState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), JSON.stringify(s, null, 2));
}

export function clearState(dir: string): void {
  rmSync(join(dir, FILE), { force: true });
}
