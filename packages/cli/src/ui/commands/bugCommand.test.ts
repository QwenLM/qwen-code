/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import open from 'open';
import { bugCommand } from './bugCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { GIT_COMMIT_INFO } from '../../generated/git-commit.js';
import { AuthType } from '@qwen-code/qwen-code-core';
import * as systemInfoUtils from '../../utils/systemInfo.js';

// Mock dependencies
vi.mock('open');
vi.mock('../../utils/systemInfo.js');

describe('bugCommand', () => {
  beforeEach(() => {
    vi.mocked(systemInfoUtils.getExtendedSystemInfo).mockResolvedValue({
      cliVersion: '0.1.0',
      osPlatform: 'test-platform',
      osArch: 'x64',
      osRelease: '22.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: '10.0.0',
      sandboxEnv: 'test',
      modelVersion: 'qwen3-coder-plus',
      selectedAuthType: '',
      ideClient: 'VSCode',
      sessionId: 'test-session-id',
      memoryUsage: '100 MB',
      gitCommit:
        GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO)
          ? GIT_COMMIT_INFO
          : undefined,
    });
    vi.stubEnv('SANDBOX', 'qwen-test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('should generate the default GitHub issue URL', async () => {
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getBugCommand: () => undefined,
        },
      },
    });

    if (!bugCommand.action) throw new Error('Action is not defined');
    await bugCommand.action(mockContext, 'A test bug');

    const gitCommitLine =
      GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO)
        ? `* **Git Commit:** ${GIT_COMMIT_INFO}\n`
        : '';
    const expectedInfo = `
* **CLI Version:** 0.1.0
${gitCommitLine}* **Model:** qwen3-coder-plus
* **Sandbox:** test
* **OS Platform:** test-platform
* **OS Arch:** x64
* **OS Release:** 22.0.0
* **Node.js Version:** v20.0.0
* **NPM Version:** 10.0.0
* **Session ID:** test-session-id
* **Auth Method:** 
* **Memory Usage:** 100 MB
* **IDE Client:** VSCode
`;
    const expectedUrl =
      'https://github.com/QwenLM/qwen-code/issues/new?template=bug_report.yml&title=A%20test%20bug&info=' +
      encodeURIComponent(expectedInfo);

    expect(open).toHaveBeenCalledWith(expectedUrl);
  });

  it('should use a custom URL template from config if provided', async () => {
    const customTemplate =
      'https://internal.bug-tracker.com/new?desc={title}&details={info}';
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getBugCommand: () => ({ urlTemplate: customTemplate }),
        },
      },
    });

    if (!bugCommand.action) throw new Error('Action is not defined');
    await bugCommand.action(mockContext, 'A custom bug');

    const gitCommitLine =
      GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO)
        ? `* **Git Commit:** ${GIT_COMMIT_INFO}\n`
        : '';
    const expectedInfo = `
* **CLI Version:** 0.1.0
${gitCommitLine}* **Model:** qwen3-coder-plus
* **Sandbox:** test
* **OS Platform:** test-platform
* **OS Arch:** x64
* **OS Release:** 22.0.0
* **Node.js Version:** v20.0.0
* **NPM Version:** 10.0.0
* **Session ID:** test-session-id
* **Auth Method:** 
* **Memory Usage:** 100 MB
* **IDE Client:** VSCode
`;
    const expectedUrl = customTemplate
      .replace('{title}', encodeURIComponent('A custom bug'))
      .replace('{info}', encodeURIComponent(expectedInfo));

    expect(open).toHaveBeenCalledWith(expectedUrl);
  });

  it('should include Base URL when auth type is OpenAI', async () => {
    vi.mocked(systemInfoUtils.getExtendedSystemInfo).mockResolvedValue({
      cliVersion: '0.1.0',
      osPlatform: 'test-platform',
      osArch: 'x64',
      osRelease: '22.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: '10.0.0',
      sandboxEnv: 'test',
      modelVersion: 'qwen3-coder-plus',
      selectedAuthType: AuthType.USE_OPENAI,
      ideClient: 'VSCode',
      sessionId: 'test-session-id',
      memoryUsage: '100 MB',
      baseUrl: 'https://api.openai.com/v1',
      gitCommit:
        GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO)
          ? GIT_COMMIT_INFO
          : undefined,
    });

    const mockContext = createMockCommandContext({
      services: {
        config: {
          getBugCommand: () => undefined,
        },
      },
    });

    if (!bugCommand.action) throw new Error('Action is not defined');
    await bugCommand.action(mockContext, 'OpenAI bug');

    const gitCommitLine =
      GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO)
        ? `* **Git Commit:** ${GIT_COMMIT_INFO}\n`
        : '';
    const expectedInfo = `
* **CLI Version:** 0.1.0
${gitCommitLine}* **Model:** qwen3-coder-plus
* **Sandbox:** test
* **OS Platform:** test-platform
* **OS Arch:** x64
* **OS Release:** 22.0.0
* **Node.js Version:** v20.0.0
* **NPM Version:** 10.0.0
* **Session ID:** test-session-id
* **Auth Method:** ${AuthType.USE_OPENAI}
* **Base URL:** https://api.openai.com/v1
* **Memory Usage:** 100 MB
* **IDE Client:** VSCode
`;
    const expectedUrl =
      'https://github.com/QwenLM/qwen-code/issues/new?template=bug_report.yml&title=OpenAI%20bug&info=' +
      encodeURIComponent(expectedInfo);

    expect(open).toHaveBeenCalledWith(expectedUrl);
  });
});
