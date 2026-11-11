/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getSessionStateDir,
  getSessionStatePath,
} from './session-state-paths.js';
import { CONFIG_DIR } from '../utils/paths.js';

describe('session state path helpers', () => {
  it('builds session state paths under a session directory', () => {
    const configHome = `/tmp/${CONFIG_DIR}`;
    const projectRoot = '/workspace/demo';

    expect(getSessionStateDir(projectRoot, 'session-123', configHome)).toBe(
      path.join(configHome, 'projects', '-workspace-demo', 'session-123'),
    );
    expect(getSessionStatePath(projectRoot, 'session-123', configHome)).toBe(
      path.join(
        configHome,
        'projects',
        '-workspace-demo',
        'session-123',
        'state.json',
      ),
    );
  });
});
