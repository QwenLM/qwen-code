/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { TestRig, type } from '../test-helper.js';

// Container sandbox (QWEN_SANDBOX=docker/podman): the CLI runs inside the
// container and cannot reach the host-loopback context provider and fake
// model this test binds, nor the host-absolute Hook paths it pins. Skip under
// any container sandbox, matching the cron-interactive precedent.
const SANDBOX_MODE = process.env['QWEN_SANDBOX']?.toLowerCase().trim();
const IS_SANDBOX = Boolean(
  SANDBOX_MODE && SANDBOX_MODE !== 'false' && SANDBOX_MODE !== '0',
);

const ENVIRONMENT_KEYS = [
  'QWEN_HOME',
  'QWEN_CODE_SYSTEM_SETTINGS_PATH',
  'QWEN_CODE_TRUSTED_FOLDERS_PATH',
  'QWEN_EXTERNAL_CONTEXT_CONFIG',
  'CONTEXT_TOKEN',
  'NO_PROXY',
  'no_proxy',
] as const;

(IS_SANDBOX ? describe.skip : describe)('external context auto recall', () => {
  let fakeModel: FakeOpenAIServer | undefined;
  let closeContextProvider: (() => Promise<void>) | undefined;
  let rig: TestRig;
  let savedEnvironment: Map<string, string | undefined>;

  beforeEach(() => {
    rig = new TestRig();
    savedEnvironment = new Map(
      ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
    );
  });

  afterEach(async () => {
    await fakeModel?.close();
    fakeModel = undefined;
    await closeContextProvider?.();
    closeContextProvider = undefined;
    await rig.cleanup();
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('retrieves from the submitted prompt and adds results to the model request', async () => {
    const submittedPrompt = '@context.txt Explain the repository policy.';
    const fileCanary = 'EXPANDED_FILE_CANARY_AUTO_RECALL';
    const resultCanary = 'EXTERNAL_CONTEXT_RESULT_CANARY';
    const providerRequests: Array<{
      authorization: string | undefined;
      body: unknown;
    }> = [];
    const contextProvider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      providerRequests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          items: [{ id: 'policy', content: resultCanary }],
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      contextProvider.once('error', reject);
      contextProvider.listen(0, '127.0.0.1', resolve);
    });
    closeContextProvider = () =>
      new Promise<void>((resolve, reject) => {
        contextProvider.close((error) => (error ? reject(error) : resolve()));
      });

    await rig.setup('external-context-auto-recall', {
      settings: {
        memory: {
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
        },
        security: {
          auth: {
            selectedType: 'openai',
          },
        },
      },
    });
    const qwenHome = join(rig.testDir!, '.qwen-home');
    const trustedFoldersPath = join(qwenHome, 'trustedFolders.json');
    const configPath = join(qwenHome, 'external-context.json');
    const hookPath = join(
      import.meta.dirname,
      '..',
      '..',
      'integrations',
      'external-context',
      'dist',
      'auto-recall.js',
    );
    const systemSettingsSourcePath = join(
      import.meta.dirname,
      '..',
      '..',
      'integrations',
      'external-context',
      'examples',
      'managed-auto-recall-system-settings.json',
    );
    const systemSettingsPath = join(qwenHome, 'system-settings.json');
    const hook =
      process.platform === 'win32'
        ? {
            type: 'command',
            command: `& '${escapePowerShell(process.execPath)}' '${escapePowerShell(hookPath)}'`,
            shell: 'powershell',
            timeout: 8000,
          }
        : {
            type: 'command',
            command: `exec '${escapePosix(process.execPath)}' '${escapePosix(hookPath)}'`,
            timeout: 8000,
          };

    rig.mkdir('.qwen-home');
    rig.createFile(
      '.qwen-home/settings.json',
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ matcher: '*', hooks: [hook] }],
        },
      }),
    );
    rig.createFile(
      '.qwen-home/system-settings.json',
      await readFile(systemSettingsSourcePath, 'utf8'),
    );
    rig.createFile(
      '.qwen-home/trustedFolders.json',
      JSON.stringify({ [rig.testDir!]: 'TRUST_FOLDER' }),
    );
    const address = contextProvider.address() as AddressInfo;
    rig.createFile(
      '.qwen-home/external-context.json',
      JSON.stringify({
        version: 2,
        autoRecall: {
          repositoryRoot: rig.testDir,
          timeoutMs: 1500,
        },
        provider: {
          type: 'generic-http-search-v1',
          baseUrl: `http://127.0.0.1:${address.port}`,
          tokenEnv: 'CONTEXT_TOKEN',
        },
      }),
    );
    rig.createFile('context.txt', fileCanary);

    process.env['QWEN_HOME'] = qwenHome;
    process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = systemSettingsPath;
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = trustedFoldersPath;
    process.env['QWEN_EXTERNAL_CONTEXT_CONFIG'] = configPath;
    process.env['CONTEXT_TOKEN'] = 'bound-context-token';
    process.env['NO_PROXY'] = '127.0.0.1,localhost';
    process.env['no_proxy'] = '127.0.0.1,localhost';

    fakeModel = await startFakeOpenAIServer(() => ({
      content: 'AUTO_RECALL_E2E_DONE',
    }));
    const { ptyProcess, promise } = rig.runInteractive(
      '--auth-type',
      'openai',
      '--openai-api-key',
      'fake-key',
      '--openai-base-url',
      fakeModel.baseUrl,
      '--model',
      'fake-model',
    );

    try {
      expect(
        await rig.waitForText('Type your message', 30_000),
        'CLI did not start in interactive mode',
      ).toBe(true);

      await type(ptyProcess, submittedPrompt);
      await type(ptyProcess, '\r');

      expect(
        await rig.waitForText('AUTO_RECALL_E2E_DONE', 30_000),
        'Fake model turn did not complete',
      ).toBe(true);
      expect(providerRequests).toEqual([
        {
          authorization: 'Bearer bound-context-token',
          body: { query: submittedPrompt, limit: 5 },
        },
      ]);
      expect(JSON.stringify(providerRequests)).not.toContain(fileCanary);

      const modelBody = fakeModel.requests[0]?.body;
      const messages = modelBody?.['messages'];
      expect(Array.isArray(messages)).toBe(true);
      const userMessages = (messages as unknown[]).filter(
        (message) => isRecord(message) && message['role'] === 'user',
      );
      const systemMessages = (messages as unknown[]).filter(
        (message) => isRecord(message) && message['role'] === 'system',
      );
      const modelRequest = JSON.stringify(modelBody);
      expect(modelRequest).toContain(fileCanary);
      expect(modelRequest).toContain(resultCanary);
      expect(modelRequest).toContain('untrusted_external_context');
      expect(JSON.stringify(userMessages)).toContain(resultCanary);
      expect(JSON.stringify(systemMessages)).not.toContain(resultCanary);
    } finally {
      ptyProcess.kill();
      await promise;
    }
  });
});

function escapePosix(value: string): string {
  return value.replaceAll("'", "'\\''");
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
