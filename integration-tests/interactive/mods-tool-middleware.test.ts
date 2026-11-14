/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { promisify } from 'node:util';
import { execFile, execFileSync, spawn } from 'node:child_process';
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
import { setTimeout as delay } from 'node:timers/promises';
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
async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeout = 30000,
): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error(`Timeout (${timeout}ms) waiting for ${description}`);
}
type OracleEntry = {
  nonce: string;
  phase: string;
  pid: number;
  state?: 'started' | 'completed';
  monotonicMs?: number;
  durationMs?: number;
};
function ledger(workspace: string): OracleEntry[] {
  const file = join(workspace, 'oracle.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as OracleEntry)
    : [];
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
type StreamMessage = {
  type: string;
  subtype?: string;
  data?: { text?: string };
  message?: {
    content?: Array<{
      type: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
};
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
  | 'long-approval'
  | 'approval-cancel'
  | 'long-native'
  | 'native-timeout'
  | 'cancel'
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
  'long-approval',
  'approval-cancel',
  'long-native',
  'native-timeout',
  'cancel',
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
            'long-native',
            'native-timeout',
            'cancel',
          ] as Mode[]
        ).map((mode) => ({ mode, headless: true }))
      : []),
  ])(
    '$mode (headless=$headless) preserves native facts and one final result',
    async ({ mode, headless }) => {
      const delayedNative = [
        'long-native',
        'native-timeout',
        'cancel',
      ].includes(mode);
      const cancelled = mode === 'cancel' || mode === 'approval-cancel';
      const approval = ['ask', 'long-approval', 'approval-cancel'].includes(
        mode,
      );
      const streaming = headless && delayedNative;
      const bundleHashBefore = digest(readFileSync(bundle));
      const worker = join(repo, 'dist/mod-worker.js');
      const workerHashBefore = digest(readFileSync(worker));
      const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
      const scratch = mkdtempSync(
        join(
          tmpdir(),
          `mods-${renderer}-${headless ? 'headless-' : ''}${mode}-`,
        ),
      );
      const workspace = join(scratch, 'workspace'),
        qwenHome = join(scratch, 'home'),
        runtime = join(scratch, 'runtime');
      const evidence = join(
        repo,
        '.qwen/e2e-tests/mods-p02b/author',
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
          [approval ? 'ask' : mode === 'native-deny' ? 'deny' : 'allow']: [
            'Bash(node oracle.mjs *)',
          ],
        },
      };
      json(join(qwenHome, 'settings.json'), settings);
      json(join(qwenHome, 'trustedFolders.json'), {
        [workspace]: 'TRUST_FOLDER',
      });
      const oracle = `import {appendFileSync, existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const [nonce,phase,kind]=process.argv.slice(2);
const started=performance.now();
const record=(extra={})=>appendFileSync('oracle.jsonl',JSON.stringify({nonce,phase,pid:process.pid,...extra})+'\\n');
if(kind==='long') {
  record({state:'started',monotonicMs:started});
  while(performance.now()-started<66000 || !existsSync('release-'+nonce)) {
    if(performance.now()-started>110000) throw Error('fixture release not received');
    await delay(50);
  }
  record({state:'completed',monotonicMs:performance.now(),durationMs:performance.now()-started});
} else record();
console.log('ORACLE:'+nonce+':'+phase);`;
      writeFileSync(join(workspace, 'oracle.mjs'), oracle);
      const originalArgs = {
        command: `node oracle.mjs ${nonce} A${delayedNative ? ' long' : ''}`,
        ...(delayedNative && {
          is_background: false,
          timeout: mode === 'native-timeout' ? 5000 : 120000,
        }),
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
        'long-approval': `on('tool.call', {tool:'run_shell_command'}, ($,e,next)=>next(e));`,
        'approval-cancel': `on('tool.call', {tool:'run_shell_command'}, ($,e,next)=>next(e));`,
        'long-native': `on('tool.call', {tool:'run_shell_command'}, async ($,e,next)=>{ $.ui.log('ENTER:${nonce}'); const value=await next(e); $.ui.log('SETTLED:${nonce}'); return value; });`,
        'native-timeout': `on('tool.call', {tool:'run_shell_command'}, ($,e,next)=>next(e));`,
        cancel: `on('tool.call', {tool:'run_shell_command'}, async ($,e,next)=>{ $.ui.log('ENTER:${nonce}'); const value=await next(e); $.ui.log('SETTLED:${nonce}'); return value; });`,
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
        QWEN_CODE_TOOL_EXECUTION_TIMEOUT_MS: '0',
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
          if (cancelled && !paired) {
            const result = messages.filter(
              (message) =>
                message.role === 'tool' &&
                ids.includes(message.tool_call_id ?? ''),
            );
            if (
              result.length !== 1 ||
              !JSON.stringify(result[0].content)
                .toLowerCase()
                .includes('cancel')
            )
              problems.push(
                'cancelled turn lacks one paired cancellation result',
              );
            else paired = true;
          }
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
                      : cancelled
                        ? 'cancel'
                        : mode === 'native-timeout'
                          ? 'timed out after 5000ms'
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
      const assertOracle = async () => {
        const entries = ledger(workspace);
        expect(entries.every((entry) => entry.nonce === nonce)).toBe(true);
        expect(
          entries.every(
            (entry) => Number.isInteger(entry.pid) && entry.pid > 0,
          ),
        ).toBe(true);
        if (delayedNative) {
          expect(entries.map((entry) => entry.state)).toEqual(
            mode === 'long-native' ? ['started', 'completed'] : ['started'],
          );
          expect(entries.map((entry) => entry.phase)).toEqual(
            mode === 'long-native' ? ['A', 'A'] : ['A'],
          );
          if (mode === 'long-native') {
            expect(entries[1].pid).toBe(entries[0].pid);
            expect(entries[1].durationMs).toBeGreaterThanOrEqual(66000);
            expect(
              entries[1].monotonicMs! - entries[0].monotonicMs!,
            ).toBeGreaterThanOrEqual(66000);
          }
          await waitUntil(
            () => !pidAlive(entries[0].pid),
            'exact oracle PID exited',
            15000,
          );
        } else {
          expect(entries.map((entry) => entry.phase)).toEqual(
            ['deny', 'synthetic', 'native-deny', 'approval-cancel'].includes(
              mode,
            )
              ? []
              : mode === 'rewrite'
                ? ['B']
                : mode === 'repeat'
                  ? ['A', 'B']
                  : mode === 'batch'
                    ? ['A', 'C']
                    : ['A'],
          );
        }
        json(join(evidence, 'oracle.json'), entries);
      };
      const assertRecords = () => {
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
          if (['synthetic', 'deny', 'approval-cancel'].includes(mode))
            expect(recorded[0].toolCallResult.executionStatus).toBe(
              'not_started',
            );
          if (mode === 'cancel')
            expect(recorded[0].toolCallResult.executionStatus).toBe(
              'cancelled',
            );
          if (mode === 'native-timeout')
            expect(recorded[0].toolCallResult.executionStatus).toBe('error');
          if (
            mode === 'withhold' ||
            mode === 'long-native' ||
            mode === 'long-approval'
          )
            expect(recorded[0].toolCallResult.executionStatus).toBe('success');
        }
      };
      let session: InteractiveSession | undefined;
      let exited: Promise<number> | undefined;
      let failure: unknown;
      try {
        if (headless) {
          const args = [
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
            streaming ? 'stream-json' : 'json',
            '--allowed-tools',
            'run_shell_command',
          ];
          if (streaming) {
            const child = spawn(cli, args, {
              cwd: workspace,
              env,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            const messages: StreamMessage[] = [];
            let stdout = '',
              stderr = '',
              pendingLine = '';
            let stopped:
              | { code: number | null; signal: NodeJS.Signals | null }
              | undefined;
            let spawnError: Error | undefined;
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
              stdout += chunk;
              pendingLine += chunk;
              const lines = pendingLine.split('\n');
              pendingLine = lines.pop()!;
              for (const line of lines.filter(Boolean)) {
                try {
                  messages.push(JSON.parse(line) as StreamMessage);
                } catch {
                  problems.push(`non-JSON stdout: ${line}`);
                }
              }
            });
            child.stderr.on('data', (chunk: string) => {
              stderr += chunk;
            });
            child.on('error', (error) => {
              spawnError = error;
            });
            child.on('close', (code, signal) => {
              stopped = { code, signal };
            });
            const uiLog = (text: string) =>
              messages.some(
                (message) =>
                  message.type === 'system' &&
                  message.subtype === 'ui_log' &&
                  message.data?.text === text,
              );
            const resultBlocks = () =>
              messages
                .flatMap((message) =>
                  message.type === 'user'
                    ? (message.message?.content ?? [])
                    : [],
                )
                .filter(
                  (block) =>
                    block.type === 'tool_result' &&
                    ids.includes(block.tool_use_id ?? ''),
                );
            try {
              await waitUntil(() => {
                if (spawnError || stopped)
                  throw (
                    spawnError ??
                    new Error(
                      `CLI exited before oracle started: ${JSON.stringify(stopped)}\n${stderr}`,
                    )
                  );
                return (
                  ledger(workspace)[0]?.state === 'started' &&
                  (mode === 'native-timeout' || uiLog(`ENTER:${nonce}`))
                );
              }, 'native start and live ENTER marker');
              const observedStart = performance.now();
              if (mode === 'long-native') {
                await waitUntil(
                  () => {
                    if (stopped)
                      throw new Error(
                        `CLI exited during native wait: ${JSON.stringify(stopped)}\n${stderr}`,
                      );
                    return performance.now() - observedStart >= 65000;
                  },
                  '65 seconds of real foreground execution',
                  70000,
                );
                expect(ledger(workspace).map((entry) => entry.state)).toEqual([
                  'started',
                ]);
                expect(uiLog(`SETTLED:${nonce}`)).toBe(false);
                expect(resultBlocks()).toHaveLength(0);
                expect(paired).toBe(false);
                json(join(evidence, 'native-wait.json'), {
                  elapsedMs: performance.now() - observedStart,
                  entered: uiLog(`ENTER:${nonce}`),
                  settled: uiLog(`SETTLED:${nonce}`),
                  paired,
                  ledger: ledger(workspace),
                });
                writeFileSync(join(workspace, `release-${nonce}`), 'release');
              } else if (mode === 'cancel') {
                child.kill('SIGINT');
              }
              await waitUntil(
                () => Boolean(stopped),
                'headless CLI exit',
                mode === 'long-native' ? 30000 : 20000,
              );
              json(join(evidence, 'headless-exit.json'), {
                ...stopped,
                elapsedSinceStartMs: performance.now() - observedStart,
              });
              expect(stopped?.signal).toBeNull();
              expect(stopped?.code).toBe(mode === 'cancel' ? 130 : 0);
              expect(pendingLine).toBe('');
              expect(resultBlocks()).toHaveLength(1);
              if (mode === 'cancel') {
                expect(resultBlocks()[0].is_error).toBe(true);
                expect(
                  JSON.stringify(resultBlocks()[0]).toLowerCase(),
                ).toContain('cancel');
                expect(paired).toBe(false);
                expect(server.requests).toHaveLength(1);
              } else {
                expect(stdout).toContain(`DONE:${nonce}`);
                expect(paired).toBe(true);
                expect(server.requests).toHaveLength(2);
                if (mode === 'long-native')
                  expect(uiLog(`SETTLED:${nonce}`)).toBe(true);
                else
                  expect(performance.now() - observedStart).toBeLessThan(20000);
              }
              expect(problems).toEqual([]);
              await assertOracle();
            } finally {
              writeFileSync(join(evidence, 'stdout.jsonl'), stdout);
              writeFileSync(join(evidence, 'stderr.txt'), stderr);
              if (!stopped) {
                child.kill('SIGTERM');
                await waitUntil(
                  () => Boolean(stopped),
                  'fixture child cleanup',
                  15000,
                );
              }
            }
          } else {
            const output = await promisify(execFile)(cli, args, {
              cwd: workspace,
              env,
              timeout: 45000,
              maxBuffer: 8 * 1024 * 1024,
            });
            writeFileSync(join(evidence, 'stdout.json'), output.stdout);
            writeFileSync(join(evidence, 'stderr.txt'), output.stderr);
            expect(Array.isArray(JSON.parse(output.stdout))).toBe(true);
            expect(output.stdout).toContain(`DONE:${nonce}`);
            expect(problems).toEqual([]);
            expect(paired).toBe(true);
            expect(server.requests).toHaveLength(2);
            await assertOracle();
          }
          assertRecords();
        } else {
          session = await InteractiveSession.start({
            cols: 160,
            rows: 50,
            cwd: workspace,
            env,
            inheritEnv: false,
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
          if (approval) {
            const isApproval = (screen: string) =>
              screen.includes(nonce) &&
              /allow once|allow execution|allow.*once/i.test(screen);
            await session.waitForScreen(
              isApproval,
              'native approval for current nonce',
              30000,
            );
            expect(ledger(workspace)).toEqual([]);
            writeFileSync(
              join(evidence, 'approval.txt'),
              await session.screen(),
            );
            if (mode === 'long-approval') {
              const approvalStarted = performance.now();
              await waitUntil(
                () => performance.now() - approvalStarted >= 65000,
                '65 seconds of real approval waiting',
                70000,
              );
              const screen = await session.screen();
              expect(isApproval(screen)).toBe(true);
              expect(ledger(workspace)).toEqual([]);
              expect(paired).toBe(false);
              json(join(evidence, 'approval-wait.json'), {
                elapsedMs: performance.now() - approvalStarted,
                paired,
                ledger: ledger(workspace),
              });
              writeFileSync(join(evidence, 'approval-after-65s.txt'), screen);
            }
            if (mode === 'approval-cancel') {
              session.pressKey('\u001b');
              await session.idle(700, 10000);
              session.pressKey('\r');
              await session.idle(700, 10000);
              expect(ledger(workspace)).toEqual([]);
            } else session.pressKey('\r');
          }
          let nativeStarted: number | undefined;
          if (delayedNative) {
            await waitUntil(
              () => ledger(workspace)[0]?.state === 'started',
              'oracle started',
            );
            nativeStarted = performance.now();
            if (mode === 'long-native' || mode === 'cancel')
              await session.waitFor(`ENTER:${nonce}`, 10000);
            if (mode === 'long-native') {
              await waitUntil(
                () => performance.now() - nativeStarted! >= 65000,
                '65 seconds of real foreground execution',
                70000,
              );
              const screen = await session.screen();
              expect(ledger(workspace).map((entry) => entry.state)).toEqual([
                'started',
              ]);
              expect(screen).not.toContain(`SETTLED:${nonce}`);
              expect(paired).toBe(false);
              json(join(evidence, 'native-wait.json'), {
                elapsedMs: performance.now() - nativeStarted,
                entered: true,
                settled: screen.includes(`SETTLED:${nonce}`),
                paired,
                ledger: ledger(workspace),
              });
              writeFileSync(join(evidence, 'native-after-65s.txt'), screen);
              writeFileSync(join(workspace, `release-${nonce}`), 'release');
            } else if (mode === 'cancel') {
              session.pressKey('\u001b');
              await waitUntil(
                () => !pidAlive(ledger(workspace)[0].pid),
                'cancelled oracle PID exited',
                15000,
              );
              json(join(evidence, 'cancel.json'), {
                elapsedMs: performance.now() - nativeStarted,
                pid: ledger(workspace)[0].pid,
                alive: false,
              });
            }
          }
          if (!cancelled)
            await session.waitForScreen(
              (screen) => screen.includes(`DONE:${nonce}`),
              'one paired logical result',
              mode === 'long-native' ? 30000 : 35000,
            );
          if (mode === 'long-native')
            expect(await session.screen()).toContain(`SETTLED:${nonce}`);
          if (mode === 'native-timeout') {
            expect(performance.now() - nativeStarted!).toBeLessThan(20000);
            json(join(evidence, 'native-timeout.json'), {
              elapsedMs: performance.now() - nativeStarted!,
              timeoutMs: 5000,
            });
          }
          await session.idle(700, 10000);
          await assertOracle();
          const pairedBeforeNext = paired;
          await session.send(`NEXT:${nonce}`);
          await session.waitForScreen(
            (screen) => screen.includes(`NEXT-OK:${nonce}`),
            'next ordinary turn works',
            30000,
          );
          expect(nextSeen).toBe(true);
          expect(problems).toEqual([]);
          expect(paired).toBe(true);
          expect(server.requests).toHaveLength(
            cancelled && !pairedBeforeNext ? 2 : 3,
          );
          if (cancelled) await assertOracle();
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
                      reject(
                        new Error('CLI did not drain and exit after /quit'),
                      ),
                    15000,
                  );
                }),
              ]),
            ).toBe(0);
          } finally {
            clearTimeout(exitTimer);
          }
          assertRecords();
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
          const livePids = [
            ...new Set(
              ledger(workspace)
                .filter(
                  (entry) => entry.nonce === nonce && entry.state === 'started',
                )
                .map((entry) => entry.pid),
            ),
          ].filter(pidAlive);
          if (livePids.length) {
            failure ??= new Error(
              `Oracle processes survived: ${livePids.join(',')}`,
            );
            for (const pid of livePids) process.kill(pid, 'SIGKILL');
          }
          json(join(evidence, 'cleanup.json'), { forcedOraclePids: livePids });
          if (
            bundleHashBefore !== digest(readFileSync(bundle)) ||
            workerHashBefore !== digest(readFileSync(worker))
          )
            failure ??= new Error('Built artifacts changed during this case');
          json(join(evidence, 'requests.json'), server.requests);
          await server.close();
          json(join(evidence, 'manifest.json'), {
            mode,
            nonce,
            renderer,
            strict: renderer === 'opentui',
            scratch,
            bundleHashBefore,
            bundleHashAfter: digest(readFileSync(bundle)),
            workerHashBefore,
            workerHashAfter: digest(readFileSync(worker)),
            fixtureHash: digest(readFileSync(fileURLToPath(import.meta.url))),
            modHash: digest(source),
            runtimeVersion: execFileSync(cli, ['--version'], {
              encoding: 'utf8',
            }).trim(),
            headless,
            outputFormat: headless
              ? streaming
                ? 'stream-json'
                : 'json'
              : 'terminal',
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
