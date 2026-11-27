/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { getTranscriptProjectDir } from './transcript-paths.js';

export function getSessionStateDir(
  projectRoot: string,
  sessionId: string,
  configHomeDir: string = Storage.getGlobalConfigDir(),
): string {
  return path.join(
    getTranscriptProjectDir(projectRoot, configHomeDir),
    sessionId,
  );
}

export function getSessionStatePath(
  projectRoot: string,
  sessionId: string,
  configHomeDir: string = Storage.getGlobalConfigDir(),
): string {
  return path.join(
    getSessionStateDir(projectRoot, sessionId, configHomeDir),
    'state.json',
  );
}
