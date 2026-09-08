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
export { selectCandidates, deliverParentReports, deliverNotifications, dispatchOnce } from '${repo}/${src}/dispatcher.js';
export { assembleAgentPrompt } from '${repo}/${src}/prompt.js';
export { decideDispatch, resolveTargets } from '${repo}/${src}/dispatch-policy.js';
export * from '${repo}/${src}/thread-actions.js';
export { resolveThreadStatus } from '${repo}/${src}/thread-status.js';
export * from '${repo}/${src}/run-lifecycle.js';
export { runWithAgentRunContext, getAgentRunContext } from '${repo}/${src}/run-context.js';
export { ThreadPostTool, ThreadReviewTool, ThreadReadTool, ThreadCreateTool, ThreadBlockTool, ThreadWaitTool } from '${repo}/packages/core/src/tools/thread-tools.js';
export * from '${repo}/${src}/types.js';
export { Storage } from '${repo}/packages/core/src/config/storage.js';
export * as view from '${repo}/packages/web-shell/client/components/workspace-agents/agents-view-logic.js';
export { buildAgentToolConfig, classifyAgentTool, createAgentToolInvocationGuard } from '${repo}/${src}/capability.js';
export { ToolNames } from '${repo}/packages/core/src/tools/tool-names.js';
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

console.log('\n6. admission');
const post = (over = {}) => ({
  id: 'm1',
  sequence: 1,
  authorKind: 'human',
  from: M.HUMAN_AUTHOR_ID,
  authorNameSnapshot: 'you',
  text: 'go',
  mentions: [],
  outcomes: [],
  at: 1,
  ...over,
});
const decide = (over = {}) =>
  M.decideDispatch({
    thread: thr('th_a', undefined, []),
    message: post(),
    target: BOB,
    budget: { autoTurnsUsed: 0, tokensUsed: 0 },
    agentQueuedElsewhere: 0,
    ...over,
  });
ok('an ordinary mention dispatches', decide().kind === 'dispatch');
ok(
  'an unknown target is refused',
  decide({ target: undefined }).reason === 'agent_unknown',
);
ok(
  'a disabled agent is refused',
  decide({ target: { ...BOB, enabled: false } }).reason === 'agent_disabled',
);
ok(
  'a retired agent is refused, and not as merely disabled',
  decide({ target: { ...BOB, retiredAt: 1 } }).reason === 'agent_retired',
  JSON.stringify(decide({ target: { ...BOB, retiredAt: 1 } })),
);
ok(
  'a done thread is refused',
  decide({ thread: { ...thr('th_a', undefined, []), status: 'done' } })
    .reason === 'thread_done',
);
ok(
  "an agent's own post never wakes it",
  decide({ message: post({ from: BOB.id, authorKind: 'agent' }) }).reason ===
    'self_trigger',
);
ok(
  'an agent-triggered turn stops at the turn budget',
  decide({
    message: post({ from: 'ag_other', authorKind: 'agent' }),
    budget: { autoTurnsUsed: 999, tokensUsed: 0 },
  }).reason === 'turn_budget_exhausted',
);
ok(
  'a human post is not stopped by the turn budget',
  decide({ budget: { autoTurnsUsed: 999, tokensUsed: 0 } }).kind === 'dispatch',
);
ok(
  'the token budget stops even a human trigger',
  decide({ budget: { autoTurnsUsed: 0, tokensUsed: 99_999_999 } }).reason ===
    'token_budget_exhausted',
);
const queued = thr('th_a', undefined, [run('rq', 1)]);
ok(
  'a queued run of its own coalesces',
  JSON.stringify(decide({ thread: queued })) ===
    '{"kind":"coalesce","runId":"rq","into":"queued"}',
);
const running = thr('th_a', undefined, [run('rr', 1, { status: 'running' })]);
ok(
  'a running run of its own coalesces mid-turn',
  decide({ thread: running }).into === 'running',
);
ok(
  'a full queue is refused',
  decide({ agentQueuedElsewhere: 99 }).reason === 'queue_full',
);

console.log('\n7. mention routing');
ok(
  'an explicit mention routes to whoever was named',
  JSON.stringify(
    M.resolveTargets(
      thr('t', undefined, []),
      post({ mentions: ['ag_x'] }),
      true,
    ),
  ) === '["ag_x"]',
);
ok(
  'no mention falls back to the assignee',
  JSON.stringify(
    M.resolveTargets(
      { ...thr('t', undefined, []), assigneeAgentId: 'ag_a' },
      post(),
      false,
    ),
  ) === '["ag_a"]',
);
ok(
  'an unknown @token still suppresses the assignee fallback',
  // Otherwise a typo silently wakes whoever the thread is assigned to.
  M.resolveTargets(
    { ...thr('t', undefined, []), assigneeAgentId: 'ag_a' },
    post({ mentions: [] }),
    true,
  ).length === 0,
);

console.log('\n8. posting books real work');
await M.updateWorkspaceAgents(ROOT, () => [BOB]);
const live = await M.createThread(ROOT, {
  title: 'Live',
  assigneeAgentId: BOB.id,
});
const posted = await M.postMessage(ROOT, live.id, {
  from: M.HUMAN_AUTHOR_ID,
  text: 'please look',
});
ok(
  'a human post books a run for the assignee',
  posted.dispatched.length === 1 && posted.dispatched[0].agentId === BOB.id,
  JSON.stringify(posted.dispatched.map((r) => r.agentId)),
);
ok('the run starts queued', posted.dispatched[0]?.status === 'queued');
ok(
  'the outcome is recorded on the message',
  posted.outcomes.some((o) => o.decision.kind === 'dispatch'),
);
const again = await M.postMessage(ROOT, live.id, {
  from: M.HUMAN_AUTHOR_ID,
  text: 'and this too',
});
ok(
  'a second post coalesces instead of booking twice',
  again.dispatched.length === 0 &&
    again.outcomes.some((o) => o.decision.kind === 'coalesce'),
  JSON.stringify(again.outcomes.map((o) => o.decision.kind)),
);
const stored = await M.readThread(ROOT, live.id);
ok(
  'the thread holds exactly one run',
  stored.runs.length === 1,
  String(stored.runs.length),
);
ok(
  'an unknown mention is reported back',
  (
    await M.postMessage(ROOT, live.id, {
      from: M.HUMAN_AUTHOR_ID,
      text: 'hi @nobody',
    })
  ).unknownMentions.length === 1,
);

console.log('\n9. retirement reaches the posting path');
await M.updateWorkspaceAgents(ROOT, (a) =>
  a.map((x) => (x.id === BOB.id ? { ...x, retiredAt: 5 } : x)),
);
const toRetired = await M.postMessage(ROOT, live.id, {
  from: M.HUMAN_AUTHOR_ID,
  text: 'still there?',
});
ok(
  'no run is booked for a retired assignee',
  toRetired.dispatched.length === 0,
);
ok(
  'and the refusal names retirement',
  toRetired.outcomes.some((o) => o.decision.reason === 'agent_retired'),
  JSON.stringify(toRetired.outcomes.map((o) => o.decision.reason)),
);

console.log('\n10. status is an aggregate, not a stored flag');
const st = (thread, hasLiveChildDependency = false) =>
  M.resolveThreadStatus({ thread, hasLiveChildDependency }).status;
ok(
  'a done thread reads done',
  st({ ...thr('s', undefined, []), status: 'done' }) === 'done',
);
ok(
  'a running run reads in_progress',
  st(thr('s', undefined, [run('r', 1, { status: 'running' })])) ===
    'in_progress',
);
ok(
  'a queued run reads in_progress',
  st(thr('s', undefined, [run('r', 1)])) === 'in_progress',
);
// Quiescent with no obligation falls back to the stored status, so both
// stored values have to be checked — an earlier version of this assertion
// used an `in_progress` fixture and expected `open`, and the harness was
// right to refuse it.
ok(
  'quiescent and stored open reads open',
  st({ ...thr('s', undefined, []), status: 'open' }) === 'open',
);
ok(
  'quiescent and stored in_progress stays in_progress',
  st(thr('s', undefined, [])) === 'in_progress',
);
const blocked = thr('s', undefined, [
  run('r', 1, { status: 'completed', closeKind: 'blocked', endedAt: 2 }),
]);
ok(
  'an unacknowledged blocked close reads blocked',
  st(blocked) === 'blocked',
  st(blocked),
);
const review = thr('s', undefined, [
  run('r', 1, { status: 'completed', closeKind: 'review', endedAt: 2 }),
]);
ok(
  'an unacknowledged review close reads in_review',
  st(review) === 'in_review',
  st(review),
);

console.log('\n11. a run through its whole life');
await M.updateWorkspaceAgents(ROOT, () => [
  { id: 'ag_c', name: 'carol', createdAt: 1 },
]);
const lt = await M.createThread(ROOT, {
  title: 'Lifecycle',
  assigneeAgentId: 'ag_c',
});
const booked = await M.postMessage(ROOT, lt.id, {
  from: M.HUMAN_AUTHOR_ID,
  text: 'go',
});
const rid = booked.dispatched[0].id;
ok(
  'a fresh run is queued and unclaimed',
  booked.dispatched[0].status === 'queued',
);

const claimed = await M.claimRun(ROOT, { threadId: lt.id, runId: rid });
ok(
  'claiming moves it to running',
  claimed?.run.status === 'running',
  claimed?.run.status,
);
ok(
  'and stamps the attempt',
  claimed?.run.attempts === 1,
  String(claimed?.run.attempts),
);
ok(
  'claiming twice is refused',
  (await M.claimRun(ROOT, { threadId: lt.id, runId: rid })) === undefined,
);

await M.bindRunSession(ROOT, {
  threadId: lt.id,
  runId: rid,
  attempt: 1,
  sessionId: 'agent-ag_c',
  contextThroughSequence: 1,
  consumedOnStart: true,
  usageBaselineTokens: 40,
});
const bound = (await M.readThread(ROOT, lt.id)).runs.find((r) => r.id === rid);
ok('the session id is recorded', bound.sessionId === 'agent-ag_c');
ok(
  'the usage baseline is recorded',
  bound.usageBaselineTokens === 40,
  String(bound.usageBaselineTokens),
);
ok(
  'binding commits the opening delivery',
  ((await M.readThread(ROOT, lt.id)).deliveryByAgent['ag_c']
    ?.committedThroughSequence ?? 0) >= 1,
);

await M.withAgentStoreTransaction(ROOT, (tx) =>
  M.finishRunInTransaction(tx, {
    threadId: lt.id,
    runId: rid,
    outcome: { status: 'completed', attempt: 1 },
  }),
);
const done = (await M.readThread(ROOT, lt.id)).runs.find((r) => r.id === rid);
ok('finishing makes it terminal', done.status === 'completed', done.status);
ok('and stamps an end time', typeof done.endedAt === 'number');
ok(
  'a terminal run cannot be claimed again',
  (await M.claimRun(ROOT, { threadId: lt.id, runId: rid })) === undefined,
);
ok(
  'finishing a run that is already terminal does not resurrect it',
  (
    await M.withAgentStoreTransaction(ROOT, (tx) =>
      M.finishRunInTransaction(tx, {
        threadId: lt.id,
        runId: rid,
        outcome: { status: 'failed', attempt: 1 },
      }),
    )
  ).runs.find((r) => r.id === rid).status === 'completed',
);

console.log('\n12. budgets actually refuse');
const agentPost = (used) =>
  M.decideDispatch({
    thread: thr('b', undefined, []),
    message: post({ from: 'ag_other', authorKind: 'agent' }),
    target: BOB,
    budget: { autoTurnsUsed: used, tokensUsed: 0 },
    agentQueuedElsewhere: 0,
  });
ok(
  'one turn below the limit still dispatches',
  agentPost(11).kind === 'dispatch',
);
ok('at the limit it refuses', agentPost(12).reason === 'turn_budget_exhausted');
const spend = (t) =>
  M.decideDispatch({
    thread: thr('b', undefined, []),
    message: post(),
    target: BOB,
    budget: { autoTurnsUsed: 0, tokensUsed: t },
    agentQueuedElsewhere: 0,
  });
ok(
  'one token below the cap still dispatches',
  spend(999_999).kind === 'dispatch',
);
ok(
  'at the cap it refuses even a person',
  spend(1_000_000).reason === 'token_budget_exhausted',
);
ok(
  'a caller-supplied limit overrides the default',
  M.decideDispatch({
    thread: thr('b', undefined, []),
    message: post(),
    target: BOB,
    budget: { autoTurnsUsed: 0, tokensUsed: 10 },
    agentQueuedElsewhere: 0,
    limits: { tokens: 10 },
  }).reason === 'token_budget_exhausted',
);

console.log('\n13. an agent actually posting, under a real run frame');
// The break this whole review started from: the thread tools require an
// ambient run frame, and deleting runtime-bridge.ts took the only production
// call that established one. Reading could not tell me whether the
// replacement works. This runs it.
const cfg = { getProjectRoot: () => ROOT };
const ws = await M.readAgentWorkspace(ROOT);
await M.updateWorkspaceAgents(ROOT, () => [
  { id: 'ag_p', name: 'pat', createdAt: 1 },
  { id: 'ag_q', name: 'quinn', createdAt: 1 },
  { id: 'ag_s', name: 'sam', createdAt: 1 },
]);
const wt2 = await M.createThread(ROOT, {
  title: 'Real work',
  assigneeAgentId: 'ag_p',
});
const bk = await M.postMessage(ROOT, wt2.id, {
  from: M.HUMAN_AUTHOR_ID,
  text: 'start',
});
const wrid = bk.dispatched[0].id;
await M.claimRun(ROOT, { threadId: wt2.id, runId: wrid });
const frame = {
  workspaceId: ws.workspaceId,
  agentId: 'ag_p',
  runId: wrid,
  threadId: wt2.id,
  rootThreadId: wt2.rootThreadId,
  attempt: 1,
};

ok(
  'a thread tool outside any frame refuses',
  await (async () => {
    const r = await new M.ThreadPostTool(cfg).buildAndExecute(
      { text: 'x' },
      new AbortController().signal,
    );
    return Boolean(r.error);
  })(),
  'it should not have been allowed to post',
);

const postRes = await M.runWithAgentRunContext(frame, () =>
  new M.ThreadPostTool(cfg).buildAndExecute(
    { text: 'Looking now.' },
    new AbortController().signal,
  ),
);
ok(
  'inside its frame the agent posts',
  !postRes.error,
  JSON.stringify(postRes.error),
);
const afterPost = await M.readThread(ROOT, wt2.id);
ok(
  'the post is on the thread',
  afterPost.messages.some((m) => m.text.includes('Looking now.')),
);
ok(
  'and is attributed to the agent, not a person',
  afterPost.messages.at(-1).from === 'ag_p' &&
    afterPost.messages.at(-1).authorKind === 'agent',
  afterPost.messages.at(-1).from,
);
ok(
  'and carries the run that wrote it',
  afterPost.messages.at(-1).sourceRunId === wrid,
);

const handoff = await M.runWithAgentRunContext(frame, () =>
  new M.ThreadPostTool(cfg).buildAndExecute(
    { text: 'over to you @quinn' },
    new AbortController().signal,
  ),
);
ok(
  'a mention hands work to a peer',
  !handoff.error,
  JSON.stringify(handoff.error),
);
const afterHandoff = await M.readThread(ROOT, wt2.id);
ok(
  'which books a run for that peer',
  afterHandoff.runs.some((r) => r.agentId === 'ag_q' && r.status === 'queued'),
  JSON.stringify(afterHandoff.runs.map((r) => [r.agentId, r.status])),
);

const readRes = await M.runWithAgentRunContext(frame, () =>
  new M.ThreadReadTool(cfg).buildAndExecute({}, new AbortController().signal),
);
ok(
  'the agent can read its own thread',
  !readRes.error,
  JSON.stringify(readRes.error),
);

// pat is still running the thread above and the default maxConcurrentRuns is
// 1, so pat cannot be claimed onto a second thread. That refusal is the
// concurrency limit working, and it is worth asserting rather than tiptoeing
// around — an earlier version of this section used pat here and read the
// refusal as a bug in thread_review.
const capT = await M.createThread(ROOT, {
  title: 'Second',
  assigneeAgentId: 'ag_p',
});
const capBk = await M.postMessage(ROOT, capT.id, {
  from: M.HUMAN_AUTHOR_ID,
  text: 'also this',
});
ok(
  'an agent already at its concurrency limit cannot be claimed again',
  (await M.claimRun(ROOT, {
    threadId: capT.id,
    runId: capBk.dispatched[0].id,
  })) === undefined,
);

// The review flow needs an idle agent and a thread with nothing else live: a
// queued run counts as live, so a thread carrying a hand-off legitimately
// reads in_progress.
const rt = await M.createThread(ROOT, {
  title: 'Review flow',
  assigneeAgentId: 'ag_s',
});
const rbk = await M.postMessage(ROOT, rt.id, {
  from: M.HUMAN_AUTHOR_ID,
  text: 'start',
});
const rrid = rbk.dispatched[0].id;
await M.claimRun(ROOT, { threadId: rt.id, runId: rrid });
const rframe = {
  workspaceId: ws.workspaceId,
  agentId: 'ag_s',
  runId: rrid,
  threadId: rt.id,
  rootThreadId: rt.rootThreadId,
  attempt: 1,
};
const reviewRes = await M.runWithAgentRunContext(rframe, () =>
  new M.ThreadReviewTool(cfg).buildAndExecute(
    { summary: 'Reproduced; the cause is a race.' },
    new AbortController().signal,
  ),
);
ok(
  'handing back for review succeeds',
  !reviewRes.error,
  JSON.stringify(reviewRes.error),
);
const afterReview = await M.readThread(ROOT, rt.id);
const own = afterReview.runs.find((r) => r.id === rrid);
ok(
  'the run closes as review',
  own.closeKind === 'review',
  String(own.closeKind),
);
// The close is two writes by design: the tool marks the run `finishing` and
// records why, and the dispatcher writes the terminal status afterwards. An
// earlier version of this assertion expected `in_review` straight after the
// tool and blamed the resolver for the gap — a `finishing` run is still live,
// so in_progress was the honest reading.
ok(
  'the tool leaves the run finishing, not terminal',
  own.status === 'finishing',
  own.status,
);
ok(
  'and mid-close the thread still reads in_progress',
  M.resolveThreadStatus({ thread: afterReview, hasLiveChildDependency: false })
    .status === 'in_progress',
);
await M.withAgentStoreTransaction(ROOT, (tx) =>
  M.finishRunInTransaction(tx, {
    threadId: rt.id,
    runId: rrid,
    outcome: { status: 'completed', attempt: 1 },
  }),
);
const settled = await M.readThread(ROOT, rt.id);
ok(
  'once the dispatcher closes it the thread reads in_review',
  M.resolveThreadStatus({ thread: settled, hasLiveChildDependency: false })
    .status === 'in_review',
  M.resolveThreadStatus({ thread: settled, hasLiveChildDependency: false })
    .status,
);
ok(
  'and the review obligation is the one outstanding',
  M.resolveThreadStatus({
    thread: settled,
    hasLiveChildDependency: false,
  }).outstanding.some((o) => o.kind === 'review'),
);
ok('an agent cannot mark a thread done', afterReview.status !== 'done');

console.log('\n14. delegation, blocking and waiting');
const sig = () => new AbortController().signal;
const asAgent = async (agentId, threadId, runId, rootThreadId, fn) =>
  M.runWithAgentRunContext(
    {
      workspaceId: ws.workspaceId,
      agentId,
      runId,
      threadId,
      rootThreadId,
      attempt: 1,
    },
    fn,
  );
// Each scenario gets its own agent: maxConcurrentRuns defaults to 1, so an
// agent still running an earlier scenario cannot be claimed onto a new one.
// The claim is asserted rather than assumed — silently continuing with a
// queued run is what turned that limit into six confusing failures once.
let agentSeq = 0;
const startFor = async (title) => {
  const agentId = `ag_w${++agentSeq}`;
  await M.updateWorkspaceAgents(ROOT, (a) => [
    ...a,
    { id: agentId, name: `w${agentSeq}`, createdAt: 1 },
  ]);
  const th = await M.createThread(ROOT, { title, assigneeAgentId: agentId });
  const bk2 = await M.postMessage(ROOT, th.id, {
    from: M.HUMAN_AUTHOR_ID,
    text: 'go',
  });
  const id = bk2.dispatched[0].id;
  const got = await M.claimRun(ROOT, { threadId: th.id, runId: id });
  if (!got) throw new Error(`could not claim ${title} for ${agentId}`);
  return { th, runId: id, agentId };
};

const d1 = await startFor('Delegating');
const created = await asAgent(
  d1.agentId,
  d1.th.id,
  d1.runId,
  d1.th.rootThreadId,
  () =>
    new M.ThreadCreateTool(cfg).buildAndExecute(
      {
        title: 'Sub-task',
        body: 'the smaller half',
        acceptanceCriteria: 'It compiles',
      },
      sig(),
    ),
);
ok(
  'an agent can split out a sub-thread',
  !created.error,
  JSON.stringify(created.error),
);
const all = (await M.listThreads(ROOT)).threads;
const child = all.find((t) => t.parentThreadId === d1.th.id);
ok('the child records its parent', Boolean(child));
ok(
  'and shares the parent budget root',
  child?.rootThreadId === d1.th.rootThreadId,
  child?.rootThreadId,
);
ok(
  'the child carries the criteria it was handed',
  child?.acceptanceCriteria === 'It compiles',
  String(child?.acceptanceCriteria),
);
const again2 = await asAgent(
  d1.agentId,
  d1.th.id,
  d1.runId,
  d1.th.rootThreadId,
  () =>
    new M.ThreadCreateTool(cfg).buildAndExecute({ title: 'Sub-task' }, sig()),
);
ok(
  'splitting the same title twice reuses the first',
  !again2.error &&
    (await M.listThreads(ROOT)).threads.filter(
      (t) => t.parentThreadId === d1.th.id,
    ).length === 1,
);

const b1 = await startFor('Blocking');
const blocked2 = await asAgent(
  b1.agentId,
  b1.th.id,
  b1.runId,
  b1.th.rootThreadId,
  () =>
    new M.ThreadBlockTool(cfg).buildAndExecute(
      { question: 'Which environment?' },
      sig(),
    ),
);
ok(
  'an agent can block on a person',
  !blocked2.error,
  JSON.stringify(blocked2.error),
);
const bth = await M.readThread(ROOT, b1.th.id);
ok(
  'the question is posted for a person to read',
  bth.messages.some((m) => m.text.includes('Which environment?')),
);
ok(
  'and the run closes as blocked',
  bth.runs.find((r) => r.id === b1.runId)?.closeKind === 'blocked',
);
await M.withAgentStoreTransaction(ROOT, (tx) =>
  M.finishRunInTransaction(tx, {
    threadId: b1.th.id,
    runId: b1.runId,
    outcome: { status: 'completed', attempt: 1 },
  }),
);
ok(
  'the thread then reads blocked',
  M.resolveThreadStatus({
    thread: await M.readThread(ROOT, b1.th.id),
    hasLiveChildDependency: false,
  }).status === 'blocked',
);

const w1 = await startFor('Waiting');
// Waiting is only legal when something can still wake the thread. Refusing
// otherwise is the guard against an agent stranding its own work.
const idleWait = await asAgent(
  w1.agentId,
  w1.th.id,
  w1.runId,
  w1.th.rootThreadId,
  () => new M.ThreadWaitTool(cfg).buildAndExecute({}, sig()),
);
ok(
  'waiting with nothing open is refused',
  Boolean(idleWait.error),
  'it should not have been allowed to strand the thread',
);
// Assigned, not merely created: an open sub-thread with nobody on it cannot
// wake its parent, so delegating to no one is not delegation and the guard
// still refuses. This is the shape that makes a wait legitimate.
await M.updateWorkspaceAgents(ROOT, (a) => [
  ...a,
  { id: 'ag_helper', name: 'helper', createdAt: 1 },
]);
await asAgent(w1.agentId, w1.th.id, w1.runId, w1.th.rootThreadId, () =>
  new M.ThreadCreateTool(cfg).buildAndExecute(
    { title: 'Delegated bit', assignee: 'helper' },
    sig(),
  ),
);
const waited = await asAgent(
  w1.agentId,
  w1.th.id,
  w1.runId,
  w1.th.rootThreadId,
  () => new M.ThreadWaitTool(cfg).buildAndExecute({}, sig()),
);
ok(
  'waiting on an open sub-thread succeeds',
  !waited.error,
  JSON.stringify(waited.error),
);
await M.withAgentStoreTransaction(ROOT, (tx) =>
  M.finishRunInTransaction(tx, {
    threadId: w1.th.id,
    runId: w1.runId,
    outcome: { status: 'completed', attempt: 1 },
  }),
);
const wth = await M.readThread(ROOT, w1.th.id);
ok(
  'the wait reads in_progress while the child is live',
  M.resolveThreadStatus({ thread: wth, hasLiveChildDependency: true })
    .status === 'in_progress',
  M.resolveThreadStatus({ thread: wth, hasLiveChildDependency: true }).status,
);
ok(
  'and blocked once nothing can wake it',
  M.resolveThreadStatus({ thread: wth, hasLiveChildDependency: false })
    .status === 'blocked',
  M.resolveThreadStatus({ thread: wth, hasLiveChildDependency: false }).status,
);

console.log('\n15. a child reporting back to its parent');
// The outbox exists so a sub-thread's conclusion reaches the thread that
// delegated it, exactly once, even if the delivery is retried.
const pp = await startFor('Parent work');
await M.updateWorkspaceAgents(ROOT, (a) => [
  ...a,
  { id: 'ag_kid', name: 'kid', createdAt: 1 },
]);
await asAgent(pp.agentId, pp.th.id, pp.runId, pp.th.rootThreadId, () =>
  new M.ThreadCreateTool(cfg).buildAndExecute(
    { title: 'The smaller half', assignee: 'kid' },
    sig(),
  ),
);
const kid = (await M.listThreads(ROOT)).threads.find(
  (t) => t.parentThreadId === pp.th.id,
);
ok(
  'delegating booked the child a run',
  kid.runs.length === 1,
  String(kid.runs.length),
);

const kidRun = kid.runs[0].id;
await M.claimRun(ROOT, { threadId: kid.id, runId: kidRun });
await asAgent(kid.assigneeAgentId, kid.id, kidRun, kid.rootThreadId, () =>
  new M.ThreadReviewTool(cfg).buildAndExecute({ summary: 'Half done.' }, sig()),
);
await M.withAgentStoreTransaction(ROOT, (tx) =>
  M.finishRunInTransaction(tx, {
    threadId: kid.id,
    runId: kidRun,
    outcome: { status: 'completed', attempt: 1 },
  }),
);
const closedKid = await M.readThread(ROOT, kid.id);
ok(
  'the child queues a report for its parent',
  closedKid.outbox.some(
    (e) => e.kind === 'parent_report' && e.status === 'pending',
  ),
  JSON.stringify(closedKid.outbox.map((e) => [e.kind, e.status])),
);

const beforeParent = (await M.readThread(ROOT, pp.th.id)).messages.length;
ok(
  'delivering the report reaches the parent',
  (await M.deliverParentReports(ROOT)) >= 1,
);
const afterParent = await M.readThread(ROOT, pp.th.id);
ok(
  'and posts on it',
  afterParent.messages.length > beforeParent,
  `${beforeParent} -> ${afterParent.messages.length}`,
);
ok(
  'the report is acknowledged, not left pending',
  !(await M.readThread(ROOT, kid.id)).outbox.some(
    (e) => e.kind === 'parent_report' && e.status === 'pending',
  ),
);
ok(
  'delivering again sends nothing, so a retry is not a second message',
  (await M.deliverParentReports(ROOT)) === 0 &&
    (await M.readThread(ROOT, pp.th.id)).messages.length ===
      afterParent.messages.length,
);

console.log('\n16. crash recovery');
// The daemon can die mid-turn. On the next tick the dispatcher has to decide,
// from the runtime's answer alone, whether each live run is still real.
const fakePort = (state, extra = {}) => ({
  inspect: async () => state,
  start: async () => ({
    status: 'started',
    sessionId: 's',
    consumedOnStart: true,
  }),
  cancel: async () => true,
  ...extra,
});

const c1 = await startFor('Crashed body');
const beforeRecovery = (await M.readThread(ROOT, c1.th.id)).runs.find(
  (r) => r.id === c1.runId,
).status;
ok('the run is running before the crash', beforeRecovery === 'running');
// The body is gone and the run has drained its input: nothing left to do.
let recs = await M.dispatchOnce(ROOT, fakePort({ kind: 'completed' }));
const afterRecovery = (await M.readThread(ROOT, c1.th.id)).runs.find(
  (r) => r.id === c1.runId,
);
ok(
  'a completed body closes the run rather than leaving it live forever',
  afterRecovery.status === 'completed',
  afterRecovery.status,
);
ok(
  'and the dispatcher says so in its record',
  recs.some((r) => r.kind === 'recovered_terminal'),
  JSON.stringify(recs.map((r) => r.kind)),
);

const c2 = await startFor('Vanished body');
// Absent, not completed: the body disappeared without finishing, so the first
// attempt is retried rather than written off.
recs = await M.dispatchOnce(ROOT, fakePort({ kind: 'absent' }));
const retried = (await M.readThread(ROOT, c2.th.id)).runs.find(
  (r) => r.id === c2.runId,
);
// The durable evidence is the attempt count, not the status: one dispatchOnce
// requeues the run and then, in the same pass, starts it again — so reading
// `queued` back is a race with the very recovery being tested.
ok(
  'a vanished body is retried, and the attempt count says so',
  retried.attempts === 2,
  `status=${retried.status} attempts=${retried.attempts}`,
);
ok(
  'and the record names the requeue',
  recs.some((r) => r.kind === 'requeued'),
);

const c3 = await startFor('Divergent body');
// The runtime says it is working something else. Guessing which is right is
// how two runs end up believing they own one thread.
recs = await M.dispatchOnce(
  ROOT,
  fakePort({
    kind: 'running',
    threadId: 'th_somewhere_else',
    runId: 'rn_other',
  }),
);
const untouched = (await M.readThread(ROOT, c3.th.id)).runs.find(
  (r) => r.id === c3.runId,
);
ok(
  'a divergent body is reported and the run is left alone',
  untouched.status === 'running' &&
    recs.some((r) => r.kind === 'runtime_divergence'),
  `${untouched.status} ${JSON.stringify(recs.map((r) => r.kind))}`,
);

console.log('\n17. what the panel tells a person');
const V = M.view;
const summary = (over = {}) => ({
  id: 't',
  title: 'T',
  status: 'open',
  reason: 'r',
  updatedAt: 1,
  liveRunCount: 0,
  ...over,
});

ok(
  'work needing a person is grouped first, not buried by recency',
  V.groupThreads([
    summary({ id: 'a', status: 'open', updatedAt: 99 }),
    summary({ id: 'b', status: 'blocked', updatedAt: 1 }),
  ])[0].key === 'needs_you',
);
ok(
  'blocked and in_review share that group, because they are one question',
  V.groupThreads([
    summary({ id: 'a', status: 'blocked' }),
    summary({ id: 'b', status: 'in_review' }),
  ]).find((g) => g.key === 'needs_you').threads.length === 2,
);
ok(
  'finished work starts collapsed',
  V.groupThreads([summary({ status: 'done' })])[0].collapsedByDefault === true,
);
ok(
  'an empty group is not shown at all',
  V.groupThreads([summary({ status: 'open' })]).every(
    (g) => g.threads.length > 0,
  ),
);

ok(
  'a retired agent is explained as retired, not as disabled',
  V.explainSkip('agent_retired', 'alice').what.includes('retired'),
  JSON.stringify(V.explainSkip('agent_retired', 'alice')),
);
ok(
  'and is not told to enable it, which is refused',
  !V.explainSkip('agent_retired', 'alice').fix.toLowerCase().includes('enable'),
  V.explainSkip('agent_retired', 'alice').fix,
);
ok(
  'a disabled agent still is told to enable it',
  V.explainSkip('agent_disabled', 'alice').fix.toLowerCase().includes('enable'),
);
ok(
  'an unknown name is a spelling problem, not an availability one',
  V.explainSkip('agent_unknown', 'alice')
    .fix.toLowerCase()
    .includes('spelling'),
);

const runView = (over = {}) => ({
  id: 'r',
  agentId: 'a',
  agentName: 'alice',
  status: 'completed',
  closeAcknowledged: false,
  trigger: 'assigned by you',
  ...over,
});
ok(
  'a blocked close reads as a question asked',
  V.describeRun(runView({ closeKind: 'blocked' })) === 'asked a question',
);
ok(
  'a failure names the stage it failed at',
  V.describeRun(runView({ status: 'failed', failureStage: 'launch' })) ===
    'failed at launch',
);
const rows = V.buildRunRows([
  runView({ id: 'old', status: 'completed', endedAt: 1 }),
  runView({ id: 'live', status: 'running', startedAt: 5 }),
  runView({ id: 'new', status: 'completed', endedAt: 9 }),
]);
ok(
  'live runs are listed apart from finished ones',
  rows.live.map((r) => r.run.id).join() === 'live',
  rows.live.map((r) => r.run.id).join(),
);
ok(
  'and finished ones are newest first',
  rows.past.map((r) => r.run.id).join() === 'new,old',
  rows.past.map((r) => r.run.id).join(),
);
ok(
  'an unacknowledged blocked close is flagged outstanding',
  V.buildRunRows([runView({ closeKind: 'blocked' })]).past[0].outstanding ===
    true,
);
ok(
  'an acknowledged one is not',
  V.buildRunRows([runView({ closeKind: 'blocked', closeAcknowledged: true })])
    .past[0].outstanding === false,
);

const bud = V.formatBudget({
  turnsUsed: 3,
  turnLimit: 12,
  tokensUsed: 2500,
  tokenLimit: 1000000,
});
ok(
  'the budget line is readable, not a raw count',
  bud.tokens === '2.5k of 1000.0k tokens',
  bud.tokens,
);
ok('and says the spend is tree-wide', bud.scope.includes('thread tree'));

console.log('\n17b. a sub-thread cannot buy a fresh budget');
// Decision 17. Without inheritance an agent could reset the loop breaker by
// delegating: the child would start at zero unattended turns and the whole
// tree could run forever a sub-thread at a time.
const budgetParent = await startFor('Budget parent');
await M.updateThread(ROOT, budgetParent.th.id, (t) => ({
  ...t,
  autoTurnsUsed: 7,
}));
const budgetChild = await asAgent(
  budgetParent.agentId,
  budgetParent.th.id,
  budgetParent.runId,
  budgetParent.th.rootThreadId,
  () =>
    new M.ThreadCreateTool(cfg).buildAndExecute(
      { title: 'Inheriting bit' },
      sig(),
    ),
);
ok(
  'the split succeeded',
  !budgetChild.error,
  JSON.stringify(budgetChild.error),
);
const inheritor = (await M.listThreads(ROOT)).threads.find(
  (t) => t.parentThreadId === budgetParent.th.id,
);
ok(
  'the child starts from the parent count, not from zero',
  inheritor?.autoTurnsUsed === 7,
  String(inheritor?.autoTurnsUsed),
);
ok(
  'and charges tokens to the same root',
  inheritor?.rootThreadId === budgetParent.th.rootThreadId,
);

console.log('\n17c. the two boundaries a person has to take on trust');
// Decisions 4 and 12. Both are enforced somewhere in the code and neither had
// an executable check here, which is exactly the pair worth having one for:
// they are the guarantees a reader cannot verify by looking at a thread.

// 12: an agent may post, mention and delegate, but may not make more agents.
const ceiling = M.buildAgentToolConfig({ tools: ['*'] });
ok(
  'no agent-creating tool is in reach',
  !ceiling.tools.includes(M.ToolNames.AGENT),
  JSON.stringify(ceiling.tools.filter((t) => t === M.ToolNames.AGENT)),
);
ok(
  'and it is named as denied rather than merely absent',
  ceiling.disallowedTools.includes(M.ToolNames.AGENT),
);
const guard = M.createAgentToolInvocationGuard();
ok(
  'the guard refuses it even if something asks anyway',
  (await guard({ toolName: M.ToolNames.AGENT })).allowed === false,
);
ok(
  'while a thread tool is allowed through the same guard',
  (await guard({ toolName: 'thread_post' })).allowed === true,
);

// 4: a run frame from another workspace must not act on this one. On a fresh
// live run, so the only thing wrong with the frame is its workspace — an
// earlier version reused a frame whose run had already been closed, and
// passed on the closed-run check while proving nothing about workspaces.
const scoped = await startFor('Workspace scoping');
const scopedFrame = {
  workspaceId: ws.workspaceId,
  agentId: scoped.agentId,
  runId: scoped.runId,
  threadId: scoped.th.id,
  rootThreadId: scoped.th.rootThreadId,
  attempt: 1,
};
ok(
  'the frame works as itself first',
  !(
    await M.runWithAgentRunContext(scopedFrame, () =>
      new M.ThreadPostTool(cfg).buildAndExecute({ text: 'in scope' }, sig()),
    )
  ).error,
);
const wrongWorkspace = await M.runWithAgentRunContext(
  { ...scopedFrame, workspaceId: 'ws_somewhere_else' },
  () =>
    new M.ThreadPostTool(cfg).buildAndExecute(
      { text: 'from the wrong workspace' },
      sig(),
    ),
);
ok(
  'a frame naming another workspace cannot post here',
  Boolean(wrongWorkspace.error),
  'it should not have been allowed to write across workspaces',
);
ok(
  'and nothing it tried to say landed',
  !(await M.readThread(ROOT, scoped.th.id)).messages.some((m) =>
    m.text.includes('from the wrong workspace'),
  ),
);

console.log('\n18. concurrency');
// Everything above ran one operation at a time, which is the one shape a
// store with a mutation lock is guaranteed to survive. These run together.
const many = 8;

const conc1 = await startFor('Concurrent posts');
const posts = await Promise.all(
  Array.from({ length: many }, (_, i) =>
    M.postMessage(ROOT, conc1.th.id, {
      from: M.HUMAN_AUTHOR_ID,
      text: `post ${i}`,
    }),
  ),
);
const concThread = await M.readThread(ROOT, conc1.th.id);
ok(
  'every concurrent post is kept, none lost to a read-modify-write race',
  posts.length === many &&
    Array.from({ length: many }, (_, i) =>
      concThread.messages.some((m) => m.text === `post ${i}`),
    ).every(Boolean),
  `${concThread.messages.length} messages on the thread`,
);
const seqs = concThread.messages.map((m) => m.sequence);
ok(
  'their sequences are unique',
  new Set(seqs).size === seqs.length,
  JSON.stringify(seqs),
);
ok(
  'and strictly increasing',
  seqs.every((v, i) => i === 0 || v > seqs[i - 1]),
  JSON.stringify(seqs),
);
ok(
  'the next sequence stays ahead of every message',
  concThread.nextMessageSequence > Math.max(...seqs),
  `${concThread.nextMessageSequence} vs ${Math.max(...seqs)}`,
);

const conc2 = await startFor('Contended claim');
await M.withAgentStoreTransaction(ROOT, (tx) =>
  M.finishRunInTransaction(tx, {
    threadId: conc2.th.id,
    runId: conc2.runId,
    outcome: { status: 'completed', attempt: 1 },
  }),
);
const reBooked = await M.postMessage(ROOT, conc2.th.id, {
  from: M.HUMAN_AUTHOR_ID,
  text: 'again',
});
const contended = reBooked.dispatched[0].id;
const claims = await Promise.all(
  Array.from({ length: many }, () =>
    M.claimRun(ROOT, { threadId: conc2.th.id, runId: contended }),
  ),
);
ok(
  'exactly one of many concurrent claims wins',
  claims.filter(Boolean).length === 1,
  `${claims.filter(Boolean).length} winners`,
);
ok(
  'and the run is claimed exactly once',
  (await M.readThread(ROOT, conc2.th.id)).runs.find((r) => r.id === contended)
    .attempts === 1,
);

// queueSequence is issued under the lock and orders the whole workspace, so a
// duplicate would make two runs indistinguishable to the dispatcher.
const spread = await Promise.all(
  Array.from({ length: many }, (_, i) =>
    M.createThread(ROOT, { title: `Parallel ${i}` }),
  ),
);
ok(
  'concurrent thread creation gives distinct ids',
  new Set(spread.map((t) => t.id)).size === many,
);
const everyRun = (await M.listThreads(ROOT)).threads.flatMap((t) => t.runs);
const queueSeqs = everyRun.map((r) => r.queueSequence);
ok(
  'every run in the workspace has a distinct queue sequence',
  new Set(queueSeqs).size === queueSeqs.length,
  `${queueSeqs.length} runs, ${new Set(queueSeqs).size} distinct`,
);

const rosterBefore = (await M.readWorkspaceAgents(ROOT)).length;
await Promise.all(
  Array.from({ length: many }, (_, i) =>
    M.updateWorkspaceAgents(ROOT, (a) => [
      ...a,
      { id: `ag_par${i}`, name: `par${i}`, createdAt: 1 },
    ]),
  ),
);
ok(
  'concurrent roster writes all land, none overwrite each other',
  (await M.readWorkspaceAgents(ROOT)).length === rosterBefore + many,
  `${rosterBefore} -> ${(await M.readWorkspaceAgents(ROOT)).length}`,
);

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
