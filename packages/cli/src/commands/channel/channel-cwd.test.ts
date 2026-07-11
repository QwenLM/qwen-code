/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveChannelCwd } from './channel-cwd.js';

describe('resolveChannelCwd', () => {
  it('defaults to the loading workspace', () => {
    expect(resolveChannelCwd(undefined, '/workspace')).toBe(
      path.resolve('/workspace'),
    );
  });

  it('resolves home-relative paths from the user home', () => {
    expect(resolveChannelCwd('~/channels', '/workspace')).toBe(
      path.join(os.homedir(), 'channels'),
    );
  });

  it('resolves ordinary relative paths from the loading workspace', () => {
    expect(resolveChannelCwd('../channels', '/workspace/project')).toBe(
      path.resolve('/workspace/channels'),
    );
  });
});
