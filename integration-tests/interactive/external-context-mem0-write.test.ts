/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pty from '@lydell/node-pty';
import xtermHeadless from '@xterm/headless';
import { hashMcpServerConfig } from '@qwen-code/qwen-code-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { TestRig, type } from '../test-helper.js';

const SANDBOX_MODE = process.env['QWEN_SANDBOX']?.toLowerCase().trim();
const IS_SANDBOX = Boolean(
  SANDBOX_MODE && SANDBOX_MODE !== 'false' && SANDBOX_MODE !== '0',
);
const EVENT_ID = '123e4567-e89b-12d3-a456-426614174000';
const LONG_CONFIRMATION_CONTENT = [
  'CONFIRM_TOP [visible](https://hidden.example/target) **bold** `code` <u>under</u>',
  ...Array.from(
    { length: 140 },
    (_, index) => `repository-policy-line-${index.toString().padStart(3, '0')}`,
  ),
  'CONFIRM_TAIL',
].join('\n');
const ENVIRONMENT_KEYS = [
  'QWEN_HOME',
  'QWEN_CODE_SYSTEM_SETTINGS_PATH',
  'QWEN_CODE_TRUSTED_FOLDERS_PATH',
  'QWEN_CODE_MCP_APPROVALS_PATH',
  'QWEN_CODE_LEGACY_MCP_BLOCKING',
  'QWEN_EXTERNAL_CONTEXT_CONFIG',
  'MEM0_API_KEY',
  'FAKE_MEM0_BASE_URL',
  'NO_PROXY',
  'no_proxy',
] as const;

(IS_SANDBOX ? describe.skip : describe)('external context Mem0 write', () => {
  let fakeModel: FakeOpenAIServer | undefined;
  let closeMem0: (() => Promise<void>) | undefined;
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
    await closeMem0?.();
    closeMem0 = undefined;
    await rig.cleanup();
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it.each([
    {
      name: 'uses two confirmations in default mode',
      approvalMode: 'default',
      approveWrite: true,
      expectedRequests: 1,
      expectsMcpConfirmation: true,
      content:
        'LINK [visible label](https://hidden.example/secret-target) BOLD **bold-value** CODE `code-value` UNDER <u>under-value</u>',
      verifiesShortLiteral: true,
    },
    {
      name: 'does not write when content confirmation is rejected',
      approvalMode: 'default',
      approveWrite: false,
      expectedRequests: 0,
      expectsMcpConfirmation: true,
    },
    {
      name: 'asks for content confirmation in auto-edit mode',
      approvalMode: 'auto-edit',
      approveWrite: true,
      expectedRequests: 1,
      expectsMcpConfirmation: true,
    },
    {
      name: 'still asks for content confirmation in YOLO mode',
      approvalMode: 'yolo',
      approveWrite: true,
      expectedRequests: 1,
      expectsMcpConfirmation: false,
      content:
        'LINK [visible label](https://hidden.example/secret-target) BOLD **bold-value** CODE `code-value` UNDER <u>under-value</u>',
      verifiesShortLiteral: true,
    },
    {
      name: 'shows long content literally and expands it before approval',
      approvalMode: 'yolo',
      approveWrite: true,
      expectedRequests: 1,
      expectsMcpConfirmation: false,
      content: LONG_CONFIRMATION_CONTENT,
      verifiesLongConfirmation: true,
    },
  ])('$name', async (scenario) => {
    const content = scenario.content ?? '  Keep this\nrepository policy.  ';
    const providerRequests: Array<{
      authorization: string | undefined;
      path: string | undefined;
      body: unknown;
    }> = [];
    const mem0 = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      providerRequests.push({
        authorization: request.headers.authorization,
        path: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'PENDING', event_id: EVENT_ID }));
    });
    await new Promise<void>((resolve, reject) => {
      mem0.once('error', reject);
      mem0.listen(0, '127.0.0.1', resolve);
    });
    closeMem0 = () =>
      new Promise<void>((resolve, reject) => {
        mem0.close((error) => (error ? reject(error) : resolve()));
      });

    await rig.setup(`external-context-mem0-write-${scenario.approvalMode}`, {
      settings: {
        memory: {
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
        },
        security: { auth: { selectedType: 'openai' } },
      },
    });
    const paths = await configureManagedWrite(rig, mem0);

    fakeModel = await startFakeOpenAIServer(({ requestIndex }) =>
      requestIndex === 0
        ? {
            toolCalls: [
              fakeToolCall(
                'mcp__external-context__context_remember',
                { content },
                'call_external_context_remember',
              ),
            ],
          }
        : { content: 'MEM0_WRITE_E2E_DONE' },
    );
    const { ptyProcess, promise, screen } = runInteractive(
      rig,
      '--approval-mode',
      scenario.approvalMode,
      '--mcp-config',
      paths.mcpConfigPath,
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
      await type(ptyProcess, 'Remember the repository policy.');
      await type(ptyProcess, '\r');

      if (scenario.expectsMcpConfirmation) {
        expect(
          await rig.waitForText('Allow execution of MCP tool', 30_000),
          'ordinary MCP confirmation did not appear',
        ).toBe(true);
        await type(ptyProcess, '\r');
      }

      if (scenario.verifiesLongConfirmation) {
        const constrainedScreen = await waitForScreen(
          screen,
          (value) =>
            value.includes('CONFIRM_TOP') &&
            value.includes('lines hidden') &&
            value.includes('Press ctrl-s to show more lines'),
          'bounded literal content confirmation',
        );
        const constrainedConfirmation = constrainedScreen.slice(
          constrainedScreen.lastIndexOf(
            'Save this exact content to the bound Mem0 repository memory?',
          ),
        );
        expect(constrainedConfirmation).toContain(
          '[visible](https://hidden.example/target)',
        );
        expect(constrainedConfirmation).toContain('**bold**');
        expect(constrainedConfirmation).toContain('`code`');
        expect(constrainedConfirmation).toContain('<u>under</u>');
        expect(constrainedConfirmation).not.toContain('CONFIRM_TAIL');

        ptyProcess.write('\x13');
        const expandedScreen = await waitForScreen(
          screen,
          (value) =>
            value.includes('CONFIRM_TAIL') && !value.includes('lines hidden'),
          'expanded complete content confirmation',
        );
        expect(expandedScreen).toContain('CONFIRM_TAIL');
        expect(expandedScreen).not.toContain('lines hidden');
      } else if (scenario.verifiesShortLiteral) {
        const screenWithConfirmation = await waitForScreen(
          screen,
          (value) =>
            confirmationSection(value).includes('hidden.example/secret-target'),
          'short literal content confirmation',
        );
        const confirmationScreen = confirmationSection(screenWithConfirmation);
        expect(confirmationScreen).toContain('**bold-value**');
        expect(confirmationScreen).toContain('`code-value`');
        expect(confirmationScreen).toContain('<u>under-value</u>');
      } else {
        expect(
          await rig.waitForText(
            'Save this exact content to the bound Mem0 repository memory?',
            30_000,
          ),
          'content-visible Hook confirmation did not appear',
        ).toBe(true);
        expect(rig._interactiveOutput).toContain('Keep this');
      }
      await type(ptyProcess, scenario.approveWrite ? '\r' : '\x1b');

      if (scenario.approveWrite) {
        expect(
          await rig.waitForText('MEM0_WRITE_E2E_DONE', 30_000),
          'fake model turn did not complete',
        ).toBe(true);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(fakeModel.requests).toHaveLength(1);
      }
      expect(providerRequests).toHaveLength(scenario.expectedRequests);
      if (scenario.expectedRequests === 1) {
        expect(providerRequests[0]).toEqual({
          authorization: 'Token bound-mem0-project-key',
          path: '/v3/memories/add/',
          body: {
            messages: [{ role: 'user', content }],
            app_id: 'fixed-repository',
            infer: false,
          },
        });
        const toolResult = toolResultText(
          fakeModel.requests[1]?.body['messages'],
        );
        expect(toolResult).toContain('accepted');
        expect(toolResult).not.toContain('stored');
      }
    } finally {
      ptyProcess.kill();
      await promise;
    }
  });
});

async function configureManagedWrite(
  rig: TestRig,
  mem0: ReturnType<typeof createServer>,
): Promise<{ mcpConfigPath: string }> {
  const qwenHome = join(rig.testDir!, '.qwen-home');
  const trustedFoldersPath = join(qwenHome, 'trustedFolders.json');
  const approvalsPath = join(qwenHome, 'mcpApprovals.json');
  const configPath = join(qwenHome, 'external-context.json');
  const mcpConfigPath = join(qwenHome, 'mcp.json');
  const systemSettingsPath = join(qwenHome, 'system-settings.json');
  const integrationRoot = join(
    import.meta.dirname,
    '..',
    '..',
    'integrations',
    'external-context',
  );
  const hookPath = join(integrationRoot, 'dist', 'write-confirmation.js');
  const helperPath = join(rig.testDir!, 'fake-mem0-mcp.mjs');
  const serverConfig = {
    command: process.execPath,
    args: [helperPath],
    cwd: integrationRoot,
    includeTools: ['context_search', 'context_remember'],
    trust: true,
  };

  rig.mkdir('.qwen-home');
  rig.createFile(
    '.qwen-home/settings.json',
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'mcp__external-context__context_remember',
            hooks: [
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
                  },
            ],
          },
        ],
      },
    }),
  );
  const systemSettingsSource = join(
    integrationRoot,
    'examples',
    'managed-mem0-write-system-settings.json',
  );
  rig.createFile(
    '.qwen-home/system-settings.json',
    await readFile(systemSettingsSource, 'utf8'),
  );
  rig.createFile(
    '.qwen-home/trustedFolders.json',
    JSON.stringify({ [rig.testDir!]: 'TRUST_FOLDER' }),
  );
  rig.createFile(
    '.qwen-home/external-context.json',
    JSON.stringify({
      version: 1,
      timeoutMs: 1000,
      write: { enabled: true },
      provider: {
        type: 'mem0-platform-v3',
        apiKeyEnv: 'MEM0_API_KEY',
        appId: 'fixed-repository',
      },
    }),
  );
  rig.createFile(
    '.qwen-home/mcp.json',
    JSON.stringify({ mcpServers: { 'external-context': serverConfig } }),
  );
  rig.createFile(
    '.qwen-home/mcpApprovals.json',
    JSON.stringify({
      [rig.testDir!]: {
        'external-context': {
          hash: hashMcpServerConfig(serverConfig),
          status: 'approved',
        },
      },
    }),
  );
  rig.createFile('fake-mem0-mcp.mjs', fakeMem0McpSource(integrationRoot));

  const address = mem0.address() as AddressInfo;
  process.env['QWEN_HOME'] = qwenHome;
  process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = systemSettingsPath;
  process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = trustedFoldersPath;
  process.env['QWEN_CODE_MCP_APPROVALS_PATH'] = approvalsPath;
  process.env['QWEN_CODE_LEGACY_MCP_BLOCKING'] = '1';
  process.env['QWEN_EXTERNAL_CONTEXT_CONFIG'] = configPath;
  process.env['MEM0_API_KEY'] = 'bound-mem0-project-key';
  process.env['FAKE_MEM0_BASE_URL'] = `http://127.0.0.1:${address.port}`;
  process.env['NO_PROXY'] = '127.0.0.1,localhost';
  process.env['no_proxy'] = '127.0.0.1,localhost';
  return { mcpConfigPath };
}

function fakeMem0McpSource(integrationRoot: string): string {
  const moduleUrl = (path: string) =>
    pathToFileURL(join(integrationRoot, path)).href;
  const stdioUrl = pathToFileURL(
    join(
      import.meta.dirname,
      '..',
      '..',
      'node_modules',
      '@modelcontextprotocol',
      'sdk',
      'dist',
      'esm',
      'server',
      'stdio.js',
    ),
  ).href;
  return [
    `const [{ loadConfig }, { createExternalContextMcpServer }, { Mem0PlatformV3Adapter }, { StdioServerTransport }] = await Promise.all([import(${JSON.stringify(moduleUrl('dist/config.js'))}), import(${JSON.stringify(moduleUrl('dist/mcp.js'))}), import(${JSON.stringify(moduleUrl('dist/providers.js'))}), import(${JSON.stringify(stdioUrl)})]);`,
    'const config = await loadConfig();',
    "if (config.version !== 1 || config.write === undefined || config.provider.type !== 'mem0-platform-v3') throw new Error('invalid test config');",
    "const baseUrl = process.env['FAKE_MEM0_BASE_URL'];",
    "if (!baseUrl) throw new Error('missing fake Mem0 URL');",
    'const adapter = new Mem0PlatformV3Adapter(config.provider, new URL(baseUrl));',
    'const server = createExternalContextMcpServer({ config, provider: adapter, writer: adapter });',
    'await server.connect(new StdioServerTransport());',
  ].join('\n');
}

function runInteractive(rig: TestRig, ...args: string[]) {
  rig._interactiveOutput = '';
  const { Terminal } = xtermHeadless;
  const terminal = new Terminal({
    cols: 110,
    rows: 38,
    scrollback: 1000,
    allowProposedApi: true,
  });
  let pendingWrite = Promise.resolve();
  const ptyProcess = pty.spawn(
    process.execPath,
    [rig.bundlePath, '--no-chat-recording', ...args],
    {
      name: 'xterm-color',
      cols: 110,
      rows: 38,
      cwd: rig.testDir!,
      env: process.env as Record<string, string>,
    },
  );
  ptyProcess.onData((data) => {
    rig._interactiveOutput += data;
    pendingWrite = pendingWrite.then(
      () =>
        new Promise<void>((resolve) => {
          terminal.write(data, resolve);
        }),
    );
    if (process.env['VERBOSE'] === 'true') {
      process.stdout.write(data);
    }
  });
  const promise = new Promise<{
    exitCode: number;
    signal?: number;
    output: string;
  }>((resolve) => {
    ptyProcess.onExit(({ exitCode, signal }) => {
      void pendingWrite.finally(() => {
        terminal.dispose();
        resolve({ exitCode, signal, output: rig._interactiveOutput });
      });
    });
  });
  const screen = async () => {
    await pendingWrite;
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    const end = Math.min(buffer.length, buffer.viewportY + terminal.rows);
    for (let index = buffer.viewportY; index < end; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  };
  return { ptyProcess, promise, screen };
}

async function waitForScreen(
  screen: () => Promise<string>,
  predicate: (value: string) => boolean,
  description: string,
  timeoutMs = 30_000,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await screen();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const value = await screen();
  throw new Error(
    `Timed out waiting for ${description}. Last screen:\n${value.slice(-1000)}`,
  );
}

function confirmationSection(screen: string): string {
  const heading =
    'Save this exact content to the bound Mem0 repository memory?';
  const start = screen.lastIndexOf(heading);
  return start === -1 ? '' : screen.slice(start);
}

function escapePosix(value: string): string {
  return value.replaceAll("'", "'\\''");
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}

function toolResultText(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === 'object' &&
        message !== null &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>)['role'] === 'tool',
    )
    .map((message) => JSON.stringify(message['content']))
    .join('\n');
}
