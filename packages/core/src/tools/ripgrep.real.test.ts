/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import {
  _resetRipgrepUtilsCachesForTest,
  getBuiltinRipgrep,
} from '../utils/ripgrepUtils.js';
import { _resetRipGrepCachesForTest, RipGrepTool } from './ripGrep.js';
import { ToolErrorType } from './tool-error.js';

const rgPath = getBuiltinRipgrep();
const hasBuiltinRg = rgPath !== null && fs.existsSync(rgPath);

describe.skipIf(!hasBuiltinRg)('Grep with real ripgrep', () => {
  let tmpDir: string;
  let tool: RipGrepTool;

  beforeAll(() => {
    _resetRipgrepUtilsCachesForTest();
    _resetRipGrepCachesForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-regex-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'fixture.txt'),
      'HELLO\nhello\nTODO\ntodo\n-dash\n',
    );
    tool = new RipGrepTool({
      getTargetDir: () => tmpDir,
      getWorkspaceContext: () => createMockWorkspaceContext(tmpDir),
      getWorkingDir: () => tmpDir,
      getUseBuiltinRipgrep: () => true,
      getUsageStatisticsEnabled: () => false,
      getFileFilteringOptions: () => ({
        respectGitIgnore: false,
        respectQwenIgnore: false,
      }),
      getTruncateToolOutputThreshold: () => 25000,
      getTruncateToolOutputLines: () => 1000,
    } as unknown as Config);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetRipgrepUtilsCachesForTest();
    _resetRipGrepCachesForTest();
  });

  it.each<[string, string[]]>([
    ['hello', ['fixture.txt:1:HELLO', 'fixture.txt:2:hello']],
    ['(?i)hello', ['fixture.txt:1:HELLO', 'fixture.txt:2:hello']],
    ['(?i:hello)', ['fixture.txt:1:HELLO', 'fixture.txt:2:hello']],
    ['(?m)^hello$', ['fixture.txt:1:HELLO', 'fixture.txt:2:hello']],
    ['(?-i)TODO', ['fixture.txt:3:TODO']],
    ['(?-i:TODO)', ['fixture.txt:3:TODO']],
    ['-dash', ['fixture.txt:5:-dash']],
  ])('preserves native matching for %s', async (pattern, matches) => {
    const result = await tool
      .build({ pattern })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.returnDisplay).toBe(
      `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`,
    );
    for (const match of matches) {
      expect(result.llmContent).toContain(match);
    }
  });

  it.each(['[[', '(?=hello)'])(
    'reports native syntax errors for %s',
    async (pattern) => {
      const result = await tool
        .build({ pattern })
        .execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.GREP_EXECUTION_ERROR);
      expect(result.error?.message).toContain('regex parse error');
      expect(result.llmContent).toContain('regex parse error');
      expect(result.llmContent).not.toContain('No matches found');
    },
  );

  it('treats a valid pattern with no matches as success', async () => {
    const result = await tool
      .build({ pattern: 'absent-pattern' })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.returnDisplay).toBe('No matches found');
  });
});
