/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { getPermScopeItems } from './PermissionsDialog.js';

describe('getPermScopeItems', () => {
  const originalQwenHome = process.env['QWEN_HOME'];

  afterEach(() => {
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
  });

  it('shortens the default global settings path to a tilde', () => {
    delete process.env['QWEN_HOME'];
    expect(getPermScopeItems()[1]?.description).toBe(
      `Saved in ~${nodePath.sep}.qwen${nodePath.sep}settings.json`,
    );
  });

  it('names the resolved global directory when QWEN_HOME is set', () => {
    const qwenHome = nodePath.join(os.tmpdir(), 'qwen-home-perm-dialog');
    process.env['QWEN_HOME'] = qwenHome;
    expect(getPermScopeItems()[1]?.description).toBe(
      `Saved in ${qwenHome}${nodePath.sep}settings.json`,
    );
  });
});
