/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { sanitizePath } from '../utils/paths.js';

export function getTranscriptProjectsDir(
  configHomeDir: string = Storage.getGlobalConfigDir(),
): string {
  return path.join(configHomeDir, 'projects');
}

export function getTranscriptProjectDir(
  projectRoot: string,
  configHomeDir: string = Storage.getGlobalConfigDir(),
): string {
  return path.join(
    getTranscriptProjectsDir(configHomeDir),
    sanitizePath(projectRoot),
  );
}

export function getSessionTranscriptPath(
  projectRoot: string,
  sessionId: string,
  configHomeDir: string = Storage.getGlobalConfigDir(),
): string {
  return path.join(
    getTranscriptProjectDir(projectRoot, configHomeDir),
    `${sessionId}.jsonl`,
  );
}
