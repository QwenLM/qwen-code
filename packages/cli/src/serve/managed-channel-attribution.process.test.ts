/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real-environment gate for the managed channel attribution: real daemon
// processes booted from source through tsx, real public HTTP routes, real
// spawned `qwen --acp` children, and a real local model-fixture socket. The
// prompt turn's own committed transcript feeds the real export route.
//
// Three observations per cell:
//  - the prompt turn really drives the local model fixture socket (request
//    count), so the session is a live end-to-end round, not a stub;
//  - /proc/<child>/environ proves what the spawned child inherited (exec
//    snapshot — valid for children, which exec after the daemon's stamp/drop);
//    the child's marker-to-channel resolution is pinned by the parseArguments
//    and loadCliConfig unit cases on the same env shapes;
//  - the real export route labels the committed transcript with the channel
//    resolved once at daemon boot from the frozen launch env (hosted profile
//    managed, desktop launcher marker desktop, otherwise daemon), so a
//    co-resident daemon cannot relabel it; the daemon's own in-process
//    stamp/drop is NOT visible in /proc/<daemon>/environ (exec-time snapshot),
//    which is why the export label and the child env carry this observation.
// The generic OpenAI provider used against a loopback fixture sends no
// metadata.channel (DashScope provider only binds official hosts/oauth), so
// the wire channel is not observable here; the hosted in-process channel is
// covered by the verify round's real createRumPayload cell.
//
// The hosted-harness profile gates its public API behind the private managed
// contract (CSI store + protocol headers); its in-process turn channel is
// pinned by the loadCliConfig unit cases and by the verify round's real
// createRumPayload cell, and is disclosed as not covered by this rig.
//
// DEV=true keeps the tsx loader in the frozen child base env (the daemon
// scrubs loader vars otherwise), mirroring scripts/dev.js.

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_ENTRY = fileURLToPath(new URL('../cli.ts', import.meta.url));
const CLI_TSCONFIG = fileURLToPath(
  new URL('../../tsconfig.json', import.meta.url),
);
const TSX_LOADER = pathToFileURL(
  createRequire(import.meta.url).resolve('tsx/esm'),
).href;
const TOKEN = 'rig-token';
const MARKER = 'QWEN_CODE_MANAGED_RUNTIME';
const MODEL = 'qwen-rig';
const ATTRIBUTION_KEYS: readonly string[] = [
  MARKER,
  'QWEN_CODE_DESKTOP',
  'QWEN_CODE_SERVE',
];
// The test process itself runs under a serve session; its session bindings
// and tokens must not leak into the daemons under test.
const SESSION_BINDING_KEYS: readonly string[] = [
  'QWEN_CODE_SESSION_ID',
  'QWEN_CODE_PROMPT_ID',
  'QWEN_CODE_PROJECT_DIR',
  'QWEN_CODE_AGENT_ID',
  'QWEN_CODE_CLI',
  'QWEN_DAEMON_TOKEN',
  'QWEN_SERVER_TOKEN',
  'QWEN_CODE_MESSAGING_TOKEN',
  'QWEN_CODE_MESSAGING_SOCKET',
];

interface Daemon {
  child: ChildProcess;
  pid: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

function readProcEnv(pid: number): Record<string, string> {
  const raw = readFileSync(`/proc/${pid}/environ`);
  const env: Record<string, string> = {};
  for (const entry of raw.toString('utf8').split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

function findAcpChild(daemonPid: number): number | undefined {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid !== daemonPid) continue;
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .split('\0')
        .join(' ');
      if (cmdline.includes('--acp')) return pid;
    } catch {
      // process exited between readdir and read
    }
  }
  return undefined;
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(process.platform !== 'linux')(
  'managed channel attribution (real processes)',
  () => {
    let root: string;
    let workspace: string;
    let qwenHome: string;
    let runtimeDir: string;
    let modelServer: Server;
    let modelRequests: number;
    let daemons: Daemon[];

    beforeEach(async () => {
      root = await realpath(await mkdtemp(path.join(tmpdir(), 'qwen-attr-')));
      workspace = path.join(root, 'workspace');
      qwenHome = path.join(root, 'config');
      runtimeDir = path.join(root, 'runtime');
      await mkdir(workspace);
      await mkdir(qwenHome);
      daemons = [];
      modelRequests = 0;
      modelServer = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          modelRequests += 1;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const [delta, finishReason] of [
            [{ role: 'assistant', content: 'ATTR_REPLY' }, null],
            [{}, 'stop'],
          ] as const) {
            res.write(
              `data: ${JSON.stringify({
                id: 'fixture',
                object: 'chat.completion.chunk',
                created: 0,
                model: MODEL,
                choices: [{ index: 0, delta, finish_reason: finishReason }],
              })}\n\n`,
            );
          }
          res.end('data: [DONE]\n\n');
        });
      });
      await new Promise<void>((resolve) =>
        modelServer.listen(0, '127.0.0.1', resolve),
      );
      const address = modelServer.address();
      if (!address || typeof address === 'string') throw new Error('no addr');
      await writeFile(
        path.join(qwenHome, 'settings.json'),
        JSON.stringify({
          security: { auth: { selectedType: 'openai' } },
          model: { name: MODEL },
          telemetry: { enabled: false },
          privacy: { usageStatisticsEnabled: false },
          modelProviders: {
            openai: [
              {
                id: MODEL,
                envKey: 'OPENAI_API_KEY',
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
              },
            ],
          },
        }),
      );
    }, 60_000);

    afterEach(async () => {
      for (const daemon of daemons) await daemon.stop();
      await new Promise<void>((resolve) => modelServer.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }, 60_000);

    async function bootDaemon(
      ambient: Record<string, string>,
    ): Promise<Daemon> {
      const port = await new Promise<number>((resolve) => {
        const probe = createServer();
        probe.listen(0, '127.0.0.1', () => {
          const a = probe.address();
          if (!a || typeof a === 'string') throw new Error('no addr');
          const p = a.port;
          probe.close(() => resolve(p));
        });
      });
      const sourceEnv: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith('VITEST') &&
            !ATTRIBUTION_KEYS.includes(key) &&
            !SESSION_BINDING_KEYS.includes(key),
        ),
      );
      Object.assign(sourceEnv, {
        HOME: root,
        QWEN_HOME: qwenHome,
        QWEN_RUNTIME_DIR: runtimeDir,
        QWEN_CLI_ENTRY: CLI_ENTRY,
        NODE_OPTIONS: `--import ${TSX_LOADER}`,
        TSX_TSCONFIG_PATH: CLI_TSCONFIG,
        OPENAI_API_KEY: 'fixture-key',
        DEV: 'true',
        ...ambient,
      });
      const child = spawn(
        process.execPath,
        [
          '--import',
          TSX_LOADER,
          CLI_ENTRY,
          'serve',
          '--hostname',
          '127.0.0.1',
          '--port',
          String(port),
          '--token',
          TOKEN,
          '--no-web',
          '--workspace',
          workspace,
          // tsx source children need more than the default initialize budget
          // on a cold compile cache.
          '--initialize-timeout-ms',
          '60000',
        ],
        { env: sourceEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const pid = child.pid;
      if (!pid) throw new Error('daemon spawn failed');
      const stderrChunks: Buffer[] = [];
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      // Drain stdout so a chatty daemon cannot stall on a full pipe buffer.
      child.stdout?.resume();
      child.once('exit', () => {
        // Keep the full boot log outside the per-test tmp root so boot
        // failures stay diagnosable after cleanup.
        try {
          writeFileSync(
            `/tmp/rig-stderr-${pid}.log`,
            Buffer.concat(stderrChunks).toString('utf8'),
          );
        } catch {
          // best effort diagnostics only
        }
        if (child.exitCode !== 0 && child.exitCode !== null) {
          process.stderr.write(
            `[rig daemon ${pid} exit ${child.exitCode}] see /tmp/rig-stderr-${pid}.log\n`,
          );
        }
      });
      const baseUrl = `http://127.0.0.1:${port}`;
      const daemon: Daemon = {
        child,
        pid,
        baseUrl,
        stop: () =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once('exit', () => resolve());
            child.kill('SIGTERM');
            setTimeout(() => {
              child.kill('SIGKILL');
              resolve();
            }, 15_000).unref();
          }),
      };
      daemons.push(daemon);
      await waitFor(async () => {
        try {
          const res = await fetch(`${baseUrl}/health`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          });
          return res.status < 500 ? true : undefined;
        } catch {
          return undefined;
        }
      }, 90_000);
      return daemon;
    }

    async function promptRound(daemon: Daemon): Promise<string> {
      // The first create can race the tsx child's initialize budget (504
      // init_timeout with retry-after); the bridge re-attaches on retry.
      let created: Response | undefined;
      for (let attempt = 0; attempt < 6; attempt++) {
        created = await fetch(`${daemon.baseUrl}/session`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify({ cwd: workspace }),
        });
        // 504 = child initialize budget; 503 = runtime still starting.
        if (created.status !== 504 && created.status !== 503) break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      expect([200, 201]).toContain(created?.status);
      const body = (await created!.json()) as Record<string, unknown>;
      const sessionId = (body['sessionId'] ?? body['id']) as string;
      expect(typeof sessionId).toBe('string');
      const clientId = body['clientId'] as string | undefined;
      const prompt = [{ type: 'text', text: 'hello attribution' }];
      const prompted = await fetch(
        `${daemon.baseUrl}/session/${sessionId}/prompt`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${TOKEN}`,
            ...(clientId ? { 'X-Qwen-Client-Id': clientId } : {}),
          },
          body: JSON.stringify({ prompt }),
        },
      );
      expect(prompted.status).toBe(202);
      // The turn must really drive the model socket end to end.
      await waitFor(async () => (modelRequests > 0 ? true : undefined), 60_000);
      return sessionId;
    }

    async function exportChannel(
      daemon: Daemon,
      sessionId: string,
    ): Promise<string> {
      // The turn commits its transcript asynchronously after the model
      // round; retry until the exporter can load it.
      const res = await waitFor(async () => {
        const r = await fetch(
          `${daemon.baseUrl}/session/${sessionId}/export?format=json`,
          { headers: { authorization: `Bearer ${TOKEN}` } },
        );
        return r.status === 200 ? r : undefined;
      }, 30_000);
      const body = (await res.json()) as {
        metadata?: { channel?: string };
      };
      return body.metadata?.channel as string;
    }

    it('a plain daemon reports daemon in children and exports', async () => {
      const daemon = await bootDaemon({});
      const sessionId = await promptRound(daemon);
      const childPid = await waitFor(
        async () => findAcpChild(daemon.pid),
        30_000,
      );
      const childEnv = readProcEnv(childPid);
      expect(childEnv[MARKER]).toBeUndefined();
      expect(childEnv['QWEN_CODE_SERVE']).toBe('1');
      expect(await exportChannel(daemon, sessionId)).toBe('daemon');
    }, 180_000);

    it('an independent daemon dropped an inherited managed marker everywhere', async () => {
      const daemon = await bootDaemon({ [MARKER]: '1' });
      const sessionId = await promptRound(daemon);
      const childPid = await waitFor(
        async () => findAcpChild(daemon.pid),
        30_000,
      );
      const childEnv = readProcEnv(childPid);
      expect(childEnv[MARKER]).toBeUndefined();
      expect(childEnv['QWEN_CODE_SERVE']).toBe('1');
      expect(await exportChannel(daemon, sessionId)).toBe('daemon');
    }, 180_000);

    it('a desktop-shell daemon keeps desktop in children and exports', async () => {
      const daemon = await bootDaemon({ QWEN_CODE_DESKTOP: '1' });
      const sessionId = await promptRound(daemon);
      const childPid = await waitFor(
        async () => findAcpChild(daemon.pid),
        30_000,
      );
      expect(readProcEnv(childPid)['QWEN_CODE_DESKTOP']).toBe('1');
      expect(await exportChannel(daemon, sessionId)).toBe('desktop');
    }, 180_000);
  },
);
