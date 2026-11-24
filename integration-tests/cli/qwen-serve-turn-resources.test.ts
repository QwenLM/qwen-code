/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { isNonBlockingAccepted } from '@qwen-code/sdk/daemon';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { spawnDaemon, type SpawnedDaemon } from './_daemon-harness.js';
import { quotePosix } from '../helpers/hosted-shell-quote.js';

const poll = { timeout: 30_000 };
const require = createRequire(import.meta.url);

describe.skipIf(
  process.platform === 'win32' ||
    Boolean(
      process.env['QWEN_SANDBOX'] && process.env['QWEN_SANDBOX'] !== 'false',
    ),
)('turn-stable managed resources', () => {
  let root: string;
  let workspace: string;
  let qwenHome: string;
  let model: FakeOpenAIServer | undefined;
  let daemon: SpawnedDaemon | undefined;
  let results: Map<string, string[]>;

  beforeEach(() => {
    root = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'qwen-turn-resources-')),
    );
    workspace = path.join(root, 'project');
    qwenHome = path.join(root, 'home', '.qwen');
    mkdirSync(workspace);
    mkdirSync(qwenHome, { recursive: true });
    writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({
        security: {
          auth: { selectedType: 'openai' },
          folderTrust: { enabled: true },
        },
        skills: { disabledLevels: ['user'] },
        tools: { toolSearch: { enabled: false } },
      }),
    );
    writeFileSync(
      path.join(qwenHome, 'trustedFolders.json'),
      JSON.stringify({ [workspace]: 'TRUST_FOLDER' }),
    );
    results = new Map();
  });

  afterEach(async () => {
    try {
      await daemon?.dispose();
    } finally {
      await model?.close();
      rmSync(root, { recursive: true, force: true });
      daemon = undefined;
      model = undefined;
    }
  });

  async function start() {
    model = await startFakeOpenAIServer(({ body }) => {
      const messages = body['messages'] as Array<{
        role: string;
        content: unknown;
      }>;
      const index = messages.findLastIndex(
        (m) =>
          m.role === 'user' &&
          /RESOURCE_PROBE_(skill|extension)_\w+/.test(
            JSON.stringify(m.content),
          ),
      );
      if (index === -1) return { content: 'ok' };
      const tag = JSON.stringify(messages[index].content).match(
        /RESOURCE_PROBE_(skill|extension)_\w+/,
      )![0];
      const outputs = messages
        .slice(index + 1)
        .filter((m) => m.role === 'tool')
        .map((m) => {
          if (typeof m.content === 'string') return m.content;
          return (m.content as Array<{ text?: string }>)
            .map((part) => part.text ?? '')
            .join('\n');
        });
      results.set(tag, outputs);
      if (tag.startsWith('RESOURCE_PROBE_extension')) {
        const tools = body['tools'] as Array<{ function: { name: string } }>;
        const tool = tools.find((t) =>
          t.function.name.endsWith('suite_marker'),
        );
        if (outputs.length === 0) {
          if (tool)
            return { toolCalls: [fakeToolCall(tool.function.name, {})] };
          throw new Error(
            'Extension MCP tool missing: ' +
              tools.map((t) => t.function.name).join(', '),
          );
        }
      } else {
        const asksFirst = tag === 'RESOURCE_PROBE_skill_question';
        if (asksFirst && outputs.length === 0) {
          return {
            toolCalls: [
              fakeToolCall('ask_user_question', {
                questions: [
                  {
                    header: 'Version probe',
                    question: 'Which report should I run?',
                    options: [
                      { label: 'Sales', description: 'Sales report' },
                      { label: 'Revenue', description: 'Revenue report' },
                    ],
                  },
                ],
              }),
            ],
          };
        }
        const skillOutputs = asksFirst ? outputs.slice(1) : outputs;
        if (skillOutputs.length === 0)
          return { toolCalls: [fakeToolCall('skill', { skill: 'review' })] };
        if (skillOutputs.length === 1) {
          const dir = skillOutputs[0].match(
            /Base directory for this skill: ([^\n]+)/,
          )?.[1];
          if (dir)
            return {
              toolCalls: [
                fakeToolCall('run_shell_command', {
                  command:
                    'node ' + quotePosix(path.join(dir, 'companion.cjs')),
                  description: 'Read companion version',
                }),
              ],
            };
        }
      }
      return { content: 'done' };
    });
    daemon = await spawnDaemon({
      workspaceCwd: workspace,
      bootTimeoutMs: 60_000,
      envDrop: [/^QWEN_/, /^OPENAI_/, /^https?_proxy$/i, /^all_proxy$/i],
      env: {
        HOME: path.dirname(qwenHome),
        QWEN_HOME: qwenHome,
        QWEN_RUNTIME_DIR: path.join(root, 'runtime'),
        QWEN_SERVE_NO_PERSISTENT_REGISTRATION: '1',
        QWEN_CODE_NO_RELAUNCH: 'true',
        QWEN_SANDBOX: 'false',
        OPENAI_API_KEY: 'local-fixture',
        OPENAI_BASE_URL: model.baseUrl,
        OPENAI_MODEL: 'fixture',
        QWEN_MODEL: 'fixture',
        NO_PROXY: '127.0.0.1,localhost',
      },
    });
  }

  async function session(mode: 'default' | 'yolo') {
    const { sessionId } = await daemon!.client.createOrAttachSession({
      workspaceCwd: workspace,
      sessionScope: 'thread',
    });
    await daemon!.client.setSessionApprovalMode(sessionId, mode);
    return sessionId;
  }

  async function prompt(id: string, tag: string, generation?: number) {
    const accepted = await daemon!.client.promptNonBlocking(id, {
      prompt: [{ type: 'text', text: tag }],
      pinSkills: true,
      idempotencyKey: tag,
      ...(generation === undefined
        ? {}
        : { pinExtensions: true, expectedExtensionGeneration: generation }),
    });
    if (!isNonBlockingAccepted(accepted))
      throw new Error('expected a native prompt receipt');
    expect(accepted.skillDigest).toMatch(/^[0-9a-f]{64}$/);
    if (generation !== undefined)
      expect(accepted.extensionGeneration).toBe(generation);
    return accepted.promptId;
  }

  async function complete(id: string, turn: string) {
    await expect
      .poll(async () => {
        const response = await fetch(
          daemon!.base + `/session/${id}/turns/${turn}`,
          {
            headers: { Authorization: 'Bearer ' + daemon!.token },
            signal: AbortSignal.timeout(30_000),
          },
        );
        expect(response.status).toBe(200);
        return (await response.json()).state;
      }, poll)
      .toBe('completed');
  }

  async function approval(id: string) {
    const pending = async () =>
      (await daemon!.client.sessionStatus(id)).pendingInteractions?.find(
        (p) => p.kind === 'permission',
      );
    await expect.poll(pending, poll).toBeDefined();
    const item = (await pending())!;
    const option = item.options.find((o) => o.kind === 'allow_once');
    expect(option).toBeDefined();
    return async () =>
      expect(
        await daemon!.client.respondToPermission(item.requestId, {
          outcome: { outcome: 'selected', optionId: option!.optionId },
        }),
      ).toBe(true);
  }

  function writeSkill(version: number) {
    const dir = path.join(workspace, '.qwen', 'skills', 'review');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: review\ndescription: show resource version\n---\nBODY_v${version}\n`,
    );
    writeFileSync(
      path.join(dir, 'companion.cjs'),
      `console.log('SCRIPT_v${version}');\n`,
    );
  }

  function writeSessionSkill() {
    const unused = path.join(workspace, '.qwen', 'skills', 'unused');
    mkdirSync(unused, { recursive: true });
    writeFileSync(
      path.join(unused, 'SKILL.md'),
      `---
name: unused
description: A separate capability the prompt never invokes
allowedTools: [read_file]
hooks:
  PreToolUse:
    - matcher: Shell
      hooks:
        - type: command
          command: exit 2
---
Unrelated skill.
`,
    );
  }

  it('checks session effects on the reserved material before returning a native receipt', async () => {
    writeSkill(1);
    writeSessionSkill();
    await start();
    const id = await session('yolo');
    const tag = 'RESOURCE_PROBE_skill_guard';
    const body = {
      prompt: [{ type: 'text' as const, text: tag }],
      idempotencyKey: tag,
      pinSkills: true,
      requireSessionSkillEffects: true,
    };
    const post = (params: typeof body) =>
      fetch(daemon!.base + '/session/' + id + '/prompt', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + daemon!.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });
    const declined = await post(body);
    expect(declined.status).toBe(409);
    expect(await declined.json()).toMatchObject({
      code: 'turn_skill_session_effects_unavailable',
      sessionId: id,
      definitivelyNotStarted: true,
    });
    expect(results.has(tag)).toBe(false);

    rmSync(path.join(workspace, '.qwen', 'skills', 'unused'), {
      recursive: true,
    });
    const accepted = await daemon!.client.promptNonBlocking(id, body);
    if (!isNonBlockingAccepted(accepted))
      throw new Error('expected native receipt');
    expect(accepted.sessionSkillEffectsChecked).toBe(true);
    await complete(id, accepted.promptId);
    expect(results.get(tag)).toContainEqual(
      expect.stringContaining('SCRIPT_v1'),
    );

    writeSessionSkill();
    const retry = await daemon!.client.promptNonBlocking(id, body);
    expect(retry).toMatchObject({
      promptId: accepted.promptId,
      sessionSkillEffectsChecked: true,
      deduplicated: true,
    });
    const incompatible = await post({
      ...body,
      requireSessionSkillEffects: false,
    });
    expect(incompatible.status).toBe(409);
    expect(await incompatible.json()).toMatchObject({
      code: 'turn_skill_receipt_conflict',
    });
  }, 120_000);

  it('holds the first skill and companion through approval while another session and the next prompt use the new files', async () => {
    writeSkill(1);
    writeSessionSkill();
    await start();
    const a = await session('default');
    const first = await prompt(a, 'RESOURCE_PROBE_skill_first');
    const allowSkill = await approval(a);
    writeSkill(2);
    const b = await session('yolo');
    await complete(b, await prompt(b, 'RESOURCE_PROBE_skill_parallel'));
    await allowSkill();
    await (
      await approval(a)
    )();
    await complete(a, first);
    await daemon!.client.setSessionApprovalMode(a, 'yolo');
    await complete(a, await prompt(a, 'RESOURCE_PROBE_skill_next'));
    for (const [turn, rev] of [
      ['first', 1],
      ['parallel', 2],
      ['next', 2],
    ] as const) {
      expect(results.get('RESOURCE_PROBE_skill_' + turn)).toEqual([
        expect.stringContaining('BODY_v' + rev),
        expect.stringContaining('SCRIPT_v' + rev),
      ]);
    }
  }, 120_000);

  it('answers an outstanding question on v1 after a second session has completed on v2', async () => {
    writeSkill(1);
    await start();
    const { client } = daemon!;
    const a = await session('yolo');
    const tag = 'RESOURCE_PROBE_skill_question';
    const turn = await prompt(a, tag);
    const question = async () =>
      (await client.sessionStatus(a)).pendingInteractions?.find(
        (item) => item.kind === 'user_question',
      );
    await expect.poll(question, poll).toMatchObject({
      questions: [{ question: 'Which report should I run?' }],
    });
    const pending = (await question())!;

    writeSkill(2);
    const b = await session('yolo');
    expect(b).not.toBe(a);
    const parallel = 'RESOURCE_PROBE_skill_question_parallel';
    await complete(b, await prompt(b, parallel));
    expect(results.get(parallel)).toEqual([
      expect.stringContaining('BODY_v2'),
      expect.stringContaining('SCRIPT_v2'),
    ]);
    expect((await question())?.requestId).toBe(pending.requestId);

    const answer = 'report-' + randomUUID();
    const allow = pending.options.find(
      (option) => option.kind === 'allow_once',
    );
    expect(allow).toBeDefined();
    expect(
      await client.respondToPermission(pending.requestId, {
        outcome: { outcome: 'selected', optionId: allow!.optionId },
        answers: { [pending.questions[0]!.answerKey]: answer },
      }),
    ).toBe(true);
    await complete(a, turn);
    expect(results.get(tag)).toEqual([
      expect.stringContaining(answer),
      expect.stringContaining('BODY_v1'),
      expect.stringContaining('SCRIPT_v1'),
    ]);

    const next = 'RESOURCE_PROBE_skill_question_next';
    await complete(a, await prompt(a, next));
    expect(results.get(next)).toEqual([
      expect.stringContaining('BODY_v2'),
      expect.stringContaining('SCRIPT_v2'),
    ]);
  }, 120_000);

  function writeExtension(version: number) {
    const dir = path.join(workspace, 'package-' + version);
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, 'qwen-extension.json'),
      JSON.stringify({
        name: 'turn-suite',
        hooks: {
          PostToolUse: [
            {
              matcher: 'mcp__probe__suite_marker',
              hooks: [
                {
                  type: 'command',
                  command: `printf 'HOOK_v${version}\\n' >> ${quotePosix(path.join(workspace, 'hook-observed'))}`,
                },
              ],
            },
          ],
        },
        version: `1.0.${version}`,
        mcpServers: {
          probe: {
            command: process.execPath,
            args: ['${extensionPath}/server.cjs'],
          },
        },
      }),
    );
    const server = require.resolve('@modelcontextprotocol/sdk/server/mcp.js');
    const stdio = require.resolve('@modelcontextprotocol/sdk/server/stdio.js');
    writeFileSync(
      path.join(dir, 'server.cjs'),
      `
const { McpServer } = require(${JSON.stringify(server)});
const { StdioServerTransport } = require(${JSON.stringify(stdio)});
const server = new McpServer({name:'marker',version:'1.0.${version}'});
server.tool('suite_marker','Returns the version of this running process',{},async()=>({content:[{type:'text',text:'PROCESS_v${version} pid='+process.pid}]}));
server.connect(new StdioServerTransport());`,
    );
    const archive = dir + '.tar.gz';
    execFileSync('tar', [
      '-czf',
      archive,
      '-C',
      dir,
      'qwen-extension.json',
      'server.cjs',
    ]);
    return archive;
  }

  it('protects a pending extension tool and lets the same session invoke the upgraded MCP process after settlement', async () => {
    const v1 = writeExtension(1),
      v2 = writeExtension(2);
    await start();
    const { client } = daemon!;
    const install = async (source: string) =>
      await client.installUserExtension({
        source,
        consent: true,
        activation: { scope: 'user' },
      });
    const settled = async (id: string) => {
      const read = () => client.extensionOperationStatus(id);
      await expect
        .poll(
          async () => ['succeeded', 'failed'].includes((await read()).status),
          poll,
        )
        .toBe(true);
      return await read();
    };
    expect((await settled((await install(v1)).operationId)).status).toBe(
      'succeeded',
    );
    const catalog = await client.extensionCatalog();
    const extension = catalog.extensions.find((x) => x.name === 'turn-suite')!;
    expect(extension.version).toBe('1.0.1');
    const warm = await session('yolo');
    await client.initializeWorkspaceMcp();
    await expect
      .poll(
        async () =>
          (await client.workspaceMcpTools('probe')).tools.map((t) => t.name),
        poll,
      )
      .toContain('mcp__probe__suite_marker');
    const tag = 'RESOURCE_PROBE_extension_control';
    await client.prompt(warm, { prompt: [{ type: 'text', text: tag }] });
    expect(results.get(tag)).toEqual([expect.stringContaining('PROCESS_v1')]);
    const a = await session('default');
    const first = await prompt(
      a,
      'RESOURCE_PROBE_extension_first',
      catalog.generation,
    );
    const allow = await approval(a);
    const removal = await fetch(
      `${daemon!.base}/extensions/${encodeURIComponent(extension.id)}?waitForTurnDrainMs=30000`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + daemon!.token },
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(removal.status).toBe(202);
    const { operationId } = await removal.json();
    const removing = () => client.extensionOperationStatus(operationId);
    await expect
      .poll(async () => (await removing()).phase, poll)
      .toBe('committing');
    expect((await client.extensionCatalog()).generation).toBe(
      catalog.generation,
    );
    await allow();
    await complete(a, first);
    expect(results.get('RESOURCE_PROBE_extension_first')).toEqual([
      expect.stringContaining('PROCESS_v1'),
    ]);
    expect(await settled(operationId)).toMatchObject({
      operationId,
      status: 'succeeded',
    });
    expect((await removing()).status).toBe('succeeded');
    expect((await settled((await install(v2)).operationId)).status).toBe(
      'succeeded',
    );
    const latest = await client.extensionCatalog();
    expect(latest.generation).toBeGreaterThan(catalog.generation);
    expect(
      latest.extensions.find((x) => x.name === 'turn-suite')?.version,
    ).toBe('1.0.2');
    await client.setSessionApprovalMode(a, 'yolo');
    await complete(
      a,
      await prompt(a, 'RESOURCE_PROBE_extension_next', latest.generation),
    );
    const fresh = await session('yolo');
    await complete(
      fresh,
      await prompt(fresh, 'RESOURCE_PROBE_extension_fresh', latest.generation),
    );
    const hooks = readFileSync(path.join(workspace, 'hook-observed'), 'utf8')
      .trim()
      .split(/\r?\n/);
    expect(hooks).toEqual(['HOOK_v1', 'HOOK_v1', 'HOOK_v2', 'HOOK_v2']);
    expect(results.get('RESOURCE_PROBE_extension_fresh')).toEqual([
      expect.stringContaining('PROCESS_v2'),
    ]);
    expect(results.get('RESOURCE_PROBE_extension_next')).toEqual([
      expect.stringContaining('PROCESS_v2'),
    ]);
  }, 120_000);
});
