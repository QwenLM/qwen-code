/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { quote } from 'shell-quote';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { bundle, Fixture, fixtures, isRunning, repoRoot } from './fixture.js';

let fixture: Fixture;

beforeAll(() => {
  if (process.platform !== 'linux')
    throw new Error(
      'The bwrap integration suite requires Linux; it must not be skipped.',
    );
  if (!existsSync(bundle))
    throw new Error('Build the CLI first: npm run build && npm run bundle');
  execFileSync(
    'bwrap',
    ['--ro-bind', '/', '/', '--unshare-user', '--unshare-net', '--', 'true'],
    { timeout: 5_000 },
  );
});
beforeEach(() => {
  fixture = new Fixture();
});
afterEach(async () => {
  await fixture?.cleanup();
});

const nodeCommand = (script: string, ...args: string[]) => [
  'sandbox',
  '--',
  process.execPath,
  '-e',
  script,
  ...args,
];

async function proxyConfig() {
  const pidFile = fixture.pidFile('proxy');
  const traffic = join(fixture.workspace, 'proxy-traffic.txt');
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, '127.0.0.1', resolve),
  );
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return {
    pidFile,
    traffic,
    env: {
      QWEN_SANDBOX_PROXY_COMMAND: quote([
        process.execPath,
        join(fixtures, 'proxy.mjs'),
        String(port),
        pidFile,
        traffic,
      ]),
      HTTPS_PROXY: `http://127.0.0.1:${port}`,
      NO_PROXY: '',
    },
  };
}

describe('real bwrap CLI confinement', () => {
  it.each(['open', 'closed'])(
    'runs the complete verification battery in %s mode',
    async (mode) => {
      const result = await fixture.run(['sandbox', '--verify'], {
        env: { QWEN_SANDBOX_NET: mode },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('Backend: bwrap');
      expect(result.stdout).toContain('Confinement verified (4 checks).');
      expect(result.stdout).not.toContain('FAIL');
    },
  );

  it('preserves runtime markers and host PID namespace identity', async () => {
    const result = await fixture.run(
      nodeCommand(
        "console.log(JSON.stringify({sandbox:process.env.SANDBOX,enforcement:process.env.SANDBOX_ENFORCEMENT,ns:require('node:fs').readlinkSync('/proc/self/ns/pid')}))",
      ),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sandbox: 'bwrap',
      enforcement: 'full',
      ns: readlinkSync('/proc/self/ns/pid'),
    });
  });

  it('allows workspace writes and denies an otherwise writable outside file', async () => {
    const outside = join(fixture.root, 'outside.txt');
    const inside = join(fixture.workspace, 'inside.txt');
    writeFileSync(outside, 'original');
    const script =
      "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'inside');try{fs.writeFileSync(process.argv[2],'changed');process.exitCode=42}catch(e){console.log(e.code);if(e.code!=='EROFS')process.exitCode=43}";
    const result = await fixture.run(nodeCommand(script, inside, outside));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('EROFS');
    expect(readFileSync(inside, 'utf8')).toBe('inside');
    expect(readFileSync(outside, 'utf8')).toBe('original');
  });

  it('commits from a linked worktree with external common Git metadata', async () => {
    const main = join(fixture.root, 'main-repo');
    const worktree = join(fixture.root, 'linked-worktree');
    mkdirSync(main);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        env: fixture.env,
        encoding: 'utf8',
      }).trim();
    git(main, 'init', '--initial-branch=main');
    git(main, 'config', 'user.name', 'Sandbox Test');
    git(main, 'config', 'user.email', 'sandbox@example.invalid');
    git(main, 'commit', '--allow-empty', '-m', 'initial');
    git(main, 'worktree', 'add', '-b', 'sandbox-test', worktree);
    writeFileSync(join(worktree, 'tracked.txt'), 'sandbox commit');
    const result = await fixture.run(
      [
        'sandbox',
        '--',
        'sh',
        '-c',
        'git add tracked.txt && git -c commit.gpgsign=false commit -m confined',
      ],
      { cwd: worktree },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(git(worktree, 'log', '-1', '--format=%s')).toBe('confined');
    expect(git(worktree, 'show', 'HEAD:tracked.txt')).toBe('sandbox commit');
    expect(
      git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    ).toBe(join(main, '.git'));
  });

  it('fails closed when explicitly selected bwrap is unavailable', async () => {
    const emptyPath = join(fixture.root, 'empty-bin');
    mkdirSync(emptyPath);
    const sentinel = join(fixture.workspace, 'must-not-run');
    const result = await fixture.run(
      nodeCommand(
        "require('node:fs').writeFileSync(process.argv[1],'ran')",
        sentinel,
      ),
      { env: { PATH: emptyPath } },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/bwrap/);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('blocks closed-mode connections to a live host endpoint, while open mode works', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end('host-endpoint');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const script =
      'fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.error(e.cause?.code||e.name);process.exitCode=17})';
    try {
      for (const mode of ['open', 'closed', 'open']) {
        const result = await fixture.run(nodeCommand(script, url), {
          env: { QWEN_SANDBOX_NET: mode },
        });
        expect(result.code, result.stderr).toBe(mode === 'closed' ? 17 : 0);
        if (mode === 'closed') {
          expect(result.stderr).toMatch(
            /ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|TimeoutError/,
          );
          expect(requests).toBe(1);
        } else expect(result.stdout.trim()).toBe('host-endpoint');
      }
      expect(requests).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each(['open', 'proxied'])(
    'runs a real tool round trip through the CLI hop in %s mode',
    async (mode) => {
      const file = join(fixture.workspace, 'model-created.txt');
      const outside = join(fixture.root, 'model-outside.txt');
      writeFileSync(outside, 'original');
      const command = quote([
        process.execPath,
        '-e',
        "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'written by the tool');let denied;try{fs.writeFileSync(process.argv[2],'changed')}catch(e){denied=e.code}console.log(JSON.stringify({sandbox:process.env.SANDBOX,enforcement:process.env.SANDBOX_ENFORCEMENT,denied}))",
        file,
        outside,
      ]);
      let streamRequests = 0;
      const server = await startFakeOpenAIServer(({ body }) => {
        if (body['stream'] !== true)
          return { content: '{"selected_memories":[]}' };
        if (streamRequests++ === 0)
          return {
            toolCalls: [
              fakeToolCall('run_shell_command', { command }, 'sandbox-write'),
            ],
          };
        return { content: 'sandbox-round-trip-complete' };
      });
      const proxy = mode === 'proxied' ? await proxyConfig() : undefined;
      const env = { QWEN_SANDBOX_NET: mode, ...proxy?.env };
      try {
        const result = await fixture.run(
          [
            '--prompt',
            'Write the requested file.',
            '--yolo',
            '--auth-type',
            'openai',
            '--model',
            'fake-model',
            '--openai-api-key',
            'fake-key',
            '--openai-base-url',
            server.baseUrl,
          ],
          { env },
        );
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('sandbox-round-trip-complete');
        expect(readFileSync(file, 'utf8')).toBe('written by the tool');
        expect(readFileSync(outside, 'utf8')).toBe('original');
        expect(streamRequests).toBeGreaterThanOrEqual(2);
        const toolResults = server.requests
          .flatMap(({ body }) =>
            (
              body['messages'] as Array<{
                role: string;
                content: string | Array<{ type: string; text: string }>;
              }>
            )
              .filter((message) => message.role === 'tool')
              .map(({ content }) =>
                typeof content === 'string'
                  ? content
                  : content.map((part) => part.text).join('\n'),
              ),
          )
          .join('\n');
        expect(toolResults).toContain('"sandbox":"bwrap"');
        expect(toolResults).toContain('"enforcement":"full"');
        expect(toolResults).toContain('"denied":"EROFS"');
        if (proxy) {
          expect(readFileSync(proxy.traffic, 'utf8')).toContain(
            new URL(server.baseUrl).host,
          );
          const pid = await fixture.readPid(proxy.pidFile);
          await expect
            .poll(() => isRunning(pid), { timeout: 5_000 })
            .toBe(false);
        }
      } finally {
        await server.close();
      }
    },
  );

  it('fences a live confined session writer and reclaims after its death from the host', async () => {
    const sessionId = randomUUID();
    const transcript = join(fixture.workspace, 'session.jsonl');
    const pidFile = fixture.pidFile('lease');
    const args = [
      join(fixtures, 'lease.mjs'),
      join(repoRoot, 'packages/core/dist/src/services/session-writer-lease.js'),
      sessionId,
      transcript,
    ];
    const owner = fixture.start([
      'sandbox',
      '--',
      process.execPath,
      ...args,
      'hold',
      pidFile,
    ]);
    const pid = await fixture.readPid(pidFile);
    const lockPath = join(
      fixture.env['QWEN_RUNTIME_DIR']!,
      'tmp/session-writer-locks',
      `${sessionId}.lock`,
    );
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(lock.state).toBe('active');
    expect(lock.pid).toBe(pid);
    expect(lock.pid_namespace_id).toBe(statSync('/proc/self/ns/pid').ino);
    expect(readlinkSync(`/proc/${pid}/ns/pid`)).toBe(
      readlinkSync('/proc/self/ns/pid'),
    );
    const contender = await fixture.run([...args, 'contender'], {
      direct: true,
    });
    expect(contender.code, contender.stderr).toBe(23);
    expect(contender.stderr).toContain('session_writer_conflict');
    process.kill(pid, 'SIGKILL');
    const stopped = await owner.done;
    expect(stopped.timedOut).toBe(false);
    await expect
      .poll(() => existsSync(`/proc/${pid}`), { timeout: 5_000 })
      .toBe(false);
    const successor = await fixture.run([...args, 'successor'], {
      direct: true,
    });
    expect(successor.code, successor.stderr).toBe(0);
    expect(JSON.parse(successor.stdout).ownerId).not.toBe(lock.owner_id);
    expect(
      readFileSync(transcript, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([{ writer: 'hold' }, { writer: 'successor' }]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each([
    { signal: 'SIGINT', mode: 'open' },
    { signal: 'SIGTERM', mode: 'open' },
    { signal: 'SIGINT', mode: 'proxied' },
    { signal: 'SIGTERM', mode: 'proxied' },
  ] as const)(
    'forwards $signal in $mode mode and stops payload descendants and proxy',
    async ({ signal, mode }) => {
      const proxy = mode === 'proxied' ? await proxyConfig() : undefined;
      const pidFile = fixture.pidFile('payload');
      const descendantFile = fixture.pidFile('descendant');
      const running = fixture.start(
        nodeCommand(
          "const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',\"require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)\",process.argv[2]],{stdio:'ignore'});fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)",
          pidFile,
          descendantFile,
        ),
        { env: { QWEN_SANDBOX_NET: mode, ...proxy?.env } },
      );
      const pid = await fixture.readPid(pidFile);
      const descendantPid = await fixture.readPid(descendantFile);
      expect(isRunning(pid)).toBe(true);
      expect(isRunning(descendantPid)).toBe(true);
      running.child.kill(signal);
      const result = await running.done;
      expect(result.timedOut, result.stderr).toBe(false);
      expect(result.code, result.stderr).toBe(signal === 'SIGINT' ? 130 : 143);
      await expect.poll(() => isRunning(pid), { timeout: 5_000 }).toBe(false);
      await expect
        .poll(() => isRunning(descendantPid), { timeout: 5_000 })
        .toBe(false);
      if (proxy) {
        const proxyPid = await fixture.readPid(proxy.pidFile);
        await expect
          .poll(() => isRunning(proxyPid), { timeout: 5_000 })
          .toBe(false);
      }
    },
  );
});
