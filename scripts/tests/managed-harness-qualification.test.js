/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  qualify,
  readSse,
  validateConfig,
} from '../run-managed-harness-qualification.mjs';

const key = 'qualification-test-signing-key-32-bytes';
const actor = (tenantId, actorId) => ({
  tenantId,
  actorId,
  filesAgentId: 'files-agent',
  shellAgentId: 'shell-agent',
});
const config = {
  baseUrl: 'http://127.0.0.1:1',
  runId: 'qualification-test',
  sourceSha: 'a'.repeat(40),
  timeoutSeconds: 2,
  actors: [
    actor('tenant-a', 'owner-a'),
    actor('tenant-a', 'owner-b'),
    actor('tenant-b', 'owner-a'),
    actor('tenant-b', 'owner-b'),
  ],
};

async function fixture(fault) {
  const workspaces = new Map(),
    sessions = new Map(),
    mutations = new Map(),
    operations = new Map();
  const requests = [],
    streamReaders = [];
  let turnCounter = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      const url = new URL(req.url, 'http://127.0.0.1');
      const tenant = req.headers['x-qwen-tenant-id'],
        user = req.headers['x-qwen-actor-id'];
      const identity = `${tenant}:${user}`,
        mutation = req.headers['idempotency-key'];
      const canonical = [
        'qwen-broker-auth-v1',
        req.method,
        url.pathname,
        url.search.slice(1),
        tenant,
        user,
        req.headers['x-qwen-signature-timestamp'],
        createHash('sha256').update(raw).digest('hex'),
        mutation ?? '',
      ].join('\n');
      const signature = `v1=${createHmac('sha256', key).update(canonical).digest('hex')}`;
      const json = (status, data, replay = false) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          'x-qwen-idempotent-replay': String(replay),
        });
        res.end(JSON.stringify(data));
      };
      requests.push({ method: req.method, path: url.pathname, identity });
      if (req.headers['x-qwen-signature'] !== signature)
        return json(401, { code: 'unauthorized' });
      if (url.pathname === '/v1/agents') return json(405, {});
      if (url.pathname === '/v1/agents/files-agent' && req.method === 'GET')
        return json(200, { id: 'files-agent', object: 'agent' });
      if (url.pathname === '/api/agent/web-shell/v1/workspaces/create') {
        let workspace = [...workspaces.values()].find(
          (value) => value.key === `${identity}:${body.idempotencyKey}`,
        );
        if (!workspace) {
          workspace = {
            id: `workspace-${workspaces.size + 1}`,
            owner: identity,
            key: `${identity}:${body.idempotencyKey}`,
            files: new Map(),
          };
          workspaces.set(workspace.id, workspace);
        }
        return json(200, { workspaceId: workspace.id });
      }
      if (url.pathname.startsWith('/v1/agents/workspaces/')) {
        const workspace = workspaces.get(url.pathname.split('/').at(-1));
        return workspace?.owner === identity
          ? json(200, {
              id: workspace.id,
              object: 'agent.workspace',
              display_name: workspace.id,
              state: 'ready',
              can_create_session: true,
            })
          : json(404, {});
      }
      if (
        url.pathname.startsWith('/api/agent/web-shell/v1/workspaces/files/')
      ) {
        const workspace = workspaces.get(body.workspaceId);
        if (workspace?.owner !== identity) return json(404, {});
        if (url.pathname.endsWith('/query'))
          return json(200, {
            scopeRevision: 'scope-1',
            truncated: false,
            entries: [...workspace.files.keys()].map((file) => ({
              path: file,
              name: file,
            })),
          });
        return workspace.files.has(body.path)
          ? json(200, { text: workspace.files.get(body.path) })
          : json(404, {});
      }
      if (url.pathname === '/v1/agents/sessions' && req.method === 'POST') {
        const previous = mutations.get(`${identity}:${mutation}`);
        if (previous) return json(202, { id: previous }, !fault?.missingReplay);
        const session = {
          id: `session-${sessions.size + 1}`,
          owner: identity,
          workspace: workspaces.get(body.workspace.workspace_id),
          events: [],
          actions: [],
          lastExpected: '',
        };
        sessions.set(session.id, session);
        mutations.set(`${identity}:${mutation}`, session.id);
        return json(202, { id: session.id });
      }
      const match = url.pathname.match(
        /^\/v1\/agents\/sessions\/([^/]+)(.*)$/u,
      );
      const session = sessions.get(match?.[1]);
      if (!session || session.owner !== identity) return json(404, {});
      const tail = match[2];
      const event = (turn, type, data = {}, terminal = false) =>
        session.events.push({
          session_id: session.id,
          turn_id: turn,
          sequence: session.events.length + 1,
          type,
          terminal,
          data,
        });
      const terminal = (turn, type = 'turn.completed') => {
        event(turn, type, {}, true);
        if (fault?.duplicateTerminal) event(turn, type, {}, true);
      };
      if (!tail) return json(200, { id: session.id });
      if (tail === '/events' && req.method === 'POST') {
        if (body.type === 'agent.session.cancel') {
          terminal(
            body.turn_id,
            fault?.wrongCancelTerminal ? 'turn.completed' : 'turn.cancelled',
          );
          return json(202, { session_id: session.id, turn_id: body.turn_id });
        }
        const turn = `turn-${++turnCounter}`;
        const text = body.input[0].text;
        if (text.startsWith('Use write_file')) {
          const file = text.match(/create (\S+) containing/u)[1];
          const expected = text.match(
            /contain exactly (\S+) with no newline/u,
          )[1];
          session.lastExpected = expected;
          if (!fault?.missingPhysicalEffect)
            session.workspace.files.set(file, expected);
          for (const name of ['write_file', 'read_file', 'edit'])
            event(turn, 'item.tool_call.updated', {
              name,
              status: 'completed',
            });
          terminal(turn);
        } else if (text.startsWith('Without using tools')) {
          if (fault?.historyUsesTool)
            event(turn, 'item.tool_call.updated', {
              name: 'read_file',
              status: 'completed',
            });
          event(turn, 'item.output_text.delta', { text: session.lastExpected });
          terminal(turn);
        } else {
          const command = text.split('do not retry it: ')[1];
          const action = {
            id: `action-${turn}`,
            kind: 'permission',
            state: 'requested',
            turn_id: turn,
            input_revision: 1,
            policy_revision: 'policy-1',
            tool_name: 'run_shell_command',
            options: [{ id: 'allow' }, { id: 'deny' }],
            input_preview: {
              truncated: false,
              text: JSON.stringify({
                toolName: 'run_shell_command',
                input: {
                  command: fault?.wrongCommand
                    ? 'unrequested-command'
                    : command,
                  is_background: false,
                },
              }),
            },
            command,
          };
          session.actions.push(action);
          event(turn, 'item.tool_call.updated', {
            name: 'run_shell_command',
            status: 'pending',
          });
          if (fault?.effectBeforeApproval)
            session.workspace.files.set(
              command.match(/>> '([^']+)'/u)[1],
              'premature',
            );
        }
        if (fault?.wrongJsonSession)
          session.events[0].session_id = 'foreign-session';
        return json(202, { session_id: session.id, turn_id: turn });
      }
      if (tail === '/actions')
        return json(200, { data: session.actions, has_more: false });
      if (tail.startsWith('/actions/') && tail.endsWith('/responses')) {
        const stored = mutations.get(`${identity}:${mutation}`);
        if (stored) return json(202, { id: stored, replayed: true }, true);
        const action = session.actions.find(
          (value) => value.id === tail.split('/')[2],
        );
        if (
          !action ||
          body.input_revision !== action.input_revision ||
          body.policy_revision !== action.policy_revision ||
          !action.options.some((option) => option.id === body.option_id)
        )
          return json(409, {});
        action.state = 'decided';
        const operation = `operation-${operations.size + 1}`;
        operations.set(operation, { id: operation, status: 'completed' });
        mutations.set(`${identity}:${mutation}`, operation);
        if (body.option_id === 'allow') {
          const file = action.command.match(/>> '([^']+)'/u)[1];
          const token = action.command.match(/printf '([^']+)\\n'/u)[1] + '\n';
          session.workspace.files.set(
            file,
            token.repeat(fault?.duplicateShellEffect ? 2 : 1),
          );
        }
        if (body.option_id === 'deny' || !action.command.endsWith('; sleep 60'))
          terminal(action.turn_id);
        return json(202, { id: operation });
      }
      if (tail.startsWith('/operations/'))
        return json(200, operations.get(tail.split('/')[2]));
      if (tail === '/close') {
        const id = `operation-${operations.size + 1}`;
        operations.set(id, { id, status: 'completed' });
        return json(202, { id });
      }
      if (tail === '/events') {
        const after = Number(
          req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0,
        );
        const events = session.events.filter((value) => value.sequence > after);
        if (url.searchParams.get('stream') !== 'true')
          return json(200, { data: events, has_more: false });
        streamReaders.push(after);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': keepalive\r\n\r\n');
        for (const value of events) {
          let data = fault?.wrongSseSession
            ? { ...value, session_id: 'foreign-session' }
            : value;
          if (fault?.wrongSsePayload)
            data = { ...data, data: { changed: true } };
          const frame = `id: ${value.sequence}\r\nevent: ${value.type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
          res.write(frame.slice(0, 7));
          res.write(frame.slice(7));
        }
        return;
      }
      return json(404, {});
    } catch {
      res.writeHead(500);
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    streamReaders,
    sessions,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

describe('public qualification configuration', () => {
  it.each([
    { baseUrl: 'http://public.example.test' },
    { baseUrl: 'https://user:password@example.test' },
    { baseUrl: 'https://example.test/private' },
    { actors: config.actors.slice(0, 2) },
    { actors: [config.actors[0], config.actors[0], ...config.actors.slice(2)] },
    { timeoutSeconds: 0 },
  ])('rejects unsafe input before making requests %j', (override) =>
    expect(() => validateConfig({ ...config, ...override })).toThrow(),
  );
});

describe('signed external qualification against a real HTTP contract fixture', () => {
  it('checks owned effects, replay, original decisions, cancellation and SSE resume without starting Java', async () => {
    const backend = await fixture();
    const reports = [];
    try {
      const report = await qualify(
        { ...config, baseUrl: backend.url },
        key,
        async (value) => reports.push(structuredClone(value)),
      );
      expect(report.status, JSON.stringify(report)).toBe(
        'PUBLIC_SCENARIOS_PASSED',
      );
      expect(report.sessions).toHaveLength(8);
      expect(report.workspaces).toHaveLength(4);
      expect(report.turns).toHaveLength(11);
      expect(report.actions).toHaveLength(3);
      expect(
        report.operations.every(
          (operation) => operation.status === 'completed',
        ),
      ).toBe(true);
      expect(report.eventCursors[0].resumedThroughSequence).toBeGreaterThan(
        report.eventCursors[0].disconnectedAtSequence,
      );
      expect(
        report.effects.some((effect) => effect.sha256 && effect.byteLength > 0),
      ).toBe(true);
      expect(backend.streamReaders).toHaveLength(2);
      expect(backend.streamReaders[0]).toBe(0);
      expect(backend.streamReaders[1]).toBeGreaterThan(0);
      expect(report.placementAcceptance).toBe('NOT_RUN');
      expect(report.faultAcceptance).toBe('NOT_RUN');
      expect(report.scaleInEnabled).toBe(false);
      expect(JSON.stringify(reports)).not.toContain(key);
      expect(JSON.stringify(reports)).not.toContain('v1=');
      expect(
        reports.some(
          (value) => value.sessions.length > 0 && value.status === 'RUNNING',
        ),
      ).toBe(true);
    } finally {
      await backend.close();
    }
  });

  it.each([
    ['missingReplay', 'public admission'],
    ['missingPhysicalEffect', 'physical file effects'],
    ['duplicateTerminal', 'physical file effects'],
    ['wrongJsonSession', 'physical file effects'],
    ['wrongCommand', 'shell allow'],
    ['effectBeforeApproval', 'shell allow'],
    ['duplicateShellEffect', 'shell allow'],
    ['wrongSseSession', 'SSE disconnect and resume'],
    ['wrongSsePayload', 'SSE disconnect and resume'],
    ['historyUsesTool', 'physical file effects'],
    ['wrongCancelTerminal', 'foreground cancellation'],
  ])('fails closed for %s and retains admitted IDs', async (fault, stage) => {
    const backend = await fixture({ [fault]: true });
    try {
      const report = await qualify(
        { ...config, baseUrl: backend.url },
        key,
        async () => {},
      );
      expect(report.status).toBe('FAILED');
      expect(report.failedStage).toBe(stage);
      expect(report.sessions.length).toBeGreaterThan(0);
      expect(report.faultAcceptance).toBe('NOT_RUN');
      expect(JSON.stringify(report)).not.toContain(key);
    } finally {
      await backend.close();
    }
  });
});

describe('bounded SSE parsing', () => {
  it('handles byte-split UTF-8 and multiline data, then cancels its reader', async () => {
    const event = {
      session_id: 'session-1',
      sequence: 2,
      data: { text: '中文' },
    };
    const json = JSON.stringify(event, null, 2)
      .split('\n')
      .map((line) => `data: ${line}`)
      .join('\r\n');
    const bytes = Buffer.from(`: keepalive\r\n\r\nid: 2\r\n${json}\r\n\r\n`);
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: { 'content-type': 'text/event-stream;charset=utf-8' },
    });
    expect(await readSse(response, 'session-1', 1, () => true)).toEqual([
      event,
    ]);
    expect(cancelled).toBe(true);
  });

  it.each([
    ['1', { session_id: 'session-1', sequence: 1 }],
    ['2', { session_id: 'foreign', sequence: 2 }],
    ['3', { session_id: 'session-1', sequence: 2 }],
  ])(
    'refuses stale, foreign or inconsistent event identity',
    async (id, event) => {
      const response = new Response(
        `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
      await expect(
        readSse(response, 'session-1', 1, () => true),
      ).rejects.toThrow();
    },
  );
});
