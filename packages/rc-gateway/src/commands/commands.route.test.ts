/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { CommandLoader } from './loader.js';
import {
  createListCommandsRoute,
  createInvokeCommandRoute,
  mapDeclaredScope,
} from '../routes/commands.js';
import { requireScope, enforceSessionLock } from '../auth.js';
import { SESSION_READ, WRITE, APPROVE, type RcScope } from '../scopes.js';
import type { RequestHandler } from 'express';

class FakeAudit implements AuditRecorder {
  entries: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

let root: string;
let workspaceCwd: string;
let workspaceDir: string;
let userDir: string;
let server: Server | undefined;
let stub: StubDaemon | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rc-cmdroute-'));
  workspaceCwd = join(root, 'ws');
  workspaceDir = join(workspaceCwd, '.qwen', 'commands');
  userDir = join(root, 'user');
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(userDir, { recursive: true });
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
  await rm(root, { recursive: true, force: true });
});

/** Inject a stub req.rcClient with the given scopes, then mount the route. */
function fakeClient(scopes: RcScope[]): RequestHandler {
  return (req, _res, next) => {
    req.rcClient = { id: 'tok-1', scopes };
    next();
  };
}

async function listen(app: express.Express): Promise<string> {
  const s: Server = await new Promise((resolve) => {
    const x = app.listen(0, '127.0.0.1', () => resolve(x));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function commandLoader(audit?: AuditRecorder): CommandLoader {
  return new CommandLoader(async () => workspaceCwd, userDir, audit);
}

const cmd = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: does ${name}\nscope: write\n${extra}---\nbody for ${name} ${'${args}'}`;

describe('mapDeclaredScope', () => {
  it('maps declared scopes to RcScopes', () => {
    expect(mapDeclaredScope('read')).toBe(SESSION_READ);
    expect(mapDeclaredScope('write')).toBe(WRITE);
    expect(mapDeclaredScope('approve')).toBe(APPROVE);
  });
});

describe('GET /rc/commands', () => {
  it('returns {v:1, commands:[...]} with the expected shape', async () => {
    await writeFile(join(workspaceDir, 'triage.md'), cmd('triage'));
    const app = express();
    app.use(express.json());
    app.get(
      '/rc/commands',
      fakeClient([SESSION_READ, WRITE]),
      createListCommandsRoute(commandLoader()),
    );
    const url = await listen(app);

    const res = await fetch(`${url}/rc/commands`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      v: number;
      commands: Array<Record<string, unknown>>;
    };
    expect(body.v).toBe(1);
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]).toMatchObject({
      name: 'triage',
      description: 'does triage',
      scope: 'write',
      tool: null,
      sessionScope: 'required',
      source: 'workspace',
      invocableByYou: true,
    });
  });

  it('invocableByYou is false for a write command when caller lacks WRITE', async () => {
    await writeFile(join(workspaceDir, 'w.md'), cmd('w'));
    const app = express();
    app.get(
      '/rc/commands',
      fakeClient([SESSION_READ]),
      createListCommandsRoute(commandLoader()),
    );
    const url = await listen(app);
    const body = (await (await fetch(`${url}/rc/commands`)).json()) as {
      commands: Array<{ invocableByYou: boolean }>;
    };
    expect(body.commands[0].invocableByYou).toBe(false);
  });

  it('an approve command is invocableByYou:false for a WRITE-but-not-APPROVE caller', async () => {
    await writeFile(
      join(workspaceDir, 'a.md'),
      `---\nname: a\ndescription: approve cmd\nscope: approve\n---\nbody`,
    );
    const app = express();
    app.get(
      '/rc/commands',
      fakeClient([SESSION_READ, WRITE]),
      createListCommandsRoute(commandLoader()),
    );
    const url = await listen(app);
    const body = (await (await fetch(`${url}/rc/commands`)).json()) as {
      commands: Array<{ invocableByYou: boolean }>;
    };
    expect(body.commands[0].invocableByYou).toBe(false);
  });

  it('a tool command is invocableByYou:false even for an all-scope caller', async () => {
    await writeFile(join(workspaceDir, 't.md'), cmd('t', 'tool: shell\n'));
    const app = express();
    app.get(
      '/rc/commands',
      fakeClient([SESSION_READ, WRITE, APPROVE]),
      createListCommandsRoute(commandLoader()),
    );
    const url = await listen(app);
    const body = (await (await fetch(`${url}/rc/commands`)).json()) as {
      commands: Array<{ invocableByYou: boolean; tool: string | null }>;
    };
    expect(body.commands[0].tool).toBe('shell');
    expect(body.commands[0].invocableByYou).toBe(false);
  });

  it('exposes a command args declaration in the listing (null when absent)', async () => {
    await writeFile(
      join(workspaceDir, 'fix.md'),
      `---\nname: fix\ndescription: fix\nscope: write\nargs:\n  - name: issue\n    required: true\n---\nbody`,
    );
    await writeFile(join(workspaceDir, 'plain.md'), cmd('plain'));
    const app = express();
    app.get(
      '/rc/commands',
      fakeClient([SESSION_READ, WRITE]),
      createListCommandsRoute(commandLoader()),
    );
    const url = await listen(app);
    const body = (await (await fetch(`${url}/rc/commands`)).json()) as {
      commands: Array<{ name: string; args: unknown }>;
    };
    const byName = Object.fromEntries(
      body.commands.map((c) => [c.name, c.args]),
    );
    expect(byName['fix']).toEqual([{ name: 'issue', required: true }]);
    expect(byName['plain']).toBeNull();
  });

  it('carries an X-Commands-Revision hex header on a 200', async () => {
    await writeFile(join(workspaceDir, 'triage.md'), cmd('triage'));
    const app = express();
    app.get(
      '/rc/commands',
      fakeClient([SESSION_READ, WRITE]),
      createListCommandsRoute(commandLoader()),
    );
    const url = await listen(app);
    const res = await fetch(`${url}/rc/commands`);
    expect(res.status).toBe(200);
    const rev = res.headers.get('x-commands-revision');
    expect(rev).toMatch(/^[0-9a-f]{64}$/);
  });

  it('304s with an empty body and echoed header on an If-None-Match round-trip', async () => {
    await writeFile(join(workspaceDir, 'triage.md'), cmd('triage'));
    const app = express();
    app.get(
      '/rc/commands',
      fakeClient([SESSION_READ, WRITE]),
      createListCommandsRoute(commandLoader()),
    );
    const url = await listen(app);

    const first = await fetch(`${url}/rc/commands`);
    const rev = first.headers.get('x-commands-revision')!;

    // Bare hex form.
    const bare = await fetch(`${url}/rc/commands`, {
      headers: { 'If-None-Match': rev },
    });
    expect(bare.status).toBe(304);
    expect(await bare.text()).toBe('');
    expect(bare.headers.get('x-commands-revision')).toBe(rev);

    // Quoted form (the spec scenario's literal shape).
    const quoted = await fetch(`${url}/rc/commands`, {
      headers: { 'If-None-Match': `"${rev}"` },
    });
    expect(quoted.status).toBe(304);
    expect(await quoted.text()).toBe('');
  });

  it('returns 200 + a different revision when the registry changes', async () => {
    await writeFile(join(workspaceDir, 'triage.md'), cmd('triage'));
    const app = express();
    app.get(
      '/rc/commands',
      fakeClient([SESSION_READ, WRITE]),
      createListCommandsRoute(commandLoader()),
    );
    const url = await listen(app);

    const first = await fetch(`${url}/rc/commands`);
    const rev = first.headers.get('x-commands-revision')!;

    // Add a second command, then poll with the stale revision.
    await writeFile(join(workspaceDir, 'lint.md'), cmd('lint'));
    const second = await fetch(`${url}/rc/commands`, {
      headers: { 'If-None-Match': rev },
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-commands-revision')).not.toBe(rev);
  });

  it('gives different revisions to callers with different scopes (invocableByYou-folded)', async () => {
    await writeFile(join(workspaceDir, 'w.md'), cmd('w'));
    const app = express();
    app.get(
      '/rc/commands/read',
      fakeClient([SESSION_READ]),
      createListCommandsRoute(commandLoader()),
    );
    app.get(
      '/rc/commands/write',
      fakeClient([SESSION_READ, WRITE]),
      createListCommandsRoute(commandLoader()),
    );
    const url = await listen(app);

    const readRev = (await fetch(`${url}/rc/commands/read`)).headers.get(
      'x-commands-revision',
    );
    const writeRev = (await fetch(`${url}/rc/commands/write`)).headers.get(
      'x-commands-revision',
    );
    expect(readRev).not.toBe(writeRev);
  });
});

describe('POST /rc/session/:id/command/:name', () => {
  async function bootInvoke(opts: {
    scopes: RcScope[];
    audit?: AuditRecorder;
    stubOpts?: Parameters<typeof startStubDaemon>[0];
  }): Promise<{ url: string; daemon: DaemonClient }> {
    stub = await startStubDaemon(opts.stubOpts);
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const app = express();
    app.use(express.json());
    app.post(
      '/session/:id/command/:name',
      fakeClient(opts.scopes),
      requireScope(WRITE, opts.audit),
      enforceSessionLock(opts.audit),
      createInvokeCommandRoute(daemon, commandLoader(opts.audit), opts.audit),
    );
    const url = await listen(app);
    return { url, daemon };
  }

  it('404s an unknown command', async () => {
    const { url } = await bootInvoke({ scopes: [SESSION_READ, WRITE] });
    const res = await fetch(`${url}/session/s1/command/nope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      'unknown_command',
    );
  });

  it('400s a tool command', async () => {
    await writeFile(join(workspaceDir, 't.md'), cmd('t', 'tool: shell\n'));
    const { url } = await bootInvoke({
      scopes: [SESSION_READ, WRITE, APPROVE],
    });
    const res = await fetch(`${url}/session/s1/command/t`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      'direct_tool_unsupported',
    );
  });

  it('403s when the caller lacks the declared scope (and audits scope_denied)', async () => {
    await writeFile(
      join(workspaceDir, 'a.md'),
      `---\nname: a\ndescription: approve cmd\nscope: approve\n---\nbody`,
    );
    const audit = new FakeAudit();
    // Caller has WRITE (passes the route gate) but not APPROVE (fails the clamp).
    const { url } = await bootInvoke({ scopes: [SESSION_READ, WRITE], audit });
    const res = await fetch(`${url}/session/s1/command/a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      'insufficient_scope',
    );
    expect(
      audit.entries.some(
        (e) =>
          e.action === 'scope_denied' && e.detail?.['required'] === APPROVE,
      ),
    ).toBe(true);
  });

  it('happy path → 200 {stopReason}; resolved text reaches the daemon prompt; audit excludes body', async () => {
    await writeFile(
      join(workspaceDir, 'echo.md'),
      `---\nname: echo\ndescription: echo args\nscope: write\n---\nEcho: ${'${args}'}`,
    );
    const audit = new FakeAudit();
    const { url } = await bootInvoke({
      scopes: [SESSION_READ, WRITE],
      audit,
      stubOpts: { promptStopReason: 'end_turn' },
    });
    const res = await fetch(`${url}/session/s1/command/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['hello', 'world'] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stopReason: string }).stopReason).toBe(
      'end_turn',
    );
    const invoked = audit.entries.find(
      (e) => e.action === 'slash_command_invoked',
    );
    expect(invoked).toBeDefined();
    expect(invoked!.detail).toMatchObject({
      name: 'echo',
      stopReason: 'end_turn',
      argc: 2,
    });
    // The resolved prompt text must NEVER be audited.
    expect(JSON.stringify(invoked)).not.toContain('hello world');
    expect(JSON.stringify(invoked)).not.toContain('Echo:');
  });

  it('accepts args as a whitespace-delimited string', async () => {
    await writeFile(join(workspaceDir, 'echo.md'), cmd('echo'));
    const audit = new FakeAudit();
    const { url } = await bootInvoke({ scopes: [SESSION_READ, WRITE], audit });
    const res = await fetch(`${url}/session/s1/command/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: 'a b c' }),
    });
    expect(res.status).toBe(200);
    const invoked = audit.entries.find(
      (e) => e.action === 'slash_command_invoked',
    );
    expect(invoked!.detail).toMatchObject({ argc: 3 });
  });

  it('502s when the daemon throws (and not aborted)', async () => {
    await writeFile(join(workspaceDir, 'echo.md'), cmd('echo'));
    const { url } = await bootInvoke({
      scopes: [SESSION_READ, WRITE],
      stubOpts: { promptStatus: 500 },
    });
    const res = await fetch(`${url}/session/s1/command/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe(
      'daemon_unavailable',
    );
  });

  // A capturing fake daemon so we can assert the RESOLVED prompt text (the stub
  // daemon ignores prompt bodies) and that a 400 short-circuits before any call.
  async function bootCapturing(
    scopes: RcScope[],
    audit?: AuditRecorder,
  ): Promise<{ url: string; calls: Array<{ id: string; text: string }> }> {
    const calls: Array<{ id: string; text: string }> = [];
    const fakeDaemon = {
      prompt: async (
        id: string,
        payload: { prompt: Array<{ type: string; text: string }> },
      ) => {
        calls.push({ id, text: payload.prompt.map((p) => p.text).join('') });
        return { stopReason: 'end_turn' };
      },
    } as unknown as DaemonClient;
    const app = express();
    app.use(express.json());
    app.post(
      '/session/:id/command/:name',
      fakeClient(scopes),
      requireScope(WRITE, audit),
      enforceSessionLock(audit),
      createInvokeCommandRoute(fakeDaemon, commandLoader(audit), audit),
    );
    const url = await listen(app);
    return { url, calls };
  }

  const ARG_CMD = `---\nname: fix\ndescription: fix\nscope: write\nargs:\n  - name: issue\n    required: true\n  - name: branch\n    default: main\n---\nfix #${'${arg}'} on ${'${arg.1}'}`;

  it('400s when a required declared arg is missing; daemon NOT called; audits slash_command_arg_missing', async () => {
    await writeFile(join(workspaceDir, 'fix.md'), ARG_CMD);
    const audit = new FakeAudit();
    const { url, calls } = await bootCapturing([SESSION_READ, WRITE], audit);
    const res = await fetch(`${url}/session/s1/command/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      'missing_required_args',
    );
    expect(calls).toHaveLength(0);
    const miss = audit.entries.find(
      (e) => e.action === 'slash_command_arg_missing',
    );
    expect(miss?.detail).toMatchObject({ name: 'fix', missing: ['issue'] });
  });

  it('auto-fills a declared default for an absent positional arg', async () => {
    await writeFile(join(workspaceDir, 'fix.md'), ARG_CMD);
    const { url, calls } = await bootCapturing([SESSION_READ, WRITE]);
    const res = await fetch(`${url}/session/s1/command/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['123'] }), // branch omitted → default 'main'
    });
    expect(res.status).toBe(200);
    expect(calls[0].text).toBe('fix #123 on main');
  });

  it('a provided positional value overrides the declared default', async () => {
    await writeFile(join(workspaceDir, 'fix.md'), ARG_CMD);
    const { url, calls } = await bootCapturing([SESSION_READ, WRITE]);
    await fetch(`${url}/session/s1/command/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['123', 'dev'] }),
    });
    expect(calls[0].text).toBe('fix #123 on dev');
  });

  it('a command with no args declaration is unaffected (back-compat)', async () => {
    await writeFile(join(workspaceDir, 'echo.md'), cmd('echo'));
    const { url, calls } = await bootCapturing([SESSION_READ, WRITE]);
    const res = await fetch(`${url}/session/s1/command/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['x', 'y'] }),
    });
    expect(res.status).toBe(200);
    expect(calls[0].text).toBe('body for echo x y');
  });
});
