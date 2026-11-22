/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mods in ACP sessions, on the built CLI over `--acp`: each session loads its
 * own Mods, hears its session and turn events on either agent loop, calls the
 * model and the store, and sends its log lines to the client as
 * `qwen/notify/session/mod-log`.
 */

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { removeScratchDir } from '../scratch-dir.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = join(repo, 'dist/cli.js');
const run = promisify(execFile);
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

type Message = { role: string; content?: unknown };
const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? '').join('\n')
      : '';

describe.each([false, true])('Mods in an ACP session (shared=%s)', (shared) => {
  let server: FakeOpenAIServer | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (scratch) await removeScratchDir(scratch);
    scratch = undefined;
  });

  it('runs session-local Mods and reports turn outcomes', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'qwen-mods-acp-'));
    const workspace = join(scratch, 'workspace');
    const home = join(scratch, 'home');
    const qwenHome = join(home, '.qwen');
    const plugin = join(scratch, 'acp-probe');
    for (const directory of [
      workspace,
      qwenHome,
      join(plugin, '.claude-plugin'),
      join(plugin, 'hooks'),
    ])
      mkdirSync(directory, { recursive: true });
    writeFileSync(join(workspace, 'notes.txt'), 'Notes for the second turn.');
    json(join(qwenHome, 'settings.json'), {
      experimental: { mods: true, unifiedAgentLoop: shared },
      general: { enableAutoUpdate: false, chatRecording: true },
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      model: {
        skipNextSpeakerCheck: true,
        sessionTokenLimit: 9_000,
        loopProtection: 'stop',
      },
      ui: { enableFollowupSuggestions: false },
      telemetry: { enabled: false },
      security: {
        folderTrust: { enabled: false },
        auth: { selectedType: 'openai' },
      },
    });
    json(join(plugin, '.claude-plugin/plugin.json'), {
      name: 'acp-probe',
      version: '1.0.0',
    });
    json(join(plugin, 'hooks/hooks.json'), { modules: ['./register.js'] });
    // `turns` lives in the module, so each session's worker counts its own.
    writeFileSync(
      join(plugin, 'hooks/register.js'),
      `let turns = 0;
      export function register(on) {
        on('tool.call', ($, e, next) => next(e));
        on('session.start', async ($, e, next) => {
          $.ui.log('start ' + e.surface + ' ' + e.isInteractive + ' '
            + JSON.stringify(await $.session.surfaces()));
          return next(e);
        });
        on('turn.start', async ($, e, next) => {
          $.ui.log('turn.start ' + e.text);
          if (e.text === 'Abort after first chunk') {
            await $.model.complete({ model: 'sonnet', prompt: 'Wait for first chunk' });
            await $.turn.abort({ turnId: e.turnId });
          }
          return next(e);
        });
        on('session.end', ($, e, next) => { $.ui.log('end ' + e.reason); return next(e); });
        on('turn.complete', async ($, e, next) => {
          await next(e);
          if (e.reason !== 'answer') return { text: 'ended ' + e.reason };
          const r = await $.model.complete({ model: 'sonnet', prompt: 'Summarize: ' + e.answer });
          await $.store.set('last', e.answer);
          return { text: 'turn ' + ++turns + ': ' + e.answer + ' / '
            + (r.isAnswered ? r.text : r.reason) + ' / ' + (await $.store.get('last')) };
        });
      }`,
    );

    let onFirstChunk!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      onFirstChunk = resolve;
    });
    let releaseStream!: () => void;
    const heldStream = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let answered = 0;
    const goalSteer = 'Check the fixture during the active Goal';
    let testingGoal = false;
    let automaticGoalStarted = false;
    let goalToolAttempts = 0;
    server = await startFakeOpenAIServer(async ({ body }) => {
      const messages = (body['messages'] ?? []) as Message[];
      const last = text(
        messages.filter((m) => m.role === 'user').at(-1)?.content,
      );
      if (last === 'Wait for first chunk') {
        await firstChunk;
        return { content: 'Chunk received.' };
      }
      if (last.startsWith('Summarize: ')) return { content: 'SUMMARY' };
      if (testingGoal && body['stream'] === true) {
        if (
          !messages.some((message) => text(message.content).includes(goalSteer))
        ) {
          automaticGoalStarted = true;
          await heldStream;
          return { content: 'Automatic Goal response.' };
        }
        if (++goalToolAttempts > 3)
          return { content: 'Unexpected extra round.' };
        return {
          toolCalls: [
            fakeToolCall('read_file', {}, `goal_read_${goalToolAttempts}`),
          ],
        };
      }
      if (body['stream'] === true && last.includes('Abort after first chunk'))
        return {
          contentChunks: ['Abort marker.', 'This chunk should not arrive.'],
          holdAfterChunks: 1,
          holdUntil: heldStream,
        };
      if (body['stream'] === true && last.includes('Seed token count'))
        return {
          content: 'Token count recorded.',
          usage: {
            prompt_tokens: 15_000,
            completion_tokens: 2,
            total_tokens: 15_002,
          },
        };
      // The second prompt reads a file first: its turn has two responses,
      // and the answer is the last one's.
      if (
        body['stream'] === true &&
        last.includes('Hello two') &&
        messages.at(-1)?.role !== 'tool'
      )
        return {
          toolCalls: [
            fakeToolCall(
              'read_file',
              { file_path: join(workspace, 'notes.txt') },
              'call_read',
            ),
          ],
        };
      return body['stream'] === true
        ? { content: `Answer ${++answered}` }
        : { content: '{}' };
    });
    const env = {
      PATH: process.env['PATH'],
      HOME: home,
      USERPROFILE: home,
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: join(scratch, 'runtime'),
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
      QWEN_SANDBOX: 'false',
      QWEN_CODE_DISABLE_CRON: '1',
      QWEN_CODE_DISABLE_UPDATE_CHECK: '1',
      QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP: shared ? '1' : '0',
      OPENAI_API_KEY: 'fixture',
      OPENAI_BASE_URL: server.baseUrl,
      OPENAI_MODEL: 'fixture',
      QWEN_MODEL: 'fixture',
    };
    await run(
      process.execPath,
      [bundle, 'extensions', 'install', plugin, '--consent'],
      { cwd: workspace, env, timeout: 120_000 },
    );

    const child = spawn(process.execPath, [bundle, '--acp'], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const logs: Array<{ sessionId: string; plugin: string; text: string }> = [];
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate: async ({ update }) => {
          if (
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text' &&
            update.content.text === 'Abort marker.'
          )
            onFirstChunk();
        },
        requestPermission: async () => ({
          outcome: { outcome: 'cancelled' },
        }),
        extNotification: async (method, params) => {
          if (method === 'qwen/notify/session/mod-log')
            logs.push(params as (typeof logs)[number]);
        },
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      ),
    );
    // The turn's note: its answer, the model call's and the stored one.
    const note = (turn: number) =>
      expect.stringMatching(
        new RegExp(`^acp-probe: turn ${turn}: (Answer \\d+) / SUMMARY / \\1$`),
      );
    const of = (sessionId: string) =>
      logs
        .filter((log) => log.sessionId === sessionId)
        .map((log) => `${log.plugin}: ${log.text}`);
    try {
      await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const first = await client.newSession({ cwd: workspace, mcpServers: [] });
      const second = await client.newSession({
        cwd: workspace,
        mcpServers: [],
      });
      for (const [sessionId, prompt] of [
        [first.sessionId, 'Hello one'],
        [first.sessionId, 'Hello two'],
        [second.sessionId, 'Hello three'],
      ]) {
        const response = await client.prompt({
          sessionId,
          prompt: [{ type: 'text', text: prompt }],
        });
        expect(response.stopReason, stderr).toBe('end_turn');
      }
      // `/clear` ends the first session's Mods session without a new start.
      await client.prompt({
        sessionId: first.sessionId,
        prompt: [{ type: 'text', text: '/clear' }],
      });
      await vi.waitFor(
        () => {
          expect(of(first.sessionId)).toEqual([
            'acp-probe: Hooks for unsupported events will not run: tool.call',
            'acp-probe: start null false []',
            'acp-probe: turn.start Hello one',
            note(1),
            'acp-probe: turn.start Hello two',
            note(2),
            'acp-probe: end clear',
          ]);
          // The second session's worker counts its own turns.
          expect(of(second.sessionId)).toEqual([
            'acp-probe: Hooks for unsupported events will not run: tool.call',
            'acp-probe: start null false []',
            'acp-probe: turn.start Hello three',
            note(1),
          ]);
        },
        { timeout: 30_000, interval: 200 },
      );

      const aborted = await client.newSession({
        cwd: workspace,
        mcpServers: [],
      });
      const response = await client.prompt({
        sessionId: aborted.sessionId,
        prompt: [{ type: 'text', text: 'Abort after first chunk' }],
      });
      expect(response.stopReason, stderr).toBe('cancelled');
      await vi.waitFor(
        () =>
          expect(of(aborted.sessionId)).toContain('acp-probe: ended aborted'),
        { timeout: 5_000 },
      );

      const limited = await client.newSession({
        cwd: workspace,
        mcpServers: [],
      });
      const firstPrompt = await client.prompt({
        sessionId: limited.sessionId,
        prompt: [{ type: 'text', text: 'Seed token count' }],
      });
      expect(firstPrompt.stopReason, stderr).toBe('end_turn');
      const limitedPrompt = await client.prompt({
        sessionId: limited.sessionId,
        prompt: [{ type: 'text', text: 'Exceed token limit' }],
      });
      expect(limitedPrompt.stopReason, stderr).toBe('max_tokens');
      await vi.waitFor(
        () => expect(of(limited.sessionId)).toContain('acp-probe: ended error'),
        { timeout: 5_000 },
      );

      const goal = await client.newSession({ cwd: workspace, mcpServers: [] });
      const goalPrompt = (text: string) =>
        client.prompt({
          sessionId: goal.sessionId,
          prompt: [{ type: 'text', text }],
        });
      testingGoal = true;
      expect(
        (await goalPrompt('/goal set Review the fixture')).stopReason,
      ).toBe('end_turn');
      await vi.waitFor(() => expect(automaticGoalStarted).toBe(true), {
        timeout: 5_000,
      });
      expect((await goalPrompt(goalSteer)).stopReason, stderr).toBe('end_turn');
      await vi.waitFor(
        () => expect(of(goal.sessionId)).toContain('acp-probe: ended error'),
        { timeout: 5_000 },
      );
      expect(goalToolAttempts).toBe(3);
    } finally {
      onFirstChunk();
      releaseStream();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((done) => {
          const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
          child.once('close', () => {
            clearTimeout(timeout);
            done();
          });
          child.stdin.end();
          child.kill('SIGTERM');
        });
      }
    }
  }, 180_000);
});
