/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
  IS_CONTAINER_SANDBOX,
  TestRig,
} from '../test-helper.js';

const CALL_ID = 'call-ancestor-workflow';
const MARKERS = {
  root: 'DW01_ROOT_4C8D',
  packages: 'DW01_PACKAGES_6B2E',
  user: 'DW01_USER_9A1F',
};

type Message = {
  role?: string;
  tool_call_id?: string;
  content?: string | Array<{ text?: string }>;
};

function messageText(message: Message): string {
  if (typeof message.content !== 'string') {
    return message.content?.map((part) => part.text ?? '').join('\n') ?? '';
  }
  try {
    const parts = JSON.parse(message.content) as Array<{ text?: string }>;
    if (Array.isArray(parts))
      return parts.map((part) => part.text ?? '').join('\n');
  } catch {
    return message.content;
  }
  return message.content;
}

describe('headless local workflow ancestor discovery', () => {
  let rig: TestRig;
  let fixtureRoot: string | undefined;
  let server: FakeOpenAIServer | undefined;
  let restoreNoProxy: (() => void) | undefined;

  afterEach(async () => {
    await server?.close();
    if (rig && fixtureRoot) rig.testDir = fixtureRoot;
    await rig?.cleanup();
    restoreNoProxy?.();
    vi.unstubAllEnvs();
    server = undefined;
    fixtureRoot = undefined;
    restoreNoProxy = undefined;
  });

  it.each([
    {
      title: 'reads a trusted repository ancestor',
      folderTrust: true,
      trustAncestors: true,
      nearerDefinition: false,
      expected: 'root' as const,
    },
    {
      title: 'does not derive ancestor permission from target trust',
      folderTrust: true,
      trustAncestors: false,
      nearerDefinition: false,
      expected: 'user' as const,
    },
    {
      title: 'uses the explicit local policy when folder trust is disabled',
      folderTrust: false,
      trustAncestors: false,
      nearerDefinition: false,
      expected: 'root' as const,
    },
    {
      title: 'selects the nearest trusted definition',
      folderTrust: true,
      trustAncestors: true,
      nearerDefinition: true,
      expected: 'packages' as const,
    },
    {
      title: 'does not let workspace settings disable operator ancestor trust',
      folderTrust: true,
      trustAncestors: false,
      nearerDefinition: false,
      workspaceDisablesTrust: true,
      expected: 'user' as const,
    },
  ])('$title', async (testCase) => {
    rig = new TestRig();
    restoreNoProxy = applyContainerSandboxNoProxy();
    await rig.setup(`workflow-ancestors-${testCase.expected}`, {
      settings: { telemetry: { enabled: false } },
    });
    fixtureRoot = rig.testDir!;
    const target = join(fixtureRoot, 'packages', 'a');
    const home = join(fixtureRoot, '.test-home');
    mkdirSync(target, { recursive: true });
    mkdirSync(home, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: fixtureRoot });
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        general: { enableAutoUpdate: false },
        tools: { workflowsEnabled: true },
        model: { skipWorkflowUsageWarning: true },
        memory: {
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
        },
        security: { folderTrust: { enabled: testCase.folderTrust } },
      }),
    );
    const trustPath = join(home, 'trustedFolders.json');
    if ('workspaceDisablesTrust' in testCase) {
      mkdirSync(join(target, '.qwen'), { recursive: true });
      writeFileSync(
        join(target, '.qwen', 'settings.json'),
        JSON.stringify({ security: { folderTrust: { enabled: false } } }),
      );
    }
    writeFileSync(
      trustPath,
      JSON.stringify({
        ...('workspaceDisablesTrust' in testCase
          ? { [fixtureRoot]: 'DO_NOT_TRUST' }
          : {}),
        [testCase.trustAncestors ? fixtureRoot : target]: 'TRUST_FOLDER',
      }),
    );
    const writeWorkflow = (dir: string, marker: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'shared.js'),
        `return JSON.stringify({ marker: ${JSON.stringify(marker)}, args });`,
      );
    };
    writeWorkflow(join(fixtureRoot, '.qwen', 'workflows'), MARKERS.root);
    writeWorkflow(join(home, 'workflows'), MARKERS.user);
    if (testCase.nearerDefinition) {
      writeWorkflow(
        join(fixtureRoot, 'packages', '.qwen', 'workflows'),
        MARKERS.packages,
      );
    }

    let sentWorkflow = false;
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['stream'] !== true) return { content: '{}' };
      if (!sentWorkflow) {
        sentWorkflow = true;
        return {
          toolCalls: [
            fakeToolCall(
              'workflow',
              { name: 'shared', args: { probe: 41 } },
              CALL_ID,
            ),
          ],
        };
      }
      return { content: 'ANCESTOR_PROBE_FINISHED' };
    }, fakeServerHostOptions());
    vi.stubEnv('QWEN_HOME', home);
    vi.stubEnv('QWEN_RUNTIME_DIR', join(fixtureRoot, '.runtime'));
    vi.stubEnv('QWEN_CODE_TRUSTED_FOLDERS_PATH', trustPath);
    vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', '0');
    if (IS_CONTAINER_SANDBOX) {
      // The container bind-mounts only the workdir (packages/a); the trusted
      // ancestors under test sit above it, so mount the fixture root too.
      vi.stubEnv('SANDBOX_MOUNTS', fixtureRoot);
    }
    rig.testDir = target;
    await rig.run(
      'Run the shared workflow with the probe argument.',
      '--auth-type',
      'openai',
      '--openai-base-url',
      server.baseUrl,
      '--openai-api-key',
      'fake-key',
      '--model',
      'fake-model',
      '--max-session-turns',
      '3',
    );
    const toolResult = server.requests
      .filter(({ body }) => body['stream'] === true)
      .flatMap(({ body }) => body['messages'] as Message[])
      .find(
        (message) =>
          message.role === 'tool' && message.tool_call_id === CALL_ID,
      );
    expect(toolResult).toBeDefined();
    const result = messageText(toolResult!);
    expect(result).toContain(MARKERS[testCase.expected]);
    expect(result).toContain('"probe":41');
    const selectedPath = /^script: (.+)$/m.exec(result)?.[1]?.trim();
    expect(selectedPath).toBeDefined();
    const expectedDir = {
      root: join(fixtureRoot, '.qwen', 'workflows'),
      packages: join(fixtureRoot, 'packages', '.qwen', 'workflows'),
      user: join(home, 'workflows'),
    }[testCase.expected];
    expect(realpathSync(selectedPath!)).toBe(
      realpathSync(join(expectedDir, 'shared.js')),
    );
    for (const [scope, marker] of Object.entries(MARKERS)) {
      if (scope !== testCase.expected) expect(result).not.toContain(marker);
    }
  });
});
