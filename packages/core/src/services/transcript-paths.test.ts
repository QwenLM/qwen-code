/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getSessionTranscriptPath,
  getTranscriptProjectDir,
  getTranscriptProjectsDir,
} from './transcript-paths.js';
import { CONFIG_DIR } from '../utils/paths.js';

describe('transcript path helpers', () => {
  it('builds projects and project directories under config home', () => {
    const configHome = `/tmp/${CONFIG_DIR}`;

    expect(getTranscriptProjectsDir(configHome)).toBe(
      path.join(configHome, 'projects'),
    );
    expect(getTranscriptProjectDir('/workspace/demo', configHome)).toBe(
      path.join(configHome, 'projects', '-workspace-demo'),
    );
  });

  it('builds session transcript paths as jsonl files', () => {
    const configHome = `/tmp/${CONFIG_DIR}`;
    expect(
      getSessionTranscriptPath('/workspace/demo', 'session-123', configHome),
    ).toBe(
      path.join(configHome, 'projects', '-workspace-demo', 'session-123.jsonl'),
    );
  });
});
