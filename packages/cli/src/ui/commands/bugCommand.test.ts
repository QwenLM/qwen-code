/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import open from 'open';
import { bugCommand } from './bugCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { getCliVersion } from '../../utils/version.js';
import { GIT_COMMIT_INFO } from '../../generated/git-commit.js';
import { formatMemoryUsage } from '../utils/formatters.js';
import { AuthType } from '@qwen-code/qwen-code-core';

// Mock dependencies
vi.mock('open');
vi.mock('../../utils/version.js');
vi.mock('../utils/formatters.js');
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    IdeClient: {
      getInstance: () => ({
        getDetectedIdeDisplayName: vi.fn().mockReturnValue('VSCode'),
      }),
    },
  };
});
vi.mock('node:process', () => ({
  default: {
    platform: 'test-platform',
    version: 'v20.0.0',
    // Keep other necessary process properties if needed by other parts of the code
    env: process.env,
    memoryUsage: () => ({ rss: 0 }),
  },
}));

describe('bugCommand', () => {
  beforeEach(() => {
    vi.mocked(getCliVersion).mockResolvedValue('0.1.0');
    vi.mocked(formatMemoryUsage).mockReturnValue('100 MB');
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
          getModel: () => 'qwen3-coder-plus',
          getBugCommand: () => undefined,
          getIdeMode: () => true,
          getSessionId: () => 'test-session-id',
        },
        settings: {
          merged: {
            security: {
              auth: {
                selectedType: undefined,
              },
            },
          },
        },
      },
    });

    if (!bugCommand.action) throw new Error('Action is not defined');
    await bugCommand.action(mockContext, 'A test bug');

    const expectedInfo = `
* **CLI Version:** 0.1.0
* **Git Commit:** ${GIT_COMMIT_INFO}
* **Session ID:** test-session-id
* **Operating System:** test-platform v20.0.0
* **Sandbox Environment:** test
* **Auth Type:** 
* **Model Version:** qwen3-coder-plus
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
          getModel: () => 'qwen3-coder-plus',
          getBugCommand: () => ({ urlTemplate: customTemplate }),
          getIdeMode: () => true,
          getSessionId: () => 'test-session-id',
        },
        settings: {
          merged: {
            security: {
              auth: {
                selectedType: undefined,
              },
            },
          },
        },
      },
    });

    if (!bugCommand.action) throw new Error('Action is not defined');
    await bugCommand.action(mockContext, 'A custom bug');

    const expectedInfo = `
* **CLI Version:** 0.1.0
* **Git Commit:** ${GIT_COMMIT_INFO}
* **Session ID:** test-session-id
* **Operating System:** test-platform v20.0.0
* **Sandbox Environment:** test
* **Auth Type:** 
* **Model Version:** qwen3-coder-plus
* **Memory Usage:** 100 MB
* **IDE Client:** VSCode
`;
    const expectedUrl = customTemplate
      .replace('{title}', encodeURIComponent('A custom bug'))
      .replace('{info}', encodeURIComponent(expectedInfo));

    expect(open).toHaveBeenCalledWith(expectedUrl);
  });

  it('should include Base URL when auth type is OpenAI', async () => {
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getModel: () => 'qwen3-coder-plus',
          getBugCommand: () => undefined,
          getIdeMode: () => true,
          getSessionId: () => 'test-session-id',
          getContentGeneratorConfig: () => ({
            baseUrl: 'https://api.openai.com/v1',
          }),
        },
        settings: {
          merged: {
            security: {
              auth: {
                selectedType: AuthType.USE_OPENAI,
              },
            },
          },
        },
      },
    });

    if (!bugCommand.action) throw new Error('Action is not defined');
    await bugCommand.action(mockContext, 'OpenAI bug');

    const expectedInfo = `
* **CLI Version:** 0.1.0
* **Git Commit:** ${GIT_COMMIT_INFO}
* **Session ID:** test-session-id
* **Operating System:** test-platform v20.0.0
* **Sandbox Environment:** test
* **Auth Type:** ${AuthType.USE_OPENAI}
* **Base URL:** https://api.openai.com/v1
* **Model Version:** qwen3-coder-plus
* **Memory Usage:** 100 MB
* **IDE Client:** VSCode
`;
    const expectedUrl =
      'https://github.com/QwenLM/qwen-code/issues/new?template=bug_report.yml&title=OpenAI%20bug&info=' +
      encodeURIComponent(expectedInfo);

    expect(open).toHaveBeenCalledWith(expectedUrl);
  });
});
