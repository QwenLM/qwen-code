#!/usr/bin/env node
/**
 * Random operation sequences against the workspace store's invariants.
 *
 * Usage: node scripts/audit/fuzz-workspace-agents.mjs [seed] [steps]
 *
 * The other scripts check scenarios someone thought of. This one does not:
 * it draws operations at random and asserts, after every step, the properties
 * that must hold no matter what order things happened in. The seed is printed
 * and accepted back, so a failure is reproducible rather than a story about a
 * run nobody can repeat.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const src = `${repo}/packages/core/src/agents/workspace-agents`;
const seed = Number(process.argv[2] ?? Math.floor(Math.random() * 1e9));
const steps = Number(process.argv[3] ?? 250);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-fuzz-'));

await fs.writeFile(
  path.join(tmp, 'entry.ts'),
  `export * from '${src}/store.js';
export * from '${src}/thread-actions.js';
export * from '${src}/types.js';
export { resolveThreadStatus } from '${src}/thread-status.js';
export { Storage } from '${repo}/packages/core/src/config/storage.js';
`,
);
execFileSync(
  path.join(repo, 'node_modules/.bin/esbuild'),
  [
    path.join(tmp, 'entry.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    '--target=node20',
    `--outfile=${path.join(tmp, 'bundle.cjs')}`,
    '--log-level=error',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
const M = createRequire(import.meta.url)(path.join(tmp, 'bundle.cjs'));
M.Storage.setRuntimeBaseDir(tmp);
const ROOT = '/wa-fuzz';

// mulberry32: small, seeded, and good enough to shuffle operations.
let state = seed >>> 0;
const rnd = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

const AGENTS = ['ag_1', 'ag_2', 'ag_3'];
await M.updateWorkspaceAgents(ROOT, () =>
  AGENTS.map((id, i) => ({
    id,
    name: `a${i + 1}`,
    createdAt: 1,
    ...(i === 2 ? { maxConcurrentRuns: 2 } : {}),
  })),
);
await M.createThread(ROOT, { title: 'seed thread', assigneeAgentId: 'ag_1' });

/** Properties that must hold after any sequence of operations. */
async function check(step, op) {
  const { threads, unreadable } = await M.listThreads(ROOT);
  const agents = await M.readWorkspaceAgents(ROOT);
  const fails = [];
  const say = (cond, what) => {
    if (!cond) fails.push(what);
  };

  say(unreadable.length === 0, `unreadable threads: ${unreadable.join()}`);

  const allQueue = [];
  const liveByAgent = new Map();
  for (const t of threads) {
    const seqs = t.messages.map((m) => m.sequence);
    say(
      new Set(seqs).size === seqs.length,
      `${t.id}: duplicate message sequence`,
    );
    say(
      seqs.every((v, i) => i === 0 || v > seqs[i - 1]),
      `${t.id}: sequences out of order`,
    );
    say(
      t.nextMessageSequence > Math.max(0, ...seqs),
      `${t.id}: watermark behind`,
    );
    say(t.tokensUsed >= 0, `${t.id}: negative tokens`);
    say(
      threads.some((r) => r.id === t.rootThreadId),
      `${t.id}: rootThreadId ${t.rootThreadId} resolves to nothing`,
    );
    if (t.parentThreadId) {
      say(
        threads.some((p) => p.id === t.parentThreadId),
        `${t.id}: parentThreadId resolves to nothing`,
      );
    }
    const ids = t.runs.map((r) => r.id);
    say(new Set(ids).size === ids.length, `${t.id}: duplicate run id`);
    for (const r of t.runs) {
      allQueue.push(r.queueSequence);
      say(r.attempts >= 0, `${r.id}: negative attempts`);
      if (['queued', 'running', 'finishing', 'cancelling'].includes(r.status)) {
        liveByAgent.set(r.agentId, (liveByAgent.get(r.agentId) ?? 0) + 1);
      } else {
        say(typeof r.endedAt === 'number', `${r.id}: terminal without endedAt`);
      }
    }
    // The resolver must answer for any shape the store can be in.
    M.resolveThreadStatus({ thread: t, hasLiveChildDependency: false });
  }
  say(
    new Set(allQueue).size === allQueue.length,
    `duplicate queueSequence across the workspace`,
  );
  for (const [agentId, live] of liveByAgent) {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) continue;
    // Running is capped by maxConcurrentRuns; queued is capped by queueLimit,
    // so only the running half is asserted here.
    const running = threads
      .flatMap((t) => t.runs)
      .filter((r) => r.agentId === agentId && r.status === 'running').length;
    say(
      running <= (agent.maxConcurrentRuns ?? 1),
      `${agentId}: ${running} running over a limit of ${agent.maxConcurrentRuns ?? 1}`,
    );
    if (agent.retiredAt !== undefined) {
      const bookedAfter = threads
        .flatMap((t) => t.runs)
        .filter((r) => r.agentId === agentId && r.queuedAt > agent.retiredAt);
      say(
        bookedAfter.length === 0,
        `${agentId}: ${bookedAfter.length} run(s) booked after retirement`,
      );
    }
  }
  if (fails.length) {
    console.log(`\nFAIL at step ${step} after ${op}`);
    for (const f of fails) console.log('  - ' + f);
    console.log(
      `\nreproduce with: node ${path.relative(repo, fileURLToPath(import.meta.url))} ${seed} ${steps}`,
    );
    await fs.rm(tmp, { recursive: true, force: true });
    process.exit(1);
  }
}

const ops = [
  async () => {
    const t = await M.createThread(ROOT, {
      title: `t${Math.floor(rnd() * 1e6)}`,
      assigneeAgentId: pick(AGENTS),
      ...(rnd() < 0.3
        ? { priority: pick(['urgent', 'high', 'normal', 'low']) }
        : {}),
    });
    return `createThread ${t.id.slice(0, 12)}`;
  },
  async () => {
    const { threads } = await M.listThreads(ROOT);
    const t = pick(threads);
    const from = rnd() < 0.5 ? M.HUMAN_AUTHOR_ID : pick(AGENTS);
    await M.postMessage(ROOT, t.id, {
      from,
      text: rnd() < 0.3 ? `hey @a${1 + Math.floor(rnd() * 3)}` : 'work',
      ...(from === M.HUMAN_AUTHOR_ID ? {} : { authorKind: 'agent' }),
    });
    return `post to ${t.id.slice(0, 12)} from ${from}`;
  },
  async () => {
    const { threads } = await M.listThreads(ROOT);
    const queued = threads.flatMap((t) =>
      t.runs.filter((r) => r.status === 'queued').map((r) => [t, r]),
    );
    if (!queued.length) return 'claim (nothing queued)';
    const [t, r] = pick(queued);
    await M.claimRun(ROOT, { threadId: t.id, runId: r.id });
    return `claim ${r.id.slice(0, 12)}`;
  },
  async () => {
    const { threads } = await M.listThreads(ROOT);
    const live = threads.flatMap((t) =>
      t.runs
        .filter((r) => ['running', 'finishing'].includes(r.status))
        .map((r) => [t, r]),
    );
    if (!live.length) return 'finish (nothing live)';
    const [t, r] = pick(live);
    await M.withAgentStoreTransaction(ROOT, (tx) =>
      M.finishRunInTransaction(tx, {
        threadId: t.id,
        runId: r.id,
        outcome: {
          status: pick(['completed', 'failed', 'cancelled']),
          attempt: r.attempts,
        },
      }),
    );
    return `finish ${r.id.slice(0, 12)}`;
  },
  async () => {
    const id = pick(AGENTS);
    await M.setWorkspaceAgentEnabled(ROOT, id, rnd() < 0.5);
    return `toggle ${id}`;
  },
  async () => {
    const id = pick(AGENTS);
    await M.retireWorkspaceAgent(ROOT, id);
    return `retire ${id}`;
  },
];

console.log(`seed ${seed}, ${steps} steps`);
for (let step = 1; step <= steps; step++) {
  const op = pick(ops);
  let label;
  try {
    label = await op();
  } catch (error) {
    // A refusal is a legal outcome; the store must simply stay consistent.
    label = `refused (${String(error.message).slice(0, 60)})`;
  }
  await check(step, label);
}
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${steps} steps, every invariant held`);
