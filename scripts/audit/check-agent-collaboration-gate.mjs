#!/usr/bin/env node
/**
 * Observes the agent-collaboration opt-in instead of reading it.
 *
 * Usage: node scripts/audit/check-agent-collaboration-gate.mjs
 *
 * The plan's P0 asks for proof that with the switch off nothing collaborative
 * reaches the model, and says explicitly that reading the source does not count
 * — several rounds of careful reading had already missed things by the time it
 * was written. So this builds real `Config` objects, builds their real tool
 * registries, and reports what each one actually exposes.
 *
 * esbuild bundles `Config` and the capability table; there is no daemon, no
 * bridge and no model, and it runs in seconds on a machine that cannot afford
 * `npm run build`. Two dependencies of `discoverAllTools` are stubbed (the
 * prompt and resource registries, which `Config.initialize()` would otherwise
 * create through extension discovery and a filesystem scan); everything that
 * decides which tools exist is the real thing.
 *
 * Output is one line per assertion and a count; exit 1 on any failure.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gate-audit-'));
const entry = path.join(tmp, 'entry.ts');
const bundle = path.join(tmp, 'bundle.mjs');

await fsp.writeFile(
  entry,
  `export { Config, deriveConfig } from '${repo}/packages/core/src/config/config.js';
export { getAdvertisedServeFeatures, CONDITIONAL_SERVE_FEATURES } from '${repo}/packages/cli/src/serve/capabilities.js';
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
    // Config's import graph reaches native and wasm assets it never uses on
    // this path; none of them participate in tool registration.
    '--loader:.wasm=empty',
    '--external:tree-sitter-wasms',
    '--external:@lydell/node-pty',
    '--external:sharp',
    `--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);`,
  ],
  { cwd: repo, stdio: ['ignore', 'inherit', 'inherit'] },
);

const M = await import(bundle);

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

const dir = fs.mkdtempSync(path.join(tmp, 'ws-'));
const base = {
  sessionId: 'audit',
  targetDir: dir,
  cwd: dir,
  debugMode: false,
  model: 'audit-model',
  chatRecording: false,
};

const COLLABORATION_TOOL_PREFIX = 'thread_';
const EXPECTED_TOOLS = [
  'thread_block',
  'thread_create',
  'thread_post',
  'thread_read',
  'thread_review',
  'thread_wait',
];

async function collaborationTools({ collaboration, sourceType, subagent }) {
  let config = new M.Config({
    ...base,
    agentCollaborationEnabled: collaboration,
  });
  if (sourceType) config.setSessionSource(sourceType, 'ag_audit');
  config.getPromptRegistry = () => ({
    clear() {},
    registerPrompt() {},
    getAllPrompts: () => [],
  });
  config.getResourceRegistry = () => ({ clear() {}, registerResource() {} });
  // A real subagent runs on a derived Config, which is `Object.create(parent)`.
  // Building one by hand would miss the prototype chain, which is exactly what
  // decides this case.
  if (subagent) config = M.deriveConfig(config);
  const registry = await config.createToolRegistry(undefined, {
    forSubAgent: subagent === true,
  });
  return registry
    .getAllToolNames()
    .filter((name) => name.startsWith(COLLABORATION_TOOL_PREFIX))
    .sort();
}

const SESSION_KINDS = [
  { label: 'an ordinary session', sourceType: undefined, subagent: false },
  { label: "an ordinary session's subagent", sourceType: undefined, subagent: true },
  { label: 'an agent session', sourceType: 'agent', subagent: false },
  { label: "an agent's subagent", sourceType: 'agent', subagent: true },
];

console.log('1. with the switch off, no session kind sees the collaboration tools');
for (const kind of SESSION_KINDS) {
  const tools = await collaborationTools({ collaboration: false, ...kind });
  ok(`${kind.label} sees none`, tools.length === 0, JSON.stringify(tools));
}

console.log('\n2. with it on, only the agent kinds do');
for (const kind of SESSION_KINDS) {
  const tools = await collaborationTools({ collaboration: true, ...kind });
  const shouldSee = kind.sourceType === 'agent';
  ok(
    `${kind.label} sees ${shouldSee ? 'all six' : 'none'}`,
    shouldSee
      ? EXPECTED_TOOLS.every((tool) => tools.includes(tool)) &&
          tools.length === EXPECTED_TOOLS.length
      : tools.length === 0,
    JSON.stringify(tools),
  );
}
// The `forSubAgent` clause the gate started with is what this pins down: an
// agent's subagent must keep the tools (it reads `sourceType` off the prototype
// chain), while an ordinary conversation's subagent must not get them merely
// for being a subagent — it has no run frame, so every call would throw.

console.log('\n3. the two experiment switches are independent');
for (const team of [false, true]) {
  for (const collaboration of [false, true]) {
    const config = new M.Config({
      ...base,
      agentTeamEnabled: team,
      agentCollaborationEnabled: collaboration,
    });
    ok(
      `team=${team} collaboration=${collaboration}: each reports only itself`,
      config.isAgentTeamEnabled() === team &&
        config.isAgentCollaborationEnabled() === collaboration,
      `${config.isAgentTeamEnabled()} / ${config.isAgentCollaborationEnabled()}`,
    );
  }
}

const teamOnly = new M.Config({
  ...base,
  agentTeamEnabled: true,
  agentCollaborationEnabled: false,
});
teamOnly.setSessionSource('agent', 'ag_audit');
teamOnly.getPromptRegistry = () => ({
  clear() {},
  registerPrompt() {},
  getAllPrompts: () => [],
});
teamOnly.getResourceRegistry = () => ({ clear() {}, registerResource() {} });
const teamOnlyTools = (
  await teamOnly.createToolRegistry(undefined, { forSubAgent: false })
)
  .getAllToolNames()
  .filter((name) => name.startsWith(COLLABORATION_TOOL_PREFIX));
ok(
  'Agent Team on its own exposes no collaboration tools',
  teamOnlyTools.length === 0,
  JSON.stringify(teamOnlyTools),
);

console.log('\n4. the env override reaches collaboration and nothing else');
process.env['QWEN_CODE_ENABLE_AGENT_COLLABORATION'] = '1';
const viaEnv = new M.Config({
  ...base,
  agentTeamEnabled: false,
  agentCollaborationEnabled: false,
});
ok('it turns collaboration on', viaEnv.isAgentCollaborationEnabled() === true);
ok('and leaves Agent Team off', viaEnv.isAgentTeamEnabled() === false);
delete process.env['QWEN_CODE_ENABLE_AGENT_COLLABORATION'];
const withoutEnv = new M.Config({ ...base, agentCollaborationEnabled: false });
ok(
  'and removing it turns collaboration back off',
  withoutEnv.isAgentCollaborationEnabled() === false,
);

console.log('\n5. clients can tell, because the capability tag follows the switch');
const TAG = 'agent_collaboration_v1';
const advertisedOff = M.getAdvertisedServeFeatures(undefined, {});
const advertisedFalse = M.getAdvertisedServeFeatures(undefined, {
  agentCollaborationEnabled: false,
});
const advertisedOn = M.getAdvertisedServeFeatures(undefined, {
  agentCollaborationEnabled: true,
});
ok('absent with no toggles at all', !advertisedOff.includes(TAG));
ok('absent when the toggle is false', !advertisedFalse.includes(TAG));
ok('present when the toggle is true', advertisedOn.includes(TAG));
ok(
  'registered as conditional rather than baseline',
  M.CONDITIONAL_SERVE_FEATURES.has(TAG),
);
ok(
  'and turning it on adds exactly this tag, removing none',
  advertisedOn.length === advertisedOff.length + 1 &&
    advertisedOff.every((feature) => advertisedOn.includes(feature)),
  `${advertisedOff.length} -> ${advertisedOn.length}`,
);

await fsp.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
