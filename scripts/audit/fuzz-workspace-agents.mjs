#!/usr/bin/env node
/**
 * Random operation sequences against the workspace store's invariants.
 *
 * Usage: node scripts/audit/fuzz-workspace-agents.mjs [seed] [steps]
 *        WA_FUZZ_TRACE=1 … to print each operation as it runs, which is how
 *        you check the draw is exploring rather than idling.
 *
 * The other scripts check scenarios someone thought of. This one does not:
 * it draws operations at random and asserts, after every step, the properties
 * that must hold no matter what order things happened in. The seed is printed
 * and accepted back, so a failure is reproducible rather than a story about a
 * run nobody can repeat.
 *
 * It is probabilistic, and that is a real limit rather than a caveat: removing
 * the retirement guard from decideDispatch is caught on seed 42 by step 130
 * and not caught at all on seed 1 within 300 steps. A clean run on one seed
 * says very little; several seeds say more; neither is a proof.
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
export * from '${src}/run-lifecycle.js';
export { runWithAgentRunContext } from '${src}/run-context.js';
export { ThreadPostTool, ThreadReviewTool, ThreadBlockTool, ThreadCreateTool, ThreadWaitTool } from '${repo}/packages/core/src/tools/thread-tools.js';
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
let agentSeq = AGENTS.length;
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
      const parent = threads.find((p) => p.id === t.parentThreadId);
      say(Boolean(parent), `${t.id}: parentThreadId resolves to nothing`);
      // Splitting work must not mint a second budget.
      say(
        !parent || parent.rootThreadId === t.rootThreadId,
        `${t.id}: child root ${t.rootThreadId} differs from parent root ${parent?.rootThreadId}`,
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
      if (r.status === 'finishing') {
        say(Boolean(r.closeKind), `${r.id}: finishing without a close kind`);
      }
      say(
        agents.some((a) => a.id === r.agentId),
        `${r.id}: booked for ${r.agentId}, which is not on the roster`,
      );
    }
    // The resolver must answer for any shape the store can be in.
    M.resolveThreadStatus({ thread: t, hasLiveChildDependency: false });
  }
  say(
    new Set(allQueue).size === allQueue.length,
    `duplicate queueSequence across the workspace`,
  );
  for (const agentId of liveByAgent.keys()) {
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

const cfg = { getProjectRoot: () => ROOT };
const sig = () => new AbortController().signal;
const workspaceId = (await M.readAgentWorkspace(ROOT)).workspaceId;

/** A frame for some run the store currently reports as running. */
async function someFrame() {
  const { threads } = await M.listThreads(ROOT);
  const running = threads.flatMap((t) =>
    t.runs.filter((r) => r.status === 'running').map((r) => [t, r]),
  );
  if (!running.length) return null;
  const [t, r] = pick(running);
  return {
    frame: {
      workspaceId,
      agentId: r.agentId,
      runId: r.id,
      threadId: t.id,
      rootThreadId: t.rootThreadId,
      attempt: r.attempts,
    },
    label: `${r.agentId} on ${t.id.slice(0, 12)}`,
  };
}

const ops = [
  async () => {
    const it = await someFrame();
    if (!it) return 'tool (nothing running)';
    const Tool = pick([
      M.ThreadPostTool,
      M.ThreadReviewTool,
      M.ThreadBlockTool,
      M.ThreadCreateTool,
      M.ThreadWaitTool,
    ]);
    const params =
      Tool === M.ThreadPostTool
        ? {
            text:
              rnd() < 0.4 ? `see this @a${1 + Math.floor(rnd() * 3)}` : 'noted',
          }
        : Tool === M.ThreadReviewTool
          ? { summary: 'done as far as I can tell' }
          : Tool === M.ThreadBlockTool
            ? { question: 'which one?' }
            : Tool === M.ThreadCreateTool
              ? {
                  title: `sub${Math.floor(rnd() * 1e5)}`,
                  ...(rnd() < 0.5
                    ? { assignee: `a${1 + Math.floor(rnd() * 3)}` }
                    : {}),
                }
              : {};
    const res = await M.runWithAgentRunContext(it.frame, () =>
      new Tool(cfg).buildAndExecute(params, sig()),
    );
    return `${Tool.Name ?? 'tool'} by ${it.label}${res.error ? ' (refused)' : ''}`;
  },
  async () => {
    const { threads } = await M.listThreads(ROOT);
    const t = pick(threads);
    await M.assignThread(ROOT, t.id, `a${1 + Math.floor(rnd() * 3)}`);
    return `assign ${t.id.slice(0, 12)}`;
  },
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
  async () => {
    const id = `ag_${++agentSeq}`;
    AGENTS.push(id);
    await M.updateWorkspaceAgents(ROOT, (a) => [
      ...a,
      {
        id,
        name: `a${agentSeq}`,
        createdAt: 1,
        ...(rnd() < 0.3 ? { maxConcurrentRuns: 2 } : {}),
      },
    ]);
    return `hire ${id}`;
  },
];

/**
 * Weights, because an unweighted draw degenerates twice over. Retiring is as
 * likely as anything else, so within a hundred steps every agent is retired
 * and the rest of the alphabet turns into no-ops; and claiming is rare enough
 * that few runs are ever running, so the thread tools have nothing to act on.
 * The first version executed one thread tool in 400 steps. Claiming is
 * weighted heavily, retiring and hiring are rare and balance each other, and
 * the array is index-aligned with `ops` — an earlier version was shorter than
 * `ops` and silently never drew the last two.
 */
// tool, assign, createThread, post, claim, finish, toggle, retire, hire
const WEIGHTS = [6, 2, 3, 6, 10, 4, 1, 1, 1];
const bag = WEIGHTS.flatMap((n, i) => Array.from({ length: n }, () => ops[i]));

console.log(`seed ${seed}, ${steps} steps`);
for (let step = 1; step <= steps; step++) {
  const op = pick(bag);
  let label;
  try {
    label = await op();
  } catch (error) {
    // A refusal is a legal outcome and the store must simply stay consistent
    // through it. A harness bug is not: this catch swallowed
    // `finishRunInTransaction is not a function` for a whole session, so the
    // finish operation never ran and runs never reached a terminal state —
    // a large part of the space silently unexplored behind a green result.
    if (
      error instanceof TypeError ||
      /is not a function|is not defined|Cannot read propert/.test(
        String(error.message),
      )
    ) {
      console.log(`\nHARNESS BUG at step ${step}: ${error.message}`);
      await fs.rm(tmp, { recursive: true, force: true });
      process.exit(2);
    }
    label = `refused (${String(error.message).slice(0, 60)})`;
  }
  if (process.env.WA_FUZZ_TRACE) console.log(String(step).padStart(3), label);
  await check(step, label);
}
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${steps} steps, every invariant held`);
