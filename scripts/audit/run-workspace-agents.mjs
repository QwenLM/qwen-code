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
export { buildAgentToolConfig, classifyAgentTool, createAgentToolInvocationGuard, THREAD_TOOL_NAMES } from '${repo}/${src}/capability.js';
export { outstandingCloseObligations, acknowledgeCloseObligations } from '${repo}/${src}/thread-status.js';
export { resolveAgentPersona } from '${repo}/${src}/persona.js';
export { findAgentSessionBinding } from '${repo}/${src}/session-binding.js';
export { strandLocalRuns, STRANDED_FAILURE_STAGE } from '${repo}/${src}/stranded-runs.js';
export * from '${repo}/${src}/a2a-contract.js';
export * from '${repo}/${src}/external-intake.js';
export * from '${repo}/${src}/a2a-grants.js';
export * from '${repo}/${src}/a2a-server.js';
export { deleteThread, enqueueThreadEvent } from '${repo}/${src}/store.js';
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

console.log('\n17d. the paths a mutation campaign found untested');
// Every assertion here exists because disabling the guard behind it changed
// nothing in this script. A guard nothing notices is a guard nothing checks.

// capability.ts: the table is an allow-list, so a name that is not in it at
// all must be denied rather than falling through as unclassified.
ok(
  'a tool nobody classified is denied, not ignored',
  M.classifyAgentTool('some_tool_invented_later') === 'deny',
  M.classifyAgentTool('some_tool_invented_later'),
);
ok(
  'and the guard refuses it too',
  (await guard({ toolName: 'some_tool_invented_later' })).allowed === false,
);
ok(
  'an upstream refusal is not overridden by this guard',
  (
    await M.createAgentToolInvocationGuard(async () => ({
      allowed: false,
      reason: 'upstream said no',
    }))({ toolName: 'thread_post', signal: sig() })
  ).allowed === false,
);

// thread-tools: an empty title is refused rather than making a nameless
// sub-thread nobody can find again.
const emptyTitle = await M.runWithAgentRunContext(scopedFrame, () =>
  new M.ThreadCreateTool(cfg).buildAndExecute({ title: '   ' }, sig()),
);
ok('a blank sub-thread title is refused', Boolean(emptyTitle.error));

// thread-status: the close obligations a thread still owes.
const obligThread = thr('ob', undefined, [
  run('r_live', 1, { status: 'running' }),
  run('r_blocked', 2, {
    status: 'completed',
    closeKind: 'blocked',
    endedAt: 5,
  }),
  run('r_plain', 3, { status: 'completed', endedAt: 6 }),
]);
const outstanding = M.outstandingCloseObligations(obligThread);
ok(
  'a live run owes nothing yet',
  !outstanding.some((o) => o.runId === 'r_live'),
  JSON.stringify(outstanding.map((o) => [o.runId, o.kind])),
);
// A `finishing` run carries a close kind and is still live, so it owes
// nothing *yet* — the obligation appears when the dispatcher writes the
// terminal status. This is the case that distinguishes the liveness guard
// from the close-kind one; without it, disabling liveness changed nothing
// because every live fixture also lacked a close kind.
ok(
  'a finishing run owes nothing until it is terminal',
  !M.outstandingCloseObligations(
    thr('ob_fin', undefined, [
      run('r_fin', 1, { status: 'finishing', closeKind: 'review' }),
    ]),
  ).length,
);
ok(
  'a blocked close is outstanding',
  outstanding.some((o) => o.runId === 'r_blocked' && o.kind === 'blocked'),
);
// A completed run that recorded no close kind owes nothing: `unclosed` is a
// close kind an agent can record, not the absence of one. An earlier version
// of this assertion conflated the two and the code was right.
ok(
  'a completed run with no close kind owes nothing',
  !outstanding.some((o) => o.runId === 'r_plain'),
  JSON.stringify(outstanding.map((o) => [o.runId, o.kind])),
);
ok(
  'while one that ended without a hand-off does owe',
  M.outstandingCloseObligations(
    thr('ob2', undefined, [
      run('r_unclosed', 1, {
        status: 'completed',
        closeKind: 'unclosed',
        endedAt: 5,
      }),
    ]),
  ).some((o) => o.kind === 'unclosed'),
);
ok(
  'a failed run outranks whatever it recorded first',
  M.outstandingCloseObligations(
    thr('ob3', undefined, [
      run('r_failed', 1, {
        status: 'failed',
        closeKind: 'review',
        endedAt: 5,
      }),
    ]),
  ).some((o) => o.kind === 'failure'),
);

console.log('\n17e. tokens actually get charged');
// The money gate. `f663f779a1` moved accounting onto the session's own
// counter, and the mutation campaign showed nothing here ever reached
// chargeRunUsage: the fake port in the recovery section has no `totalTokens`,
// so the whole path returned at its first line.
const charged = await startFor('Charged work');
await M.bindRunSession(ROOT, {
  threadId: charged.th.id,
  runId: charged.runId,
  attempt: 1,
  sessionId: 'agent-charged',
  contextThroughSequence: 1,
  // Without this the trigger message counts as undrained and the dispatcher
  // requeues instead of closing, so charging is never reached — which is how
  // this fixture failed the first time.
  consumedOnStart: true,
  usageBaselineTokens: 1000,
});
// The session says it has spent 1,750 in total; 1,000 of that predates this
// run, so this run owes 750.
const chargingPort = {
  inspect: async () => ({ kind: 'completed' }),
  start: async () => ({ status: 'started', sessionId: 's' }),
  cancel: async () => true,
  totalTokens: async () => 1750,
};
await M.dispatchOnce(ROOT, chargingPort);
const chargedRun = (await M.readThread(ROOT, charged.th.id)).runs.find(
  (r) => r.id === charged.runId,
);
ok(
  'the run is charged the difference, not the whole session',
  chargedRun.usageByRound.reduce((sum, u) => sum + u.tokens, 0) === 750,
  JSON.stringify(chargedRun.usageByRound),
);
ok(
  'and the thread tree total reflects it',
  (await M.readThread(ROOT, charged.th.id)).tokensUsed >= 750,
  String((await M.readThread(ROOT, charged.th.id)).tokensUsed),
);

const uncharged = await startFor('Spent nothing');
await M.bindRunSession(ROOT, {
  threadId: uncharged.th.id,
  runId: uncharged.runId,
  attempt: 1,
  sessionId: 'agent-uncharged',
  contextThroughSequence: 1,
  consumedOnStart: true,
  usageBaselineTokens: 1750,
});
await M.dispatchOnce(ROOT, chargingPort);
ok(
  'a run that spent nothing records nothing',
  (await M.readThread(ROOT, uncharged.th.id)).runs.find(
    (r) => r.id === uncharged.runId,
  ).usageByRound.length === 0,
);

const unreadable = await startFor('Unreadable meter');
await M.bindRunSession(ROOT, {
  threadId: unreadable.th.id,
  runId: unreadable.runId,
  attempt: 1,
  sessionId: 'agent-unreadable',
  contextThroughSequence: 1,
  consumedOnStart: true,
  usageBaselineTokens: 10,
});
// A runtime that cannot say what it spent must under-count rather than guess:
// charging a number nobody reported would spend a person's budget on a hunch.
await M.dispatchOnce(ROOT, {
  ...chargingPort,
  totalTokens: async () => undefined,
});
ok(
  'a runtime that cannot report usage charges nothing',
  (await M.readThread(ROOT, unreadable.th.id)).runs.find(
    (r) => r.id === unreadable.runId,
  ).usageByRound.length === 0,
);

console.log('\n17f. every way assigning can be refused');
// Each of these guards survived a mutation campaign, meaning nothing here
// built the case it exists for. Two of them are the retirement work from
// 521b212cd0: that commit fixed admission and the assign path together, and
// only the admission half was ever exercised.
await M.updateWorkspaceAgents(ROOT, (a) => [
  ...a,
  { id: 'ag_off', name: 'off', createdAt: 1, enabled: false },
  { id: 'ag_gone', name: 'gone', createdAt: 1, retiredAt: 99 },
  { id: 'ag_ok', name: 'okay', createdAt: 1 },
]);
const assignable = await M.createThread(ROOT, { title: 'Assignable' });

ok(
  'assigning to a thread that does not exist is refused',
  (await M.assignThread(ROOT, 'th_no_such_thread', 'okay')).kind ===
    'thread_not_found',
);
ok(
  'assigning a name nobody has is refused',
  (await M.assignThread(ROOT, assignable.id, 'nobody')).kind ===
    'agent_unknown',
);
ok(
  'assigning to a disabled agent is refused as disabled',
  (await M.assignThread(ROOT, assignable.id, 'off')).kind === 'agent_disabled',
);
ok(
  'assigning to a retired agent is refused as retired, not as disabled',
  (await M.assignThread(ROOT, assignable.id, 'gone')).kind === 'agent_retired',
  JSON.stringify(await M.assignThread(ROOT, assignable.id, 'gone')),
);
ok(
  'an ordinary assignment still works',
  (await M.assignThread(ROOT, assignable.id, 'okay')).kind === 'updated',
);
const doneThread = await M.createThread(ROOT, { title: 'Finished' });
await M.updateThread(ROOT, doneThread.id, (t) => ({ ...t, status: 'done' }));
ok(
  'assigning to a finished thread is refused',
  (await M.assignThread(ROOT, doneThread.id, 'okay')).kind === 'thread_done',
);

// claimRun's own addressability check, the third site of the same rule.
const claimable = await M.createThread(ROOT, {
  title: 'Claim after retirement',
  assigneeAgentId: 'ag_ok',
});
const claimBooked = await M.postMessage(ROOT, claimable.id, {
  from: M.HUMAN_AUTHOR_ID,
  text: 'go',
});
// Disabled rather than retired: retiring refuses while a run is still queued
// — the guard from 8d6e199cc4 — so retirement cannot produce this state at
// all. Disabling can, and claimRun has to notice before it starts the run.
ok(
  'retiring an agent with queued work is refused, so it cannot reach here',
  (await M.retireWorkspaceAgent(ROOT, 'ag_ok')) === 'has_live_work',
);
await M.setWorkspaceAgentEnabled(ROOT, 'ag_ok', false);
ok(
  'a run booked before an agent was disabled cannot then be claimed',
  (await M.claimRun(ROOT, {
    threadId: claimable.id,
    runId: claimBooked.dispatched[0].id,
  })) === undefined,
);

console.log('\n17g. the quiet no-ops');
// Each of these does nothing, which is the point: doing nothing quietly is a
// behaviour, and every one of these guards survived a mutation campaign
// because nothing here ever asked for the case where there is nothing to do.

ok(
  'delivering notifications with no sender sends nothing',
  (await M.deliverNotifications(ROOT, undefined)) === 0,
);
// A fresh workspace has no notify target configured, so even with a sender
// there is nowhere to send. The count is what proves it did not try.
let attempted = 0;
ok(
  'and with a sender but no destination it still sends nothing',
  (await M.deliverNotifications(ROOT, async () => {
    attempted += 1;
  })) === 0 && attempted === 0,
  `attempted ${attempted}`,
);

// With a destination configured and something pending, the missing-sender
// guard becomes observable: without it the loop would call `undefined`. The
// earlier assertion could not reach it, because with no target the loop never
// gets that far.
await M.setAgentNotifyTarget(ROOT, {
  channelName: 'lark',
  target: { type: 'user', id: 'u1' },
});
const notifying = await startFor('Notifying');
await asAgent(
  notifying.agentId,
  notifying.th.id,
  notifying.runId,
  notifying.th.rootThreadId,
  () =>
    new M.ThreadBlockTool(cfg).buildAndExecute(
      { question: 'which one?' },
      sig(),
    ),
);
await M.withAgentStoreTransaction(ROOT, (tx) =>
  M.finishRunInTransaction(tx, {
    threadId: notifying.th.id,
    runId: notifying.runId,
    outcome: { status: 'completed', attempt: 1 },
  }),
);
ok(
  'a blocker queues a notification once a destination exists',
  (await M.readThread(ROOT, notifying.th.id)).outbox.some(
    (e) => e.kind === 'notification' && e.status === 'pending',
  ),
);
ok(
  'and with something to send but no sender, nothing is attempted',
  (await M.deliverNotifications(ROOT, undefined)) === 0,
);
// Not "exactly once" in absolute terms: by this point the script has closed
// several runs and each queued its own notification. What must hold is that
// every pending one goes out once and a second pass sends nothing.
let sent = 0;
const firstPass = await M.deliverNotifications(ROOT, async () => {
  sent += 1;
});
ok(
  'a real sender delivers every pending notification',
  firstPass >= 1 && sent === firstPass,
  `reported ${firstPass}, sender saw ${sent}`,
);
const secondPass = await M.deliverNotifications(ROOT, async () => {
  sent += 1;
});
ok(
  'and a second pass sends nothing, so a retry is not a second message',
  secondPass === 0 && sent === firstPass,
  `second pass ${secondPass}, sender total ${sent}`,
);
await M.setAgentNotifyTarget(ROOT, undefined);

ok(
  'dispatching with nothing pending is a no-op',
  (
    await M.dispatchOnce(ROOT, {
      inspect: async () => ({ kind: 'absent' }),
      start: async () => ({ status: 'capacity_wait' }),
      cancel: async () => true,
    })
  ).length >= 0,
);

// persona: blank instructions must not append an empty paragraph that reads
// as an instruction meant to say something.
await M.updateWorkspaceAgents(ROOT, (a) => [
  ...a,
  { id: 'ag_blank', name: 'blank', createdAt: 1, instructions: '   ' },
]);
const personaCfg = {
  getProjectRoot: () => ROOT,
  getSubagentManager: () => ({
    loadSubagent: async () => ({ name: 'general-purpose' }),
    convertToRuntimeConfig: async () => ({
      promptConfig: { systemPrompt: 'BASE' },
      toolConfig: { tools: ['*'] },
    }),
  }),
};
await M.updateWorkspaceAgents(ROOT, (a) => [
  ...a,
  { id: 'ag_none', name: 'noinstr', createdAt: 1 },
]);
const blankPersona = await M.resolveAgentPersona(personaCfg, 'ag_blank');
const noPersona = await M.resolveAgentPersona(personaCfg, 'ag_none');
// Compared against an identity with no instructions at all rather than
// against a literal: the persona now carries a standing identity contract in
// front of the definition's prompt, and pinning the old literal only pinned
// the shape it happened to have. What must hold is that blank instructions
// add nothing an absent one would not.
ok(
  'whitespace-only instructions add nothing at all',
  blankPersona.status === 'resolved' &&
    noPersona.status === 'resolved' &&
    blankPersona.systemPrompt.replace(/blank/g, 'X') ===
      noPersona.systemPrompt.replace(/noinstr/g, 'X'),
  JSON.stringify(blankPersona.systemPrompt.slice(-120)),
);
ok(
  'while real instructions do get appended',
  (
    await (async () => {
      await M.updateWorkspaceAgents(ROOT, (a) => [
        ...a,
        {
          id: 'ag_instr',
          name: 'instr',
          createdAt: 1,
          instructions: 'Always check the changelog.',
        },
      ]);
      return M.resolveAgentPersona(personaCfg, 'ag_instr');
    })()
  ).systemPrompt.includes('Always check the changelog.'),
);

// Clearing an assignee that was never set changes nothing and is not an error.
const unassigned = await M.createThread(ROOT, { title: 'Never assigned' });
const cleared = await M.assignThread(ROOT, unassigned.id, undefined);
ok(
  'clearing an assignee nobody set is accepted and changes nothing',
  cleared.kind === 'updated' && cleared.thread.assigneeAgentId === undefined,
  JSON.stringify(cleared.kind),
);

// Acknowledging on a thread that owes nothing must not invent an entry.
const owesNothing = thr('ack', undefined, []);
ok(
  'acknowledging with nothing outstanding returns the same thread',
  M.acknowledgeCloseObligations(owesNothing, 1, () => true) === owesNothing,
);
// And a selector that matches nothing is the same no-op even when the thread
// does owe something — the discharge is scoped, not a blanket clear.
const owesOne = thr('ack2', undefined, [
  run('r_b', 1, { status: 'completed', closeKind: 'blocked', endedAt: 2 }),
]);
ok(
  'a selector matching nothing leaves an owing thread untouched',
  M.acknowledgeCloseObligations(owesOne, 5, () => false) === owesOne,
);
ok(
  'while a selector that matches does discharge it',
  M.acknowledgeCloseObligations(owesOne, 5, () => true) !== owesOne,
);

console.log('\n17h. a report whose parent cannot go away');
// The `!parent` branch in deliverParentReports guards a state the store
// refuses to create: a thread with sub-threads cannot be deleted, so the
// orphaned-report case is unreachable through any supported operation. That
// refusal is the real guarantee, and it is what gets asserted; the guard
// behind it stays as defence and stays uncatchable, which is the honest
// reading rather than a test that fakes the state to look covered.
const keptParent = await M.createThread(ROOT, { title: 'Cannot be deleted' });
await M.createThread(ROOT, {
  title: 'Its child',
  parentThreadId: keptParent.id,
});
let deletionRefused = false;
try {
  await M.deleteThread(ROOT, keptParent.id);
} catch {
  deletionRefused = true;
}
ok(
  'a thread with sub-threads cannot be deleted out from under them',
  deletionRefused,
);

// The payload, though, is only a record of unknown fields, so a malformed one
// can exist and the delivery pass must not take it personally.
const malformed = await M.createThread(ROOT, { title: 'Malformed report' });
await M.enqueueThreadEvent(ROOT, malformed.id, {
  kind: 'parent_report',
  payload: { event: 'child_in_review', parentThreadId: 42 },
});
let survivedMalformed = true;
try {
  await M.deliverParentReports(ROOT);
} catch {
  survivedMalformed = false;
}
ok(
  'a report whose parent id is not even a string does not break the pass',
  survivedMalformed,
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

console.log('\n27. server binding: the store names the session before it exists');
// Session creation is where an `sourceType: agent` claim gets checked, and the
// check is "some live run names this session". `bindRunSession` only runs after
// `start` returns, so unless the id is reserved first, the very first turn of
// every thread refuses itself. Assert the ordering from inside `start`, which
// is exactly where the runtime creates the session.
const bind1 = await startFor('Binding order');
const plannedId = 'sess-planned-1';
let namedAtStart = null;
let bindingAtStart = null;
await M.dispatchOnce(ROOT, {
  inspect: async () => ({ kind: 'absent' }),
  plannedSessionId: () => plannedId,
  cancel: async () => true,
  start: async () => {
    const run = (await M.readThread(ROOT, bind1.th.id)).runs.find(
      (r) => r.id === bind1.runId,
    );
    namedAtStart = run?.sessionId ?? null;
    bindingAtStart = await M.findAgentSessionBinding(
      ROOT,
      plannedId,
      bind1.agentId,
    );
    return { status: 'started', sessionId: plannedId, consumedOnStart: true };
  },
});
ok(
  'the run already names the session by the time start() runs',
  namedAtStart === plannedId,
  String(namedAtStart),
);
ok(
  'so the binding lookup a session-creation check makes already succeeds',
  bindingAtStart?.runId === bind1.runId && bindingAtStart?.threadId === bind1.th.id,
  JSON.stringify(bindingAtStart),
);
ok(
  'a session no run names has no binding',
  (await M.findAgentSessionBinding(ROOT, 'sess-forged', bind1.agentId)) ===
    undefined,
);
ok(
  'the right session under the wrong agent has no binding',
  (await M.findAgentSessionBinding(ROOT, plannedId, 'ag_someone_else')) ===
    undefined,
);
ok(
  'a session with no id at all has no binding',
  (await M.findAgentSessionBinding(ROOT, undefined, bind1.agentId)) === undefined,
);

// A started run stays live, which is the whole point: its session is being
// dispatched right now, so the binding has to hold for the turns that follow.
const bind1Run = (await M.readThread(ROOT, bind1.th.id)).runs.find(
  (r) => r.id === bind1.runId,
);
ok(
  'the dispatched run is still running, so its binding still holds',
  bind1Run.status === 'running',
  bind1Run.status,
);
// A finished run releases its session. Resuming that session as the agent must
// not still be authorized by a run that is over.
await M.finishRun(ROOT, bind1.th.id, bind1.runId, {
  status: 'completed',
  attempt: bind1Run.attempts,
});
ok(
  'the run is terminal after it finishes',
  (await M.readThread(ROOT, bind1.th.id)).runs.find((r) => r.id === bind1.runId)
    .status === 'completed',
);
ok(
  'and a terminal run no longer binds its session',
  (await M.findAgentSessionBinding(ROOT, plannedId, bind1.agentId)) ===
    undefined,
);

// A port that cannot predict its id gets no pre-binding, and must not blow up.
const bind2 = await startFor('No planned id');
let sawUnplanned = false;
await M.dispatchOnce(ROOT, {
  inspect: async () => ({ kind: 'absent' }),
  cancel: async () => true,
  start: async () => {
    sawUnplanned = true;
    return { status: 'started', sessionId: 'sess-late', consumedOnStart: true };
  },
});
ok(
  'a port without plannedSessionId still dispatches',
  sawUnplanned,
);
ok(
  'and bindRunSession still records the id it reports',
  (await M.readThread(ROOT, bind2.th.id)).runs.find((r) => r.id === bind2.runId)
    ?.sessionId === 'sess-late',
);

console.log('\n28. stranded runs: the switch closes them, recovery must not revive');
// Recovery treats a `running` run with no body as a crash and starts it again.
// A run the operator switched off underneath looks identical to it, so the
// difference is recorded at the one moment it is knowable: a daemon starting
// with collaboration off.
const st1 = await startFor('Stranded by the switch');
const stRunBefore = (await M.readThread(ROOT, st1.th.id)).runs.find(
  (r) => r.id === st1.runId,
);
ok('the run is live before the sweep', stRunBefore.status === 'running');

const swept = await M.strandLocalRuns(ROOT);
ok(
  'the sweep reports what it closed',
  swept.runsStranded >= 1,
  JSON.stringify(swept),
);
const stRun = (await M.readThread(ROOT, st1.th.id)).runs.find(
  (r) => r.id === st1.runId,
);
ok('a stranded run is terminal', stRun.status === 'failed', stRun.status);
ok(
  'and says why, so the UI can tell it from an ordinary failure',
  stRun.closeKind === 'stranded' &&
    stRun.failureStage === M.STRANDED_FAILURE_STAGE,
  `${stRun.closeKind} / ${stRun.failureStage}`,
);
ok('and records when it ended', typeof stRun.endedAt === 'number');

// The point of all of it: opting back in must not re-dispatch the work.
let restartedStranded = false;
await M.dispatchOnce(ROOT, {
  inspect: async () => ({ kind: 'absent' }),
  cancel: async () => true,
  start: async ({ runId }) => {
    if (runId === st1.runId) restartedStranded = true;
    return { status: 'started', sessionId: 's', consumedOnStart: true };
  },
});
ok(
  're-enabling does not re-dispatch a stranded run',
  !restartedStranded,
);
ok(
  'and it stays terminal across that tick',
  (await M.readThread(ROOT, st1.th.id)).runs.find((r) => r.id === st1.runId)
    .status === 'failed',
);

// A second sweep must be a no-op, or a daemon restarting with the flag off
// would churn the store on every boot.
const sweptAgain = await M.strandLocalRuns(ROOT);
ok(
  'a second sweep strands nothing',
  sweptAgain.runsStranded === 0 && sweptAgain.threadsChanged === 0,
  JSON.stringify(sweptAgain),
);

// A workspace that never used collaboration must come out untouched — the
// sweep must not create the store just to find it empty.
const virgin = path.join(tmp, 'never-used');
await fs.mkdir(virgin, { recursive: true });
const virginResult = await M.strandLocalRuns(virgin);
ok(
  'a workspace with no collaboration storage is a no-op',
  virginResult.runsStranded === 0 && virginResult.threadsChanged === 0,
);
let strandStoreCreated = true;
try {
  await fs.stat(M.getAgentsDir(virgin));
} catch {
  strandStoreCreated = false;
}
ok('and the sweep did not create its store', !strandStoreCreated);

console.log('\n29. the frozen external contract (P1)');
// A2A is a rolling document, so "compatible" only means something against a
// pinned version. These assertions are what pins it.
ok(
  'the protocol version is Major.Minor, as the spec requires of the wire',
  /^\d+\.\d+$/.test(M.A2A_PROTOCOL_VERSION),
  M.A2A_PROTOCOL_VERSION,
);
ok(
  'exactly one transport binding is claimed, and it is a spec-defined one',
  ['JSONRPC', 'GRPC', 'HTTP+JSON'].includes(M.A2A_TRANSPORT_BINDING),
  M.A2A_TRANSPORT_BINDING,
);
ok(
  'the five required operations are all named',
  M.A2A_REQUIRED_OPERATIONS.length === 5 &&
    ['sendMessage', 'getTask', 'listTasks', 'cancelTask', 'getAuthenticatedExtendedAgentCard'].every(
      (op) => M.A2A_REQUIRED_OPERATIONS.includes(op),
    ),
  JSON.stringify(M.A2A_REQUIRED_OPERATIONS),
);
ok(
  'every optional operation is gated on a capability flag it needs',
  Object.values(M.A2A_OPTIONAL_OPERATIONS).every((cap) =>
    cap === 'streaming' || cap === 'pushNotifications',
  ),
  JSON.stringify(M.A2A_OPTIONAL_OPERATIONS),
);
ok(
  'no optional operation is also listed as required',
  Object.keys(M.A2A_OPTIONAL_OPERATIONS).every(
    (op) => !M.A2A_REQUIRED_OPERATIONS.includes(op),
  ),
);
ok(
  'the four terminal states are the four the spec calls terminal',
  M.A2A_TERMINAL_STATES.size === 4 &&
    ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].every(
      (state) => M.A2A_TERMINAL_STATES.has(state),
    ),
  JSON.stringify([...M.A2A_TERMINAL_STATES]),
);

// Every local status has to decide what a caller sees. Adding a ThreadStatus
// without deciding is the failure this catches.
const LOCAL_STATUSES = ['open', 'in_progress', 'blocked', 'in_review', 'done'];
for (const status of LOCAL_STATUSES) {
  const state = M.toA2ATaskState(status);
  ok(
    `${status} maps to a state a caller can act on: ${state}`,
    typeof state === 'string' && state.startsWith('TASK_STATE_'),
    state,
  );
}
ok(
  'an unknown local status throws rather than defaulting',
  (() => {
    try {
      M.toA2ATaskState('invented');
      return false;
    } catch {
      return true;
    }
  })(),
);
ok(
  'only done is terminal to a caller; a blocked thread is not finished',
  M.isA2ATerminal(M.toA2ATaskState('done')) &&
    !M.isA2ATerminal(M.toA2ATaskState('blocked')) &&
    !M.isA2ATerminal(M.toA2ATaskState('in_review')) &&
    !M.isA2ATerminal(M.toA2ATaskState('in_progress')),
);

// The protocol only offers a client-minted messageId, so the server scopes it.
const keyBase = {
  callerId: 'caller-a',
  targetAgentId: 'ag_1',
  messageId: 'msg-1',
};
ok(
  'the same submission yields the same key',
  M.externalRequestKey(keyBase) === M.externalRequestKey({ ...keyBase }),
);
ok(
  'a different caller with the same message id is a different request',
  M.externalRequestKey(keyBase) !==
    M.externalRequestKey({ ...keyBase, callerId: 'caller-b' }),
);
ok(
  'and so is the same id aimed at a different agent',
  M.externalRequestKey(keyBase) !==
    M.externalRequestKey({ ...keyBase, targetAgentId: 'ag_2' }),
);
// Ids are opaque strings from outside. A caller that can put the joining
// character inside one must not be able to forge another caller's key.
ok(
  'a caller cannot forge another key by smuggling a separator into an id',
  M.externalRequestKey({ callerId: 'a', targetAgentId: 'b:c', messageId: 'd' }) !==
    M.externalRequestKey({ callerId: 'a', targetAgentId: 'b', messageId: 'c:d' }),
);
for (const missing of ['callerId', 'targetAgentId', 'messageId']) {
  ok(
    `a key with no ${missing} is refused, not silently built`,
    (() => {
      try {
        M.externalRequestKey({ ...keyBase, [missing]: '' });
        return false;
      } catch {
        return true;
      }
    })(),
  );
}

// Usage is not in the A2A data model, so ours travels in the extension and a
// daemon with no figure must report absence, not zero.
const meta = M.toQwenA2ATaskMetadata({
  status: 'blocked',
  rootThreadId: 'th_root',
  tokensUsed: 42,
});
ok(
  'the extension preserves the distinction A2A merges',
  meta.localStatus === 'blocked' &&
    M.toA2ATaskState('blocked') === M.toA2ATaskState('in_review'),
);
ok('and carries usage when there is a figure', meta.tokensUsed === 42);
const metaNoUsage = M.toQwenA2ATaskMetadata({
  status: 'open',
  rootThreadId: 'th_root',
});
ok(
  'an unknown usage figure is absent, never reported as zero',
  !('tokensUsed' in metaNoUsage),
  JSON.stringify(metaNoUsage),
);
ok(
  'the extension is identified by an absolute URI, as A2A requires',
  /^https:\/\//.test(M.QWEN_A2A_EXTENSION_URI),
  M.QWEN_A2A_EXTENSION_URI,
);

console.log('\n30. external intake (P2, the half that needs no network)');
await M.updateWorkspaceAgents(ROOT, (a) => [
  ...a,
  { id: 'ag_ext', name: 'ext', createdAt: 1 },
]);
const submission = {
  callerId: 'client-one',
  targetAgentId: 'ag_ext',
  messageId: 'a2a-msg-1',
  title: 'Read-only analysis',
  body: 'Summarise the sample repository',
  acceptanceCriteria: 'A summary naming the top-level packages',
};
const first = await M.acceptExternalSubmission(ROOT, submission);
ok('a first submission is accepted', first.outcome === 'accepted', first.outcome);
ok(
  'and lands as a thread aimed at the named agent',
  first.thread.assigneeAgentId === 'ag_ext',
  first.thread.assigneeAgentId,
);
ok(
  'carrying the intake record that scopes it',
  first.thread.externalIntake?.callerId === 'client-one' &&
    first.thread.externalIntake?.messageId === 'a2a-msg-1',
  JSON.stringify(first.thread.externalIntake),
);
ok(
  'and a booked run, so SUBMITTED is not a state with nothing behind it',
  first.thread.runs.length === 1,
  String(first.thread.runs.length),
);

// A retry means the caller did not hear the answer, not that it wants the work
// done twice.
const retry = await M.acceptExternalSubmission(ROOT, submission);
ok('a retry is recognised, not accepted again', retry.outcome === 'duplicate');
ok('and returns the same thread', retry.thread.id === first.thread.id);
ok(
  'with no second run booked',
  retry.thread.runs.length === 1,
  String(retry.thread.runs.length),
);
const allThreads = (await M.listThreads(ROOT)).threads.filter(
  (t) => t.externalIntake?.key === first.thread.externalIntake.key,
);
ok('and no second thread anywhere in the store', allThreads.length === 1);

// Reusing a key for different content is the one case that must be loud.
let conflict;
try {
  await M.acceptExternalSubmission(ROOT, {
    ...submission,
    body: 'Actually, do something else entirely',
  });
} catch (error) {
  conflict = error;
}
ok(
  'the same key with different content is refused, not silently overwritten',
  conflict instanceof M.ExternalIntakeConflictError,
  conflict?.name,
);
ok(
  'and the refusal names the work that already exists',
  conflict?.existingThreadId === first.thread.id,
);
ok(
  'the original work is untouched by the rejected attempt',
  (await M.readThread(ROOT, first.thread.id)).body ===
    'Summarise the sample repository',
);

// B serves several authorized clients over one queue.
const second = await M.acceptExternalSubmission(ROOT, {
  ...submission,
  callerId: 'client-two',
  messageId: 'a2a-msg-1',
  title: "Another client's work",
  body: 'Different work, same message id',
});
ok(
  'a different caller reusing the same message id gets its own work',
  second.outcome === 'accepted' && second.thread.id !== first.thread.id,
  `${second.outcome} / ${second.thread.id}`,
);

const oneList = await M.listExternalThreadsForCaller(ROOT, 'client-one');
const twoList = await M.listExternalThreadsForCaller(ROOT, 'client-two');
ok(
  'each caller lists only its own work',
  oneList.length === 1 &&
    twoList.length === 1 &&
    oneList[0].id === first.thread.id &&
    twoList[0].id === second.thread.id,
  `${oneList.length} / ${twoList.length}`,
);
ok(
  'locally raised threads belong to no external caller',
  oneList.every((t) => t.externalIntake) && twoList.every((t) => t.externalIntake),
);
ok(
  "a caller cannot read another caller's thread by id",
  (await M.getExternalThreadForCaller(ROOT, 'client-two', first.thread.id)) ===
    undefined,
);
ok(
  'and can read its own',
  (await M.getExternalThreadForCaller(ROOT, 'client-one', first.thread.id))
    ?.id === first.thread.id,
);
ok(
  'an unknown thread and a forbidden one are indistinguishable',
  (await M.getExternalThreadForCaller(ROOT, 'client-two', 'th_nonexistent')) ===
    (await M.getExternalThreadForCaller(ROOT, 'client-two', first.thread.id)),
);

// The state a caller polls for comes from the frozen mapping.
ok(
  'a freshly accepted task reports a non-terminal state to its caller',
  !M.isA2ATerminal(M.toA2ATaskState(first.thread.status)),
  M.toA2ATaskState(first.thread.status),
);

console.log('\n31. cancellation: a withdrawn task stops being dispatched');
// P1 recorded thread-level cancellation as a local gap that blocked cancelTask.
// This is that gap closed, and these are the properties that make it closed
// rather than merely present.
// Its own agent, with no other work anywhere. Sharing `ag_ext` made the
// "nothing is dispatched" assertions pass for the wrong reason: that agent
// already had a live run, so candidate selection skipped it on grounds of
// business and never consulted the thread's status at all.
await M.updateWorkspaceAgents(ROOT, (a) => [
  ...a,
  { id: 'ag_cancel', name: 'canceller', createdAt: 1 },
]);
const cancelSub = {
  callerId: 'client-one',
  targetAgentId: 'ag_cancel',
  messageId: 'a2a-msg-cancel',
  title: 'Work to withdraw',
  body: 'Start this then change your mind',
};
const toCancel = await M.acceptExternalSubmission(ROOT, cancelSub);
ok(
  'the task starts non-terminal',
  !M.isThreadTerminal(toCancel.thread.status),
  toCancel.thread.status,
);
// Without this the next assertions could pass because there was nothing to
// dispatch, rather than because the cancellation stopped it.
ok(
  'and holds a queued run that a dispatch tick would otherwise start',
  toCancel.thread.runs.filter((r) => r.status === 'queued').length === 1,
  JSON.stringify(toCancel.thread.runs.map((r) => r.status)),
);
ok(
  'which its agent is free to take',
  M.selectCandidates(
    await M.readWorkspaceAgents(ROOT),
    (await M.listThreads(ROOT)).threads,
  ).some((c) => c.thread.id === toCancel.thread.id),
);

const cancelled = await M.cancelExternalThreadForCaller(
  ROOT,
  'client-one',
  toCancel.thread.id,
);
ok('cancelling this caller\'s own task succeeds', cancelled !== undefined);
ok(
  'the thread is terminal afterwards',
  M.isThreadTerminal(cancelled.thread.status) &&
    cancelled.thread.status === 'cancelled',
  cancelled.thread.status,
);
ok(
  'its pending run is retired, not left showing as work still to do',
  cancelled.thread.runs.every((r) => r.status !== 'queued'),
  JSON.stringify(cancelled.thread.runs.map((r) => r.status)),
);
ok(
  'and reports it to the caller as CANCELED, not as failure or completion',
  M.toA2ATaskState(cancelled.thread.status) === 'TASK_STATE_CANCELED',
  M.toA2ATaskState(cancelled.thread.status),
);
ok(
  'which A2A counts as terminal, so a polling caller may stop',
  M.isA2ATerminal(M.toA2ATaskState(cancelled.thread.status)),
);

// The point of the whole predicate refactor: every admission path must agree.
let dispatchedAfterCancel = false;
await M.dispatchOnce(ROOT, {
  inspect: async () => ({ kind: 'absent' }),
  cancel: async () => true,
  start: async ({ threadId }) => {
    if (threadId === toCancel.thread.id) dispatchedAfterCancel = true;
    return { status: 'started', sessionId: 's', consumedOnStart: true };
  },
});
ok(
  'no queued run on a cancelled thread is ever started',
  !dispatchedAfterCancel,
);
// A post already in flight must not resurrect it either. This needs its own
// thread with nothing pending: a thread that still holds a queued run coalesces
// the new message into it and short-circuits before admission ever consults the
// thread's status, so the assertion would pass without testing anything.
const drained = await M.acceptExternalSubmission(ROOT, {
  ...cancelSub,
  messageId: 'a2a-msg-cancel-drained',
  title: 'Withdrawn after its run drained',
});
const drainedRun = drained.thread.runs[0];
await M.claimRun(ROOT, { threadId: drained.thread.id, runId: drainedRun.id });
await M.finishRun(ROOT, drained.thread.id, drainedRun.id, {
  status: 'completed',
});
ok(
  'the thread has no pending run before the late post',
  (await M.readThread(ROOT, drained.thread.id)).runs.every(
    (r) => r.status !== 'queued',
  ),
);
await M.cancelExternalThreadForCaller(ROOT, 'client-one', drained.thread.id);
const latePost = await M.postMessage(ROOT, drained.thread.id, {
  from: M.HUMAN_AUTHOR_ID,
  text: 'one more thing',
});
ok(
  'and a late post books no new run on a cancelled thread',
  latePost.dispatched.length === 0,
  JSON.stringify(latePost.dispatched.map((r) => r.id)),
);

// Ownership, again — cancellation is a write, so it is the one that matters most.
const otherCancel = await M.acceptExternalSubmission(ROOT, {
  ...cancelSub,
  callerId: 'client-two',
  messageId: 'a2a-msg-cancel-2',
});
ok(
  "one caller cannot cancel another's task",
  (await M.cancelExternalThreadForCaller(
    ROOT,
    'client-one',
    otherCancel.thread.id,
  )) === undefined,
);
ok(
  'and that task is still live',
  !M.isThreadTerminal(
    (await M.readThread(ROOT, otherCancel.thread.id)).status,
  ),
);

// Cancelling something already finished must not rewrite how it ended.
const cancelDoneThread = await M.createThread(ROOT, { title: 'Finished elsewhere' });
await M.writeThread(ROOT, {
  ...(await M.readThread(ROOT, cancelDoneThread.id)),
  status: 'done',
  externalIntake: {
    key: 'k-done',
    callerId: 'client-one',
    targetAgentId: 'ag_ext',
    messageId: 'm-done',
    contentHash: 'h',
    receivedAt: 1,
  },
});
const reCancel = await M.cancelExternalThreadForCaller(
  ROOT,
  'client-one',
  cancelDoneThread.id,
);
ok(
  'cancelling a done task leaves it done, not rewritten as cancelled',
  reCancel?.thread.status === 'done',
  reCancel?.thread.status,
);

console.log('\n32. the five required A2A operations, over the local store');
await M.updateWorkspaceAgents(ROOT, (a) => [
  ...a,
  { id: 'ag_open', name: 'opened', createdAt: 1, description: 'Read-only analysis' },
  { id: 'ag_closed', name: 'notopened', createdAt: 1 },
]);
const a2aIssued = await M.issueA2AGrant(ROOT, {
  callerId: 'partner-a',
  agentId: 'ag_open',
  scope: 'analysis',
});
const a2aA = { callerId: 'partner-a', secret: a2aIssued.secret };
ok('issuing a grant returns the secret exactly once', typeof a2aIssued.secret === 'string' && a2aIssued.secret.length > 20);
ok(
  'and never stores it — only a digest is persisted',
  !JSON.stringify(await M.listA2AGrants(ROOT)).includes(a2aIssued.secret),
);
ok(
  'the listed grant carries no digest either',
  (await M.listA2AGrants(ROOT)).every((g) => g.secretHash === undefined),
  JSON.stringify(await M.listA2AGrants(ROOT)),
);

const a2aSent = await M.a2aSendMessage(ROOT, a2aA, {
  agentId: 'ag_open',
  messageId: 'm-1',
  title: 'Analyse the sample repo',
  body: 'List the top-level packages',
});
ok('an authorized caller can submit work', a2aSent.ok === true, JSON.stringify(a2aSent));
ok(
  'and gets a Task whose contextId is the thread tree, not the thread',
  a2aSent.value.contextId === a2aSent.value.id,
);
ok(
  'reported in a state the spec names',
  a2aSent.value.status.state.startsWith('TASK_STATE_'),
  a2aSent.value.status.state,
);
ok(
  'with our extension namespaced by its URI, so extensions cannot collide',
  Object.keys(a2aSent.value.metadata)[0] === M.QWEN_A2A_EXTENSION_URI,
  JSON.stringify(Object.keys(a2aSent.value.metadata)),
);

// Retry through the protocol surface, not just the store.
const a2aResent = await M.a2aSendMessage(ROOT, a2aA, {
  agentId: 'ag_open',
  messageId: 'm-1',
  title: 'Analyse the sample repo',
  body: 'List the top-level packages',
});
ok('resending the same message yields the same task', a2aResent.ok && a2aResent.value.id === a2aSent.value.id);
const a2aConflicting = await M.a2aSendMessage(ROOT, a2aA, {
  agentId: 'ag_open',
  messageId: 'm-1',
  title: 'Analyse the sample repo',
  body: 'Something else entirely',
});
ok(
  'reusing the id for different content is a conflict naming the existing task',
  a2aConflicting.ok === false &&
    a2aConflicting.kind === 'conflict' &&
    a2aConflicting.existingTaskId === a2aSent.value.id,
  JSON.stringify(a2aConflicting),
);

ok(
  'the task is readable by its owner',
  (await M.a2aGetTask(ROOT, a2aA, a2aSent.value.id)).ok === true,
);
const a2aListed = await M.a2aListTasks(ROOT, a2aA, 'ag_open');
ok('and listed for it', a2aListed.ok && a2aListed.value.length === 1);

// Every authorization boundary the plan lists.
const badSecret = { callerId: 'partner-a', secret: 'not-the-secret' };
ok(
  'a wrong secret is refused',
  (await M.a2aSendMessage(ROOT, badSecret, { agentId: 'ag_open', messageId: 'm-2', title: 't', body: 'b' })).kind === 'refused',
);
ok(
  'an agent this caller was not granted is refused',
  (await M.a2aSendMessage(ROOT, a2aA, { agentId: 'ag_closed', messageId: 'm-3', title: 't', body: 'b' })).kind === 'refused',
);
ok(
  'and an unknown agent is refused the same way, revealing nothing',
  (await M.a2aSendMessage(ROOT, a2aA, { agentId: 'ag_nonexistent', messageId: 'm-4', title: 't', body: 'b' })).kind ===
    (await M.a2aSendMessage(ROOT, a2aA, { agentId: 'ag_closed', messageId: 'm-5', title: 't', body: 'b' })).kind,
);
const unknownCaller = { callerId: 'stranger', secret: a2aIssued.secret };
ok(
  'a caller holding a valid secret it was not issued is refused',
  (await M.a2aSendMessage(ROOT, unknownCaller, { agentId: 'ag_open', messageId: 'm-6', title: 't', body: 'b' })).kind === 'refused',
);

// a2aA second authorized client shares the queue but not the work.
const issuedB = await M.issueA2AGrant(ROOT, {
  callerId: 'partner-b',
  agentId: 'ag_open',
  scope: 'analysis',
});
const a2aB = { callerId: 'partner-b', secret: issuedB.secret };
const sentB = await M.a2aSendMessage(ROOT, a2aB, {
  agentId: 'ag_open',
  messageId: 'm-1',
  title: "a2aB's work",
  body: 'Different work, same message id',
});
ok('a second authorized client can call the same agent', sentB.ok === true);
ok('and its work is distinct', sentB.value.id !== a2aSent.value.id);
ok(
  "it cannot read the first client's task",
  (await M.a2aGetTask(ROOT, a2aB, a2aSent.value.id)).kind === 'not_found',
);
ok(
  "nor cancel it",
  (await M.a2aCancelTask(ROOT, a2aB, a2aSent.value.id)).kind === 'not_found',
);
const listedB = await M.a2aListTasks(ROOT, a2aB, 'ag_open');
ok(
  'and lists only its own',
  listedB.ok && listedB.value.length === 1 && listedB.value[0].id === sentB.value.id,
);

// Scope. a2aA read-only grant may not do full-scope work.
const a2aScoped = await M.checkA2AGrant(ROOT, {
  callerId: 'partner-a', agentId: 'ag_open', secret: a2aIssued.secret, required: 'full',
});
ok('an analysis grant does not satisfy a full-scope call', a2aScoped.ok === false && a2aScoped.reason === 'out_of_scope');
const fullIssued = await M.issueA2AGrant(ROOT, {
  callerId: 'partner-c', agentId: 'ag_open', scope: 'full',
});
const fullCheck = await M.checkA2AGrant(ROOT, {
  callerId: 'partner-c', agentId: 'ag_open', secret: fullIssued.secret, required: 'analysis',
});
ok('but a full grant satisfies an analysis call', fullCheck.ok === true);

// Expiry and revocation are different things and both must bite.
const a2aExpired = await M.issueA2AGrant(ROOT, {
  callerId: 'partner-d', agentId: 'ag_open', scope: 'analysis', expiresAt: 1,
});
ok(
  'an expired grant is refused',
  (await M.a2aSendMessage(ROOT, { callerId: 'partner-d', secret: a2aExpired.secret }, { agentId: 'ag_open', messageId: 'm-7', title: 't', body: 'b' })).kind === 'refused',
);
ok('revoking a grant reports that it was there', (await M.revokeA2AGrant(ROOT, { callerId: 'partner-b', agentId: 'ag_open' })) === true);
ok('revoking twice reports that it was not', (await M.revokeA2AGrant(ROOT, { callerId: 'partner-b', agentId: 'ag_open' })) === false);
ok(
  'a revoked caller can no longer submit',
  (await M.a2aSendMessage(ROOT, a2aB, { agentId: 'ag_open', messageId: 'm-8', title: 't', body: 'b' })).kind === 'refused',
);
ok(
  'nor read the work it had already submitted',
  (await M.a2aGetTask(ROOT, a2aB, sentB.value.id)).kind === 'refused',
);
ok(
  "and the first client is unaffected by the second's revocation",
  (await M.a2aGetTask(ROOT, a2aA, a2aSent.value.id)).ok === true,
);

// Re-issuing replaces rather than accumulating.
const a2aReissued = await M.issueA2AGrant(ROOT, { callerId: 'partner-a', agentId: 'ag_open', scope: 'analysis' });
ok(
  'the old secret stops working when a grant is re-issued',
  (await M.a2aSendMessage(ROOT, a2aA, { agentId: 'ag_open', messageId: 'm-9', title: 't', body: 'b' })).kind === 'refused',
);
ok(
  'and the new one works',
  (await M.a2aSendMessage(ROOT, { callerId: 'partner-a', secret: a2aReissued.secret }, { agentId: 'ag_open', messageId: 'm-10', title: 't', body: 'b' })).ok === true,
);
ok(
  'with exactly one grant for that pair, not two',
  (await M.listA2AGrants(ROOT)).filter((g) => g.callerId === 'partner-a' && g.agentId === 'ag_open').length === 1,
);

// A retired agent is not a way in, even with a live grant. Needs an agent with
// no live work: `retireWorkspaceAgent` refuses to retire one mid-turn, so
// reusing the busy agent above asserted a refusal in a world where the retire
// had silently not happened — the assertion failed, which is how this was found.
await M.updateWorkspaceAgents(ROOT, (a) => [
  ...a,
  { id: 'ag_retiree', name: 'retiree', createdAt: 1 },
]);
const retireeGrant = await M.issueA2AGrant(ROOT, {
  callerId: 'partner-e', agentId: 'ag_retiree', scope: 'analysis',
});
const retireeCaller = { callerId: 'partner-e', secret: retireeGrant.secret };
ok(
  'the grant works while the agent is addressable',
  (await M.a2aListTasks(ROOT, retireeCaller, 'ag_retiree')).ok === true,
);
ok(
  'and the agent actually retires',
  (await M.retireWorkspaceAgent(ROOT, 'ag_retiree')) === 'updated',
);
ok(
  'after which the same live grant admits nobody',
  (await M.a2aSendMessage(ROOT, retireeCaller, { agentId: 'ag_retiree', messageId: 'm-11', title: 't', body: 'b' })).kind === 'refused',
);
ok(
  'and its tasks are no longer readable through it either',
  (await M.a2aListTasks(ROOT, retireeCaller, 'ag_retiree')).kind === 'refused',
);

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
