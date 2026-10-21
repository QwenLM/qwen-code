/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InteractiveSession } from './interactive-session.js';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const renderer = pickE2eRenderer();
const cli = resolveE2eCliCommand(renderer);
const bundle = join(repo, 'dist/cli.js');
const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(root, entry.name))
      : [join(root, entry.name)],
  );
}
type Message = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { arguments: string } }>;
};
type Mode =
  | 'rewrite'
  | 'deny'
  | 'synthetic'
  | 'repeat'
  | 'replay'
  | 'withhold'
  | 'ask'
  | 'native-deny'
  | 'timeout'
  | 'batch'
  | 'disabled'
  | 'command-only';
const modes: Mode[] = [
  'rewrite',
  'deny',
  'synthetic',
  'repeat',
  'replay',
  'withhold',
  'ask',
  'native-deny',
  'timeout',
  'batch',
  'disabled',
  'command-only',
];

describe.sequential(`Mods model tools (${renderer})`, () => {
  it.each([
    ...modes.map((mode) => ({ mode, headless: false })),
    ...(renderer === 'ink'
      ? (
          [
            'rewrite',
            'deny',
            'synthetic',
            'repeat',
            'replay',
            'native-deny',
          ] as Mode[]
        ).map((mode) => ({ mode, headless: true }))
      : []),
  ])(
    '$mode (headless=$headless) preserves native facts and one final result',
    async ({ mode, headless }) => {
      const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
      const scratch = mkdtempSync(
        join(
          tmpdir(),
          `p02a-${renderer}-${headless ? 'headless-' : ''}${mode}-`,
        ),
      );
      const workspace = join(scratch, 'workspace'),
        qwenHome = join(scratch, 'home'),
        runtime = join(scratch, 'runtime');
      const evidence = join(
        repo,
        '.qwen/e2e-tests/p02a-terminal-middleware/author',
        `${renderer}-${headless ? 'headless-' : ''}${mode}-${nonce}`,
      );
      for (const directory of [workspace, qwenHome, runtime, evidence])
        mkdirSync(directory, { recursive: true });
      const settings = {
        experimental: { mods: mode !== 'disabled' },
        general: {
          enableAutoUpdate: false,
          batchAutoCollect: false,
          chatRecording: true,
          showSessionRecap: false,
        },
        ui: { enableFollowupSuggestions: false },
        memory: E2E_MEMORY_SETTINGS_DEFAULTS,
        security: {
          folderTrust: { enabled: true },
          auth: { selectedType: 'openai' },
        },
        permissions: {
          [mode === 'ask' || mode === 'timeout'
            ? 'ask'
            : mode === 'native-deny'
              ? 'deny'
              : 'allow']: ['Bash(node oracle.mjs *)'],
        },
      };
      json(join(qwenHome, 'settings.json'), settings);
      json(join(qwenHome, 'trustedFolders.json'), {
        [workspace]: 'TRUST_FOLDER',
      });
      const oracle = `import {appendFileSync} from 'node:fs'; const [nonce,phase]=process.argv.slice(2); appendFileSync('oracle.jsonl',JSON.stringify({nonce,phase,pid:process.pid})+'\\n'); console.log('ORACLE:'+nonce+':'+phase);`;
      writeFileSync(join(workspace, 'oracle.mjs'), oracle);
      const originalArgs = {
        command: `node oracle.mjs ${nonce} A`,
        description: `p02a-tool-${nonce}`,
      };
      const hooks: Record<Mode, string> = {
        rewrite: `on('tool.call', {tool:'run_shell_command'}, ($,e,next)=>next({...e,command:e.command.replace(' A',' B')}));`,
        deny: `on('tool.call', {tool:'run_shell_command'}, ()=>({deny:'DENY:${nonce}'}));`,
        synthetic: `on('tool.call', {tool:'run_shell_command'}, ()=>({result:{output:'SYNTHETIC:${nonce}'}}));`,
        repeat: `on('tool.call', {tool:'run_shell_command'}, async ($,e,next)=>{ const first=await next(e); await next({...e,command:e.command.replace(' A',' B')}); return first; });`,
        replay: `on('tool.call', {tool:'run_shell_command'}, async ($,e,next)=>{ await next(e); throw Error('replay'); }).catch(async ($,e,next)=>{ await next({...e,command:e.command.replace(' A',' NEVER')}); return next(e); });`,
        withhold: `on('tool.call', {tool:'run_shell_command'}, async ($,e,next)=>{ await next(e); return {deny:'WITHHELD:${nonce}'}; });`,
        ask: `on('tool.check', ()=>({decision:'allow'}));`,
        'native-deny': `on('tool.check', ()=>({decision:'allow'}));`,
        timeout: `on('tool.call', {tool:'run_shell_command'}, ($,e,next)=>next(e));`,
        batch: `on('tool.call', {tool:'run_shell_command'}, ($,e,next)=>next(e));`,
        disabled: `on('tool.call', ()=>({result:{output:'UNEXPECTED-SYNTHETIC'}}));`,
        'command-only': `on('session.end', ($,e,next)=>next(e));`,
      };
      const source = `export function register(on) { ${hooks[mode]} }`;
      const plugin = join(scratch, 'plugin');
      mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
      mkdirSync(join(plugin, 'hooks'));
      json(join(plugin, '.claude-plugin/plugin.json'), {
        name: `p02a-${nonce}`,
        version: '1.0.0',
      });
      json(join(plugin, 'hooks/hooks.json'), { modules: ['./register.js'] });
      writeFileSync(join(plugin, 'hooks/register.js'), source);
      const env = {
        PATH: process.env['PATH'],
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        HOME: join(scratch, 'os-home'),
        QWEN_HOME: qwenHome,
        QWEN_RUNTIME_DIR: runtime,
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1',
        QWEN_CODE_DISABLE_CRON: '1',
        QWEN_CODE_DISABLE_UPDATE_CHECK: '1',
        QWEN_SANDBOX: 'false',
      };
      mkdirSync(env.HOME, { recursive: true });
      execFileSync(
        cli,
        [bundle, 'extensions', 'install', plugin, '--consent'],
        { cwd: workspace, env, timeout: 60000, stdio: 'pipe' },
      );
      const ids =
        mode === 'batch'
          ? [`call_${nonce}_1`, `call_${nonce}_2`]
          : [`call_${nonce}`];
      let issued = false,
        paired = false,
        nextSeen = false;
      const problems: string[] = [];
      const server = await startFakeOpenAIServer(({ body }) => {
        const messages = (body.messages ?? []) as Message[];
        const last = JSON.stringify(
          messages.filter((message) => message.role === 'user').at(-1)?.content,
        );
        if (last.includes(`NEXT:${nonce}`)) {
          nextSeen = true;
          return { content: `NEXT-OK:${nonce}` };
        }
        if (!last.includes(`RUN:${nonce}`)) {
          problems.push('unexpected auxiliary request');
          return { content: '{}' };
        }
        const results = ids.map((id) =>
          messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === id,
          ),
        );
        if (results.every(Boolean)) {
          if (!issued || paired) problems.push('duplicate/unissued response');
          paired = true;
          const text = JSON.stringify(results.map((result) => result?.content));
          const expected =
            mode === 'rewrite'
              ? `ORACLE:${nonce}:B`
              : mode === 'deny'
                ? `DENY:${nonce}`
                : mode === 'synthetic'
                  ? `SYNTHETIC:${nonce}`
                  : mode === 'withhold'
                    ? `WITHHELD:${nonce}`
                    : mode === 'native-deny'
                      ? 'permission'
                      : mode === 'timeout'
                        ? 'cancel'
                        : `ORACLE:${nonce}:A`;
          if (!text.toLowerCase().includes(expected.toLowerCase()))
            problems.push(`unexpected result: ${text}`);
          const original = messages
            .flatMap((message) => message.tool_calls ?? [])
            .find((call) => call.id === ids[0]);
          if (original?.function.arguments !== JSON.stringify(originalArgs))
            problems.push('original model arguments changed');
          return { content: `DONE:${nonce}` };
        }
        if (issued) {
          problems.push('reissued tool');
          return { content: 'FAIL' };
        }
        issued = true;
        return {
          toolCalls: ids.map((id, index) =>
            fakeToolCall(
              'run_shell_command',
              index
                ? { ...originalArgs, command: `node oracle.mjs ${nonce} C` }
                : originalArgs,
              id,
            ),
          ),
        };
      });
      let session: InteractiveSession | undefined;
      let exited: Promise<number> | undefined;
      let failure: unknown;
      try {
        if (headless) {
          const output = await promisify(execFile)(
            cli,
            [
              bundle,
              '-p',
              `RUN:${nonce}`,
              '--auth-type',
              'openai',
              '--model',
              'p02a-fixture',
              '--openai-base-url',
              server.baseUrl,
              '--openai-api-key',
              'p02a-fixture',
              '--approval-mode',
              'default',
              '--output-format',
              'json',
              '--allowed-tools',
              'run_shell_command',
            ],
            { cwd: workspace, env, timeout: 45000, maxBuffer: 8 * 1024 * 1024 },
          );
          writeFileSync(join(evidence, 'stdout.json'), output.stdout);
          writeFileSync(join(evidence, 'stderr.txt'), output.stderr);
          expect(output.stdout).toContain(`DONE:${nonce}`);
          expect(problems).toEqual([]);
          expect(paired).toBe(true);
          expect(server.requests).toHaveLength(2);
          const ledger = existsSync(join(workspace, 'oracle.jsonl'))
            ? readFileSync(join(workspace, 'oracle.jsonl'), 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
            : [];
          expect(ledger.map((entry) => entry.phase)).toEqual(
            mode === 'deny' || mode === 'synthetic' || mode === 'native-deny'
              ? []
              : mode === 'repeat'
                ? ['A', 'B']
                : mode === 'rewrite'
                  ? ['B']
                  : ['A'],
          );
          return;
        }
        session = await InteractiveSession.start({
          cols: 160,
          rows: 50,
          cwd: workspace,
          env,
          command: {
            bin: cli,
            args: [
              bundle,
              '--auth-type',
              'openai',
              '--model',
              'p02a-fixture',
              '--openai-base-url',
              server.baseUrl,
              '--openai-api-key',
              'p02a-fixture',
              '--approval-mode',
              'default',
            ],
          },
        });
        exited = new Promise<number>((resolveExit) => {
          (
            session as unknown as {
              ptyProcess: {
                onExit: (
                  listener: (event: { exitCode: number }) => void,
                ) => void;
              };
            }
          ).ptyProcess.onExit(({ exitCode }) => resolveExit(exitCode));
        });
        await session.idle(1000, 20000);
        await session.send(`RUN:${nonce}`);
        if (mode === 'ask' || mode === 'timeout') {
          await session.waitForScreen(
            (screen) =>
              screen.includes(nonce) &&
              /allow once|allow execution|allow.*once/i.test(screen),
            'native approval for current nonce',
            30000,
          );
          expect(existsSync(join(workspace, 'oracle.jsonl'))).toBe(false);
          writeFileSync(join(evidence, 'approval.txt'), await session.screen());
          if (mode === 'timeout') {
            const approvalStarted = Date.now();
            // Real worker wall clock, rather than advancing only a host fake timer.
            await session.waitForScreen(
              (screen) =>
                Date.now() - approvalStarted >= 60000 &&
                /Mod tool dispatch failed|Tool call cancelled|Mod request timed out|cancelled/i.test(
                  screen,
                ),
              '60-second root timeout settles the tool',
              75000,
            );
            json(join(evidence, 'timeout.json'), {
              elapsedMs: Date.now() - approvalStarted,
            });
            expect(Date.now() - approvalStarted).toBeGreaterThanOrEqual(60000);
            await session.idle(500, 10000);
            session.pressKey('\r');
          } else session.pressKey('\r');
        }
        if (mode !== 'timeout')
          await session.waitForScreen(
            (screen) => screen.includes(`DONE:${nonce}`),
            'one paired logical result',
            35000,
          );
        await session.idle(700, 10000);
        const ledger = existsSync(join(workspace, 'oracle.jsonl'))
          ? readFileSync(join(workspace, 'oracle.jsonl'), 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
          : [];
        const phases = ['deny', 'synthetic', 'native-deny', 'timeout'].includes(
          mode,
        )
          ? []
          : mode === 'rewrite'
            ? ['B']
            : mode === 'repeat'
              ? ['A', 'B']
              : mode === 'batch'
                ? ['A', 'C']
                : ['A'];
        expect(ledger.map((entry) => entry.phase)).toEqual(phases);
        expect(ledger.every((entry) => entry.nonce === nonce)).toBe(true);
        await session.send(`NEXT:${nonce}`);
        await session.waitForScreen(
          (screen) => screen.includes(`NEXT-OK:${nonce}`),
          'next ordinary turn works',
          30000,
        );
        expect(nextSeen).toBe(true);
        expect(problems).toEqual([]);
        if (mode !== 'timeout') {
          expect(paired).toBe(true);
          expect(server.requests).toHaveLength(3);
        }
        await session.idle(700, 10000);
        writeFileSync(join(evidence, 'final.txt'), await session.screen());
        await session.send('/quit');
        let exitTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          expect(
            await Promise.race([
              exited,
              new Promise<never>((_resolve, reject) => {
                exitTimer = setTimeout(
                  () =>
                    reject(new Error('CLI did not drain and exit after /quit')),
                  15000,
                );
              }),
            ]),
          ).toBe(0);
        } finally {
          clearTimeout(exitTimer);
        }
        const recordings = files(runtime)
          .filter((file) => file.endsWith('.jsonl'))
          .flatMap((file) =>
            readFileSync(file, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          );
        json(join(evidence, 'records.json'), recordings);
        if (!['disabled', 'command-only'].includes(mode)) {
          const recorded = recordings.filter(
            (record) =>
              record.type === 'tool_result' &&
              ids.includes(record.toolCallResult?.callId),
          );
          expect(recorded).toHaveLength(ids.length);
          if (mode === 'synthetic' || mode === 'deny')
            expect(recorded[0].toolCallResult.executionStatus).toBe(
              'not_started',
            );
          if (mode === 'withhold')
            expect(recorded[0].toolCallResult.executionStatus).toBe('success');
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try {
          if (session) {
            writeFileSync(
              join(evidence, 'pty.ansi'),
              (session as unknown as { rawOutput: string }).rawOutput,
            );
            writeFileSync(join(evidence, 'screen.txt'), await session.screen());
            await session.close();
          }
        } catch (error) {
          failure ??= error;
        } finally {
          json(join(evidence, 'requests.json'), server.requests);
          await server.close();
          json(join(evidence, 'manifest.json'), {
            mode,
            nonce,
            renderer,
            strict: renderer === 'opentui',
            scratch,
            bundleHash: digest(readFileSync(bundle)),
            fixtureHash: digest(source),
            oracleHash: digest(oracle),
            settingsHash: digest(JSON.stringify(settings)),
            head: execFileSync('git', ['rev-parse', 'HEAD'], {
              cwd: repo,
              encoding: 'utf8',
            }).trim(),
            pass: !failure,
            failure: failure ? String(failure) : undefined,
          });
        }
      }
      if (failure) throw failure;
    },
    150000,
  );
});
