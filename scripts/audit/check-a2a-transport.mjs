#!/usr/bin/env node
/**
 * Drives the A2A transport over real HTTP.
 *
 * Usage: node scripts/audit/check-a2a-transport.mjs
 *
 * `routes/a2a.ts` exports one function that mounts routes on an Express app,
 * so the honest way to check it is to mount them and make requests — testing
 * its internals would test a shape nobody speaks. There is no daemon and no
 * model: a fake workspace registry points at a temp project root, and the
 * store underneath is the real one.
 *
 * What this is for is the part a JSON-RPC layer can quietly get wrong. The
 * operations beneath it are covered by run-workspace-agents.mjs; what is not
 * covered there is whether the transport preserves their answers — most of all
 * that four different authorisation failures still reach a caller as one
 * undifferentiated refusal, because a caller that can tell them apart can
 * enumerate this daemon's agents.
 *
 * Skips with exit 0 when `@a2a-js/sdk` cannot be resolved, so a checkout that
 * has not run `npm install` reports honestly instead of failing for the wrong
 * reason. Resolution is left to Node rather than aliased: the package publishes
 * an `exports` map, and rewriting `@a2a-js/sdk/server/express` to a directory
 * path bypasses it and resolves nothing.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

const sdkInstalled = [
  path.join(repo, 'node_modules/@a2a-js/sdk'),
  path.join(repo, 'packages/cli/node_modules/@a2a-js/sdk'),
].some((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
if (!sdkInstalled) {
  console.log('@a2a-js/sdk is not installed; skipping. Run npm install first.');
  process.exit(0);
}

// Inside the repo's node_modules, not the system temp dir: esbuild resolves
// bare imports relative to the importing file, so an entry outside the tree
// cannot find `express` or the SDK. node_modules is already ignored by git.
const scratchRoot = path.join(repo, 'node_modules', '.qwen-audit');
await fsp.mkdir(scratchRoot, { recursive: true });
const tmp = await fsp.mkdtemp(path.join(scratchRoot, 'a2a-'));
const entry = path.join(tmp, 'entry.ts');
const bundle = path.join(tmp, 'bundle.mjs');
const src = 'packages/core/src/agents/workspace-agents';

await fsp.writeFile(
  entry,
  `export { registerA2ATransportRoutes } from '${repo}/packages/cli/src/serve/routes/a2a.js';
export { issueA2AGrant } from '${repo}/${src}/a2a-grants.js';
export { updateWorkspaceAgents, readAgentWorkspace, listThreads } from '${repo}/${src}/store.js';
export { QWEN_A2A_EXTENSION_URI } from '${repo}/${src}/a2a-contract.js';
// Exported from the same bundle so the app the routes are mounted on is the
// very instance they were built against, rather than a second copy of express.
export { default as express } from 'express';
`,
);
execFileSync(
  path.join(repo, 'node_modules/.bin/esbuild'),
  [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node22',
    `--outfile=${bundle}`,
    '--log-level=error',
    '--loader:.wasm=empty',
    // A workspace install can leave a dependency symlinked outside the tree.
    // Without this esbuild follows the link and then resolves that package's
    // own imports from wherever it really lives, where node_modules is absent.
    '--preserve-symlinks',
    '--external:tree-sitter-wasms',
    '--external:@lydell/node-pty',
    '--external:sharp',
    `--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);`,
  ],
  { cwd: repo, stdio: ['ignore', 'inherit', 'inherit'] },
);

const M = await import(bundle);
const express = M.express;

// The SDK logs every error it answers, and most of the errors below are ones
// this script provokes on purpose. Left alone they bury the assertions in
// stack traces of refusals that are the expected result. Restored before exit
// so a genuine crash is still visible.
const realConsoleError = console.error;
console.error = () => {};
process.on('exit', () => {
  console.error = realConsoleError;
});

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? `  → ${detail}` : ''}`);
  }
};

const projectRoot = path.join(tmp, 'workspace');
await fsp.mkdir(projectRoot, { recursive: true });

// The registry is faked down to what the routes actually read: an id, a cwd,
// and whether the workspace is trusted. Everything below it is the real store.
const workspace = await M.readAgentWorkspace(projectRoot);
const registry = {
  listAll: () => [
    {
      workspaceId: workspace.workspaceId,
      workspaceCwd: projectRoot,
      primary: true,
      trusted: true,
    },
  ],
};

await M.updateWorkspaceAgents(projectRoot, (agents) => [
  ...agents,
  { id: 'ag_open', name: 'opened', createdAt: 1, description: 'Read-only' },
  { id: 'ag_secret', name: 'notopened', createdAt: 1 },
]);
const grantA = await M.issueA2AGrant(projectRoot, {
  callerId: 'partner-a',
  agentId: 'ag_open',
  scope: 'analysis',
});
const grantB = await M.issueA2AGrant(projectRoot, {
  callerId: 'partner-b',
  agentId: 'ag_open',
  scope: 'analysis',
});

const app = express();
M.registerA2ATransportRoutes(app, registry);
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const rpc = async (method, params, auth, version = '1.0') => {
  const response = await fetch(`${origin}/a2a/v1`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Without this the SDK assumes the legacy 0.3 wire version and refuses
      // everything with one code — which silently turned the "all refusals look
      // alike" assertion below green for entirely the wrong reason.
      'a2a-version': version,
      ...(auth
        ? {
            authorization: `Bearer ${auth.secret}`,
            'x-qwen-workspace-id': auth.workspaceId ?? workspace.workspaceId,
            'x-qwen-caller-id': auth.callerId,
            'x-qwen-agent-id': auth.agentId,
          }
        : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
};
const message = (messageId, text) => ({
  message: { messageId, role: 'ROLE_USER', parts: [{ text }] },
});
const message0 = () => message('m-version', 'probe');
const asA = { callerId: 'partner-a', agentId: 'ag_open', secret: grantA.secret };
const asB = { callerId: 'partner-b', agentId: 'ag_open', secret: grantB.secret };

console.log('1. the public card is for discovery, not enumeration');
const cardResponse = await fetch(`${origin}/.well-known/agent-card.json`);
const card = await cardResponse.json();
ok('it is served', cardResponse.status === 200, String(cardResponse.status));
ok(
  'as application/a2a+json',
  (cardResponse.headers.get('content-type') ?? '').includes(
    'application/a2a+json',
  ),
  cardResponse.headers.get('content-type') ?? '',
);
ok(
  'carrying the protocol version in the header the spec names',
  cardResponse.headers.get('a2a-version') === '1.0',
  cardResponse.headers.get('a2a-version') ?? '',
);
ok(
  // Absent, not `[]`: the card is serialised through protobuf `toJSON`, which
  // omits empty repeated fields. Both mean the same thing to a reader.
  'and it lists no agents — anyone may fetch it',
  (card.skills ?? []).length === 0,
  JSON.stringify(card.skills),
);
ok(
  'no agent name appears anywhere in it',
  !JSON.stringify(card).includes('opened'),
);
ok(
  'streaming and push notifications are advertised off, because they are off',
  card.capabilities?.streaming !== true &&
    card.capabilities?.pushNotifications !== true,
  JSON.stringify(card.capabilities),
);

console.log('\n2. the version this daemon speaks is the one it froze');
const wrongVersion = await rpc('SendMessage', message0(), asA, '0.3');
ok(
  'a caller on the legacy wire version is refused',
  wrongVersion.body.error !== undefined,
  JSON.stringify(wrongVersion.body).slice(0, 140),
);
ok(
  'and told which version to use, rather than left guessing',
  JSON.stringify(wrongVersion.body).includes('1.0'),
);

console.log('\n3. every authorisation failure is one answer');
// Every one sends a well-formed request, so the ONLY difference between them
// is authorisation. Sending `{}` for the unauthenticated case failed parameter
// validation before it reached auth, which produced a different code and made
// this section report a leak that was not there.
const probe = message('m-refused', 'probe');
const refusals = [
  ['no credentials at all', await rpc('SendMessage', probe, undefined)],
  [
    'a wrong secret',
    await rpc('SendMessage', probe, { ...asA, secret: 'x'.repeat(40) }),
  ],
  [
    'an agent this caller was not granted',
    await rpc('SendMessage', probe, { ...asA, agentId: 'ag_secret' }),
  ],
  [
    'an agent that does not exist',
    await rpc('SendMessage', probe, { ...asA, agentId: 'ag_nope' }),
  ],
  [
    "another caller's identity",
    await rpc('SendMessage', probe, { ...asA, callerId: 'stranger' }),
  ],
  [
    'an unknown workspace',
    await rpc('SendMessage', probe, { ...asA, workspaceId: 'ws_nope' }),
  ],
];
for (const [label, response] of refusals) {
  ok(`${label} is refused`, response.body.error !== undefined, JSON.stringify(response.body).slice(0, 120));
}
const codes = new Set(refusals.map(([, r]) => r.body.error?.code));
ok(
  'and all of them answer with the same code, revealing nothing',
  codes.size === 1,
  JSON.stringify([...codes]),
);
const messages = new Set(refusals.map(([, r]) => r.body.error?.message));
ok(
  'with the same message, too',
  messages.size === 1,
  JSON.stringify([...messages]),
);

console.log('\n4. work goes in and comes back');
const sent = await rpc('SendMessage', message('m-1', 'Summarise it'), asA);
const task = sent.body.result?.task ?? sent.body.result;
ok('an authorized caller submits work', sent.body.error === undefined, JSON.stringify(sent.body).slice(0, 200));
ok(
  'and gets a task back',
  typeof task?.id === 'string',
  JSON.stringify(sent.body).slice(0, 200),
);
ok(
  'in a state the spec names',
  typeof task?.status?.state === 'string' &&
    task.status.state.startsWith('TASK_STATE_'),
  JSON.stringify(task?.status),
);
ok(
  'with our extension under its own URI',
  Object.keys(task?.metadata ?? {}).includes(M.QWEN_A2A_EXTENSION_URI),
  JSON.stringify(Object.keys(task?.metadata ?? {})),
);

const resent = await rpc('SendMessage', message('m-1', 'Summarise it'), asA);
const resentTask = resent.body.result?.task ?? resent.body.result;
ok(
  'resending the same message id yields the same task, not a second one',
  resentTask?.id === task?.id,
  `${resentTask?.id} vs ${task?.id}`,
);
const threadsNow = (await M.listThreads(projectRoot)).threads;
ok(
  'and the store holds one piece of work, not two',
  threadsNow.filter((t) => t.externalIntake?.messageId === 'm-1' && t.externalIntake?.callerId === 'partner-a').length === 1,
);

const conflicting = await rpc(
  'SendMessage',
  message('m-1', 'Actually do something else'),
  asA,
);
ok(
  'reusing the id for different content is an error, not a silent overwrite',
  conflicting.body.error !== undefined,
  JSON.stringify(conflicting.body).slice(0, 160),
);
ok(
  'and it is a different error from a refusal, so a caller can stop retrying',
  conflicting.body.error?.code !== [...codes][0],
  `${conflicting.body.error?.code} vs ${[...codes][0]}`,
);
ok(
  'naming the task that already exists',
  task?.id !== undefined &&
    JSON.stringify(conflicting.body.error).includes(task.id),
  JSON.stringify(conflicting.body.error).slice(0, 200),
);

console.log('\n5. one caller cannot reach another’s work');
const bSent = await rpc('SendMessage', message('m-1', "B's own work"), asB);
const bTask = bSent.body.result?.task ?? bSent.body.result;
ok(
  'a second client reusing the same message id gets its own task',
  bSent.body.error === undefined && bTask?.id !== task.id,
  `${bTask?.id} vs ${task.id}`,
);
const bReadsA = await rpc('GetTask', { id: task.id }, asB);
ok(
  "and cannot read the first client's task",
  bReadsA.body.error !== undefined,
  JSON.stringify(bReadsA.body).slice(0, 160),
);
const bCancelsA = await rpc('CancelTask', { id: task.id }, asB);
ok('nor cancel it', bCancelsA.body.error !== undefined);
// The property that matters, not merely that both fail: a caller able to tell
// "not yours" from "no such task" can enumerate another client's task ids by
// probing.
const bReadsNothing = await rpc('GetTask', { id: 'th_does_not_exist' }, asB);
ok(
  'and a task that is not yours is indistinguishable from one that does not exist',
  JSON.stringify(bReadsA.body.error) === JSON.stringify(bReadsNothing.body.error),
  `${JSON.stringify(bReadsA.body.error)} vs ${JSON.stringify(bReadsNothing.body.error)}`,
);
const bCancelsNothing = await rpc('CancelTask', { id: 'th_does_not_exist' }, asB);
ok(
  'and cancelling either answers the same way too',
  JSON.stringify(bCancelsA.body.error) ===
    JSON.stringify(bCancelsNothing.body.error),
  `${JSON.stringify(bCancelsA.body.error)} vs ${JSON.stringify(bCancelsNothing.body.error)}`,
);
const aList = await rpc('ListTasks', {}, asA);
const aTasks = aList.body.result?.tasks ?? [];
ok(
  'listing returns only this caller’s work',
  aTasks.length === 1 && aTasks[0].id === task.id,
  JSON.stringify(aTasks.map((t) => t.id)),
);

console.log('\n6. what is not implemented is refused, not faked');
const streamed = await rpc('SendStreamingMessage', message('m-2', 'stream it'), asA);
ok(
  'streaming is refused, matching the capability the card advertises',
  streamed.body.error !== undefined,
  JSON.stringify(streamed.body).slice(0, 160),
);

console.log('\n7. cancellation reaches the caller as CANCELED');
const cancelled = await rpc('CancelTask', { id: task.id }, asA);
const cancelledTask = cancelled.body.result?.task ?? cancelled.body.result;
ok('the owner may cancel', cancelled.body.error === undefined, JSON.stringify(cancelled.body).slice(0, 200));
ok(
  'and the task reports TASK_STATE_CANCELED',
  cancelledTask?.status?.state === 'TASK_STATE_CANCELED',
  JSON.stringify(cancelledTask?.status),
);

console.error = realConsoleError;
server.close();
await fsp.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
