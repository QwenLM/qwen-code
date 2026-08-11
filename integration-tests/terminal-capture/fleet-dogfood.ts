#!/usr/bin/env npx tsx
/**
 * End-to-end Fleet dogfood run.
 *
 * Everything about Fleet is real here: the leader is the bundled CLI in a real
 * PTY, the supervisor and every teammate are real OS processes spawned through
 * the production `defaultSpawnWorker` path, and they talk over the real unix
 * socket. Only the *model backend* is stubbed, so the run needs no API key and
 * stays deterministic — the point is to exercise the Fleet transport, not the
 * model.
 *
 * It drives the full loop and leaves the evidence on disk:
 *   1. leader creates a team and spawns N read-only teammates;
 *   2. each teammate starts as its own OS process and handshakes;
 *   3. each reads a file and reports to the leader via `send_message`;
 *   4. the operator answers the cross-process approval the teammate raised;
 *   5. the leader sends a targeted follow-up back down the mailbox;
 *   6. the leader exits and every teammate process is gone.
 *
 * Usage:
 *   npm run bundle
 *   npx tsx integration-tests/terminal-capture/fleet-dogfood.ts [teammates]
 *
 * Env:
 *   QWEN_FLEET_DOGFOOD_OUT   output directory (default: a mkdtemp dir)
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from '@lydell/node-pty';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIResponse,
} from '../fake-openai-server.js';

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CLI = join(REPO, 'dist/cli.js');
const OUT =
  process.env['QWEN_FLEET_DOGFOOD_OUT'] ??
  mkdtempSync(join(tmpdir(), 'qwen-fleet-dogfood-'));

const TEAMMATE_COUNT = Math.min(Number(process.argv[2] ?? '1') || 1, 3);
const COLS = 160;
const ROWS = 50;

const TEAMMATE_MARKER = 'FLEET_DOGFOOD_TEAMMATE_TASK';
const TARGET_FILE = 'fleet-target.txt';
const TARGET_CONTENT = 'FLEET_TARGET_CONTENT_OK';

const names = ['scout', 'ranger', 'probe'].slice(0, TEAMMATE_COUNT);

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\[[0-9;?]*[a-zA-Z]/g, '');
}

async function main() {
  if (!existsSync(CLI)) {
    throw new Error(`Bundled CLI not found at ${CLI}. Run "npm run bundle".`);
  }

  // A supervisor outlives its leader by design (10 min idle grace). If a
  // previous run's store was deleted underneath it, the survivor still owns the
  // socket and this run would die with "socket is already in use".
  sh('pkill', ['-f', 'internal-fleet-teammate']);
  sh('pkill', ['-f', 'internal-agent-view-supervisor']);
  await sleep(1500);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const projectDir = join(OUT, 'project');
  const qwenHome = join(OUT, 'qwen-home');
  mkdirSync(join(projectDir, '.qwen'), { recursive: true });
  mkdirSync(qwenHome, { recursive: true });
  writeFileSync(join(projectDir, TARGET_FILE), `${TARGET_CONTENT}\n`);
  writeFileSync(
    join(projectDir, '.qwen', 'settings.json'),
    JSON.stringify(
      {
        experimental: { fleet: true },
        privacy: { usageStatisticsEnabled: false },
      },
      null,
      2,
    ),
  );

  let leaderTurn = 0;
  const teammateTurns = new Map<string, number>();

  const server = await startFakeOpenAIServer(({ body }) => {
    const messages = (body['messages'] ?? []) as Array<{
      role: string;
      content?: unknown;
    }>;
    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

    // Non-streaming calls are auxiliary (memory extraction, classifiers).
    if (body['stream'] !== true) return { content: '{"selected_memories":[]}' };

    // With an explicit subagent_type the task prompt becomes the teammate's
    // first *user* message, not its system prompt. The leader also carries the
    // marker, but only inside an assistant tool_call — so match user turns.
    const userText = messages
      .filter((m) => m.role === 'user')
      .map((m) => JSON.stringify(m.content ?? ''))
      .join('\n');

    if (userText.includes(TEAMMATE_MARKER)) {
      const who =
        names.find((n) => systemText.includes(`"${n}"`)) ??
        names.find((n) => userText.includes(n)) ??
        'unknown';
      const turn = teammateTurns.get(who) ?? 0;
      teammateTurns.set(who, turn + 1);
      if (turn === 0) {
        return {
          toolCalls: [
            fakeToolCall(
              'read_file',
              { file_path: join(projectDir, TARGET_FILE) },
              `read-${who}`,
            ),
          ],
        };
      }
      if (turn === 1) {
        return {
          toolCalls: [
            fakeToolCall(
              'send_message',
              {
                to: 'leader',
                message: `TEAMMATE_REPORT[${who}]: ${TARGET_CONTENT}`,
              },
              `msg-${who}`,
            ),
          ],
        };
      }
      if (turn === 2) return { content: `TEAMMATE_DONE[${who}]` };
      // Reached only if the leader's follow-up arrived through the mailbox.
      return { content: `TEAMMATE_FOLLOWUP_ACK[${who}]` };
    }

    const turn = leaderTurn++;
    if (turn === 0) {
      return {
        toolCalls: [
          fakeToolCall('team_create', { team_name: 'dogfood' }, 'team-create'),
        ],
      };
    }
    if (turn >= 1 && turn <= names.length) {
      const who = names[turn - 1]!;
      return {
        toolCalls: [
          fakeToolCall(
            'agent',
            {
              name: who,
              description: `inspect ${TARGET_FILE}`,
              subagent_type: 'general-purpose',
              read_only: true,
              prompt: `${TEAMMATE_MARKER}: read ${TARGET_FILE} in the project root, then send_message to "leader" with its exact contents.`,
            },
            `spawn-${who}`,
          ),
        ],
      };
    }
    if (turn === names.length + 1) {
      return {
        content: `LEADER_SPAWNED_ALL (${names.join(', ')}). Waiting for reports.`,
      } satisfies FakeOpenAIResponse;
    }
    // The leader is re-prompted when a teammate reports; use that turn to send
    // a targeted follow-up back down the mailbox to exactly one teammate.
    if (turn === names.length + 2) {
      return {
        toolCalls: [
          fakeToolCall(
            'send_message',
            {
              to: names[0]!,
              message: `LEADER_FOLLOWUP: acknowledge receipt, ${names[0]!}.`,
            },
            'leader-followup',
          ),
        ],
      };
    }
    return { content: 'LEADER_DONE.' } satisfies FakeOpenAIResponse;
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: qwenHome,
    QWEN_HOME: qwenHome,
    QWEN_RUNTIME_DIR: qwenHome,
    OPENAI_API_KEY: 'fake-key',
    OPENAI_BASE_URL: server.baseUrl,
    OPENAI_MODEL: 'fake-model',
    QWEN_MODEL: 'fake-model',
    QWEN_SANDBOX: 'false',
    QWEN_CODE_NO_RELAUNCH: '1',
    QWEN_FLEET_DEBUG: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    TERM: 'xterm-256color',
  };
  delete env['NO_COLOR'];
  delete env['QWEN_CODE_SIMPLE'];

  let raw = '';
  const child = pty.spawn(
    process.execPath,
    [
      CLI,
      '--no-chat-recording',
      '--yolo',
      '--auth-type',
      'openai',
      '--model',
      'fake-model',
      '--openai-base-url',
      server.baseUrl,
      '--openai-api-key',
      'fake-key',
    ],
    { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: projectDir, env },
  );
  child.onData((d) => {
    raw += d;
  });

  const pidSamples: string[] = [];
  let sawTeammateProcess = false;
  const sampler = setInterval(() => {
    const workers = sh('pgrep', ['-af', 'internal-fleet-teammate']).trim();
    const sup = sh('pgrep', ['-af', 'internal-agent-view-supervisor']).trim();
    if (!workers && !sup) return;
    if (workers) sawTeammateProcess = true;
    pidSamples.push(
      `supervisor:\n${sup || '  (none)'}\nteammates:\n${workers || '  (none)'}`,
    );
  }, 500);

  await sleep(9000); // let the TUI come up before typing
  child.write('Start the dogfood run.\r');

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (raw.includes('LEADER_SPAWNED_ALL') && sawTeammateProcess) break;
    await sleep(500);
  }

  // Answer the cross-process approval the teammate raised: ↓ focuses the tab
  // bar, → moves to the first teammate, Enter takes "Yes, allow once".
  await sleep(12_000);
  writeFileSync(join(OUT, 'tui.before-approval.txt'), stripAnsi(raw));
  child.write('\x1b[B');
  await sleep(1200);
  child.write('\x1b[C');
  await sleep(1800);
  child.write('\r');
  await sleep(15_000);

  // Steady-state CPU: `ps -o pcpu` averages over the whole process lifetime,
  // which startup dominates. Sample jiffies twice while everything is idle to
  // isolate what the worker poll loop actually costs.
  const cpuOf = (pid: string): number => {
    try {
      const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
      return Number(f[13]) + Number(f[14]);
    } catch {
      return NaN;
    }
  };
  const idlePids = [
    ...sh('pgrep', ['-f', 'internal-fleet-teammate']).trim().split('\n'),
    ...sh('pgrep', ['-f', 'internal-agent-view-supervisor']).trim().split('\n'),
  ].filter(Boolean);
  const before = new Map(idlePids.map((p) => [p, cpuOf(p)]));
  const windowMs = 10_000;
  await sleep(windowMs);
  const cpuReport = idlePids
    .map((p) => {
      const pct =
        ((cpuOf(p) - (before.get(p) ?? NaN)) / 100 / (windowMs / 1000)) * 100;
      const role = sh('ps', ['-o', 'args=', '-p', p]).includes('supervisor')
        ? 'supervisor'
        : 'teammate';
      return `pid=${p} role=${role} idleCpu=${pct.toFixed(1)}%`;
    })
    .join('\n');
  writeFileSync(
    join(OUT, 'idle-cpu.txt'),
    `Steady-state CPU over ${windowMs / 1000}s, all sessions idle:\n${cpuReport}\n`,
  );

  clearInterval(sampler);
  writeFileSync(join(OUT, 'tui.raw.ansi'), raw);
  writeFileSync(join(OUT, 'tui.stripped.txt'), stripAnsi(raw));
  writeFileSync(join(OUT, 'pid-samples.txt'), pidSamples.join('\n\n'));

  try {
    child.kill();
  } catch {
    /* already gone */
  }
  await sleep(2500);

  const collected: string[] = [];
  const push = (label: string, p: string) =>
    collected.push(
      `===== ${label} (${p}) =====\n${existsSync(p) ? readFileSync(p, 'utf8') : '(missing)'}`,
    );
  push('fleet-debug.log', join(qwenHome, 'daemon', 'fleet-debug.log'));
  push('supervisor.log', join(qwenHome, 'daemon', 'supervisor.log'));
  const jobsDir = join(qwenHome, 'jobs');
  if (existsSync(jobsDir)) {
    for (const id of readdirSync(jobsDir)) {
      push(`worker.log[${id}]`, join(jobsDir, id, 'worker.log'));
      push(`state.json[${id}]`, join(jobsDir, id, 'state.json'));
    }
  }
  writeFileSync(join(OUT, 'fleet-logs.txt'), collected.join('\n\n'));

  const leftover = sh('pgrep', ['-af', 'internal-fleet-teammate']).trim();
  writeFileSync(
    join(OUT, 'after-exit-processes.txt'),
    leftover || '(no teammate processes remain)',
  );

  await server.close();

  const results = {
    teammatesRanAsSeparateProcesses: sawTeammateProcess,
    leaderSpawnedAll: raw.includes('LEADER_SPAWNED_ALL'),
    teammateReportedToLeader: raw.includes('TEAMMATE_REPORT'),
    approvalAnsweredCrossProcess: raw.includes('Message sent to "leader"'),
    leaderFollowUpDelivered: raw.includes('TEAMMATE_FOLLOWUP_ACK'),
    allTeammatesStoppedOnLeaderExit: leftover === '',
  };
  console.log(JSON.stringify(results, null, 2));
  console.log(`evidence: ${OUT}`);
  if (Object.values(results).some((v) => !v)) {
    console.error('FLEET DOGFOOD: at least one step did not complete');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
