#!/usr/bin/env node
/**
 * Executes the workspace-agents rules against a real temp directory.
 *
 * Usage: node scripts/audit/run-workspace-agents.mjs
 *
 * Neither a build nor the test suite: esbuild bundles the pure store,
 * dispatcher and prompt modules — no daemon, no bridge, no model — and this
 * exercises them. It answers the one question typechecking cannot, which is
 * whether the rules behave, and it runs in seconds on a machine that cannot
 * afford `npm run build`.
 *
 * Output is one line per assertion and a count; exit 1 on any failure.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-audit-'));
const entry = path.join(tmp, 'entry.ts');
const bundle = path.join(tmp, 'bundle.cjs');
const src = 'packages/core/src/agents/workspace-agents';

await fs.writeFile(
  entry,
  `export * from '${repo}/${src}/store.js';
export { selectCandidates } from '${repo}/${src}/dispatcher.js';
export { assembleAgentPrompt } from '${repo}/${src}/prompt.js';
export * from '${repo}/${src}/types.js';
export { Storage } from '${repo}/packages/core/src/config/storage.js';
`,
);
execFileSync(
  path.join(repo, 'node_modules/.bin/esbuild'),
  [
    entry,
    '--bundle',
    '--format=cjs',
    '--platform=node',
    '--target=node20',
    `--outfile=${bundle}`,
    '--log-level=error',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
const M = createRequire(import.meta.url)(bundle);

let pass = 0,
  fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? '  → ' + detail : ''));
  }
};

M.Storage.setRuntimeBaseDir(tmp);
const ROOT = '/wa-run-project';
const ALICE = { id: 'ag_alice', name: 'alice', createdAt: 1 };
const BOB = { id: 'ag_bob', name: 'bob', createdAt: 1 };

console.log('\n1. thread creation records what it was given');
const t = await M.createThread(ROOT, {
  title: 'Investigate the flake',
  body: 'Find out why.',
  acceptanceCriteria: 'The flake is reproduced\nThe cause is named',
  priority: 'urgent',
});
ok(
  'acceptanceCriteria round-trips',
  t.acceptanceCriteria === 'The flake is reproduced\nThe cause is named',
  JSON.stringify(t.acceptanceCriteria),
);
ok('priority round-trips', t.priority === 'urgent', String(t.priority));
const normal = await M.createThread(ROOT, {
  title: 'Ordinary',
  priority: 'normal',
});
ok(
  'a default priority is not stored',
  normal.priority === undefined,
  String(normal.priority),
);
const reread = await M.readThread(ROOT, t.id);
ok(
  'both survive a read back from disk',
  reread?.acceptanceCriteria === t.acceptanceCriteria &&
    reread?.priority === 'urgent',
);

console.log('\n2. priority ranking');
ok(
  'order is highest-first',
  JSON.stringify(M.THREAD_PRIORITY_ORDER.map(M.threadPriorityRank)) ===
    '[0,1,2,3]',
);
ok(
  'absent ranks as the default',
  M.threadPriorityRank() === M.threadPriorityRank(M.DEFAULT_THREAD_PRIORITY),
);
ok(
  'an unknown word ranks as the default, not first',
  M.threadPriorityRank('critical') ===
    M.threadPriorityRank(M.DEFAULT_THREAD_PRIORITY),
);

console.log('\n3. retirement');
await M.updateWorkspaceAgents(ROOT, () => [ALICE, BOB]);
ok(
  'retire reports updated',
  (await M.retireWorkspaceAgent(ROOT, ALICE.id)) === 'updated',
);
const roster = await M.readWorkspaceAgents(ROOT);
ok(
  'the entry survives so old posts keep their author',
  roster.length === 2 && roster.some((a) => a.id === ALICE.id),
);
const alice = roster.find((a) => a.id === ALICE.id);
ok('retiredAt is stamped', typeof alice.retiredAt === 'number');
ok('enabled is untouched', alice.enabled === undefined);
ok('it is no longer addressable', M.isAgentAddressable(alice) === false);
const firstStamp = alice.retiredAt;
await new Promise((r) => setTimeout(r, 5));
ok(
  'retiring twice is idempotent',
  (await M.retireWorkspaceAgent(ROOT, ALICE.id)) === 'updated',
);
ok(
  'and does not restamp',
  (await M.readWorkspaceAgents(ROOT)).find((a) => a.id === ALICE.id)
    .retiredAt === firstStamp,
);
ok(
  'enabling a retired identity is refused',
  (await M.setWorkspaceAgentEnabled(ROOT, ALICE.id, true)) === 'retired',
);
ok(
  'an unknown id reports not_found',
  (await M.retireWorkspaceAgent(ROOT, 'ag_nobody')) === 'not_found',
);

console.log('\n4. dispatch ordering');
const run = (id, seq, over = {}) => ({
  id,
  agentId: BOB.id,
  status: 'queued',
  triggerMessageIds: [],
  acceptedMessageIds: [],
  consumedMessageIds: [],
  usageByRound: [],
  queueSequence: seq,
  attempts: 1,
  queuedAt: seq,
  ...over,
});
const thr = (id, priority, runs) => ({
  schemaVersion: M.AGENTS_SCHEMA_VERSION,
  id,
  title: id,
  body: '',
  status: 'in_progress',
  createdAt: 1,
  createdBy: M.HUMAN_AUTHOR_ID,
  rootThreadId: id,
  messages: [],
  runs,
  nextMessageSequence: 1,
  deliveryByAgent: {},
  outbox: [],
  autoTurnsUsed: 0,
  tokensUsed: 0,
  ...(priority ? { priority } : {}),
});
const wide = { ...BOB, maxConcurrentRuns: 5 };
const picked = M.selectCandidates(
  [wide],
  [
    thr('th_old', undefined, [run('rn_old', 1)]),
    thr('th_urgent', 'urgent', [run('rn_urgent', 99)]),
  ],
).map((c) => c.run.id);
ok(
  'urgent outranks age',
  JSON.stringify(picked) === '["rn_urgent","rn_old"]',
  JSON.stringify(picked),
);
const fifo = M.selectCandidates(
  [wide],
  [
    thr('th_late', 'high', [run('rn_late', 9)]),
    thr('th_early', 'high', [run('rn_early', 2)]),
  ],
).map((c) => c.run.id);
ok(
  'within one priority it stays first-come',
  JSON.stringify(fifo) === '["rn_early","rn_late"]',
  JSON.stringify(fifo),
);
const capped = M.selectCandidates(
  [{ ...BOB, maxConcurrentRuns: 2 }],
  [
    thr('t1', undefined, [run('r1', 1)]),
    thr('t2', undefined, [run('r2', 2)]),
    thr('t3', undefined, [run('r3', 3)]),
  ],
).map((c) => c.run.id);
ok(
  'an agent fills only to its limit',
  JSON.stringify(capped) === '["r1","r2"]',
  JSON.stringify(capped),
);
const busy = M.selectCandidates(
  [{ ...BOB, maxConcurrentRuns: 1 }],
  [
    thr('tl', undefined, [run('rl', 1, { status: 'running' })]),
    thr('tw', undefined, [run('rw', 2)]),
  ],
);
ok(
  'a live run counts against that limit',
  busy.length === 0,
  JSON.stringify(busy.map((c) => c.run.id)),
);
ok(
  'a retired agent is offered nothing',
  M.selectCandidates(
    [{ ...BOB, retiredAt: 1 }],
    [thr('tr', undefined, [run('rr', 1)])],
  ).length === 0,
);

console.log('\n5. the turn envelope');
const env = M.assembleAgentPrompt({
  workspaceId: 'ws_1',
  agent: BOB,
  run: run('rn_1', 1),
  thread: thr('th_1', 'urgent', [run('rn_1', 1)]),
  roster: [BOB],
});
env.thread = undefined;
const withCriteria = M.assembleAgentPrompt({
  workspaceId: 'ws_1',
  agent: BOB,
  run: run('rn_1', 1),
  thread: {
    ...thr('th_1', undefined, [run('rn_1', 1)]),
    acceptanceCriteria: 'It is reproduced',
  },
  roster: [BOB],
});
ok('criteria appear in the frame', withCriteria.text.includes('Done when:'));
ok(
  'and ahead of the untrusted posts',
  withCriteria.text.indexOf('Done when:') <
    withCriteria.text.indexOf('RECENT THREAD POSTS'),
);
ok('a thread with none says nothing', !env.text.includes('Done when:'));

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
