/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { signedManagedHeaders } from '../packages/cli/src/serve/managed-local-web.js';

const publicSessions = '/v1/agents/sessions';
const workspaceFiles = '/api/agent/web-shell/v1/workspaces/files';
const limit = 1024 * 1024;

export function validateConfig(config) {
  const url = new URL(config.baseUrl);
  assert.ok(
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
    'HTTPS origin or loopback forwarding is required',
  );
  assert.match(config.runId, /^[a-z0-9][a-z0-9-]{0,47}$/u);
  assert.match(config.sourceSha, /^[a-f0-9]{40}$/u);
  assert.ok(
    Array.isArray(config.actors) && config.actors.length === 4,
    'Four dedicated actors are required',
  );
  const tenants = new Map();
  for (const actor of config.actors) {
    for (const name of ['tenantId', 'actorId', 'filesAgentId', 'shellAgentId'])
      assert.ok(
        typeof actor[name] === 'string' &&
          /^[A-Za-z0-9._:-]{1,128}$/u.test(actor[name]),
        `Invalid ${name}`,
      );
    if (!tenants.has(actor.tenantId)) tenants.set(actor.tenantId, new Set());
    tenants.get(actor.tenantId).add(actor.actorId);
  }
  assert.ok(
    tenants.size === 2 &&
      [...tenants.values()].every((actors) => actors.size === 2),
    'Use two distinct actors in each of two tenants',
  );
  assert.ok(
    Number.isInteger(config.timeoutSeconds) &&
      config.timeoutSeconds >= 1 &&
      config.timeoutSeconds <= 120,
    'timeoutSeconds must be 1..120',
  );
}

async function boundedText(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('utf8');
      bytes += value.length;
      assert.ok(bytes <= limit, 'Response exceeds qualification limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
}

export async function readSse(response, sessionId, after, stop) {
  assert.match(
    response.headers.get('content-type') ?? '',
    /^text\/event-stream\b/iu,
  );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '',
    bytes = 0,
    previous = after;
  try {
    while (true) {
      const chunk = await reader.read();
      assert.ok(!chunk.done, 'SSE ended before its required witness');
      bytes += chunk.value.length;
      assert.ok(bytes <= limit, 'SSE exceeds qualification limit');
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/u)) !== -1) {
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/u)[0];
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separator.length);
        const lines = frame.split(/\r?\n/u);
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /u, ''))
          .join('\n');
        if (!data) continue;
        const id = lines
          .find((line) => line.startsWith('id:'))
          ?.slice(3)
          .trim();
        const event = JSON.parse(data);
        assert.ok(
          /^\d+$/u.test(id ?? '') &&
            Number.isSafeInteger(event.sequence) &&
            Number(id) === event.sequence &&
            event.sequence > previous,
          'SSE sequence must advance',
        );
        assert.equal(
          event.session_id,
          sessionId,
          'SSE returned a different Session',
        );
        previous = event.sequence;
        events.push(event);
        assert.ok(events.length <= 1000, 'Too many qualification events');
        if (stop(event, events)) return events;
      }
    }
  } finally {
    await reader.cancel();
  }
}

export async function qualify(config, signingKey, save) {
  validateConfig(config);
  assert.ok(
    Buffer.byteLength(signingKey) >= 32 && !/[\r\n\0]/u.test(signingKey),
    'A private signing key is required',
  );
  const report = {
    runId: config.runId,
    expectedSourceSha: config.sourceSha,
    targetOrigin: new URL(config.baseUrl).origin,
    startedAt: new Date().toISOString(),
    status: 'RUNNING',
    checks: [],
    sessions: [],
    workspaces: [],
    turns: [],
    actions: [],
    operations: [],
    eventCursors: [],
    effects: [],
    placementAcceptance: 'NOT_RUN',
    faultAcceptance: 'NOT_RUN',
    capacityAcceptance: 'NOT_RUN',
    scaleInEnabled: false,
  };
  let stage = 'authentication';
  const record = async (name) => {
    report.checks.push(name);
    await save(report);
  };
  const request = async (
    actor,
    route,
    {
      method = 'GET',
      body,
      key,
      expected = 200,
      unsigned = false,
      tampered = false,
      stream = false,
      after = 0,
    } = {},
  ) => {
    const payload =
      body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers = signedManagedHeaders({
      method,
      path: route,
      body: payload,
      signingKey,
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      idempotencyKey: key,
    });
    if (unsigned) {
      delete headers['X-Qwen-Signature'];
      delete headers['X-Qwen-Signature-Timestamp'];
    }
    if (tampered) headers['X-Qwen-Actor-Id'] += '-tampered';
    if (stream) {
      headers.Accept = 'text/event-stream';
      headers['Last-Event-ID'] = String(after);
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(new URL(route, config.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : payload,
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
    });
    if (response.status !== expected) {
      await response.body?.cancel();
      report.failureHttpStatus = response.status;
      throw new Error(`Unexpected HTTP status at ${stage}`);
    }
    if (stream) return response;
    const text = await boundedText(response);
    return {
      data: expected >= 400 ? null : JSON.parse(text),
      replayed: response.headers.get('x-qwen-idempotent-replay') === 'true',
    };
  };
  const wait = async (read, accept) => {
    const deadline = Date.now() + config.timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const value = await read();
      if (accept(value)) return value;
      await delay(200);
    }
    throw new Error(`Timed out at ${stage}`);
  };
  const fileState = async (owner, file, absent = false) => {
    const base = { workspaceId: owner.workspaceId, cwdRelative: '.' };
    const { data: listing } = await request(
      owner.actor,
      `${workspaceFiles}/query`,
      { method: 'POST', body: { ...base, directory: '.', query: file } },
    );
    if (absent) {
      assert.ok(
        !listing.truncated &&
          !listing.entries.some((entry) => entry.path === file),
        'A forbidden physical effect exists',
      );
      report.effects.push({
        workspaceId: owner.workspaceId,
        path: file,
        stage,
        absent: true,
      });
      await save(report);
      return;
    }
    if (!listing.entries.some((entry) => entry.path === file)) return null;
    const { data } = await request(owner.actor, `${workspaceFiles}/read`, {
      method: 'POST',
      body: {
        ...base,
        path: file,
        expectedScopeRevision: listing.scopeRevision,
      },
    });
    report.effects.push({
      workspaceId: owner.workspaceId,
      path: file,
      stage,
      byteLength: Buffer.byteLength(data.text),
      sha256: createHash('sha256').update(data.text).digest('hex'),
    });
    await save(report);
    return data.text;
  };
  const submit = async (owner, text, suffix) => {
    const { data } = await request(
      owner.actor,
      `${publicSessions}/${owner.id}/events`,
      {
        method: 'POST',
        body: {
          type: 'agent.session.input.message',
          input: [{ type: 'text', text }],
        },
        key: `${config.runId}-${suffix}`,
        expected: 202,
      },
    );
    assert.equal(data.session_id, owner.id);
    assert.ok(typeof data.turn_id === 'string' && data.turn_id.length > 0);
    report.turns.push({
      sessionId: owner.id,
      turnId: data.turn_id,
      idempotencyKey: `${config.runId}-${suffix}`,
    });
    await save(report);
    return data.turn_id;
  };
  const settled = async (owner, turnId, terminal = 'turn.completed') => {
    const { data } = await wait(
      () =>
        request(
          owner.actor,
          `${publicSessions}/${owner.id}/events?after=0&limit=100`,
        ),
      (page) =>
        page.data.data.some(
          (event) => event.turn_id === turnId && event.terminal,
        ),
    );
    assert.ok(
      !data.has_more,
      'Qualification transcript must fit its bounded page',
    );
    assert.ok(
      data.data.every((event) => event.session_id === owner.id),
      'JSON feed returned a different Session',
    );
    const terminals = data.data.filter(
      (event) => event.turn_id === turnId && event.terminal,
    );
    assert.equal(
      terminals.length,
      1,
      'Exactly one original terminal is required',
    );
    assert.equal(terminals[0].type, terminal);
    return data.data;
  };
  const operation = async (owner, id) => {
    assert.ok(typeof id === 'string' && id.length > 0);
    let receipt = report.operations.find(
      (value) => value.id === id && value.sessionId === owner.id,
    );
    if (!receipt) {
      receipt = { sessionId: owner.id, id, status: 'awaiting' };
      report.operations.push(receipt);
      await save(report);
    }
    const { data } = await wait(
      () =>
        request(
          owner.actor,
          `${publicSessions}/${owner.id}/operations/${encodeURIComponent(id)}`,
        ),
      (value) => ['completed', 'failed'].includes(value.data.status),
    );
    assert.equal(data.status, 'completed');
    receipt.status = data.status;
    await save(report);
  };
  const decide = async (
    owner,
    turnId,
    decision,
    suffix,
    command,
    beforeDecision,
    awaitCompletion = true,
  ) => {
    const { data } = await wait(
      () => request(owner.actor, `${publicSessions}/${owner.id}/actions`),
      (page) =>
        page.data.data.some(
          (action) => action.turn_id === turnId && action.state === 'requested',
        ),
    );
    const actions = data.data.filter(
      (action) => action.turn_id === turnId && action.state === 'requested',
    );
    assert.equal(
      actions.length,
      1,
      'One original permission request is required',
    );
    const action = actions[0];
    assert.equal(action.kind, 'permission');
    assert.ok(
      action.options.some((option) => option.id === decision),
      'Decision was not offered',
    );
    assert.equal(action.tool_name, 'run_shell_command');
    assert.equal(
      action.input_preview?.truncated,
      false,
      'A complete Shell input preview is required',
    );
    const preview = JSON.parse(action.input_preview.text);
    assert.equal(preview.toolName, 'run_shell_command');
    assert.equal(
      preview.input.command,
      command,
      'Only the exact qualification command may be approved',
    );
    assert.ok(
      !preview.input.is_background,
      'Only foreground execution is qualified',
    );
    await beforeDecision();
    report.actions.push({
      sessionId: owner.id,
      turnId,
      id: action.id,
      inputRevision: action.input_revision,
      policyRevision: action.policy_revision,
      decision,
      idempotencyKey: `${config.runId}-${suffix}`,
    });
    await save(report);
    const route = `${publicSessions}/${owner.id}/actions/${encodeURIComponent(action.id)}/responses`;
    const body = {
      kind: 'permission',
      input_revision: action.input_revision,
      policy_revision: action.policy_revision,
      option_id: decision,
    };
    const intruder = config.actors.find(
      (actor) =>
        actor.tenantId === owner.actor.tenantId &&
        actor.actorId !== owner.actor.actorId,
    );
    await request(intruder, route, {
      method: 'POST',
      body,
      key: `${config.runId}-${suffix}-forbidden`,
      expected: 404,
    });
    const first = await request(owner.actor, route, {
      method: 'POST',
      body,
      key: `${config.runId}-${suffix}`,
      expected: 202,
    });
    assert.ok(
      typeof first.data.id === 'string' && first.data.id.length > 0,
      'Permission operation identity is required',
    );
    report.operations.push({
      sessionId: owner.id,
      id: first.data.id,
      status: 'awaiting',
    });
    await save(report);
    const replay = await request(owner.actor, route, {
      method: 'POST',
      body,
      key: `${config.runId}-${suffix}`,
      expected: 202,
    });
    assert.equal(first.data.id, replay.data.id);
    assert.ok(
      replay.replayed || replay.data.replayed,
      'Permission replay receipt is required',
    );
    if (awaitCompletion) await operation(owner, first.data.id);
    return first.data.id;
  };
  try {
    const first = config.actors[0];
    const agentRoute = `/v1/agents/${encodeURIComponent(first.filesAgentId)}`;
    await request(first, agentRoute, { unsigned: true, expected: 401 });
    await request(first, agentRoute, { tampered: true, expected: 401 });
    await request(first, agentRoute);
    await record('signed authentication and tamper refusal');
    stage = 'public admission';
    const owners = [];
    for (const [index, actor] of config.actors.entries()) {
      const { data: workspace } = await request(
        actor,
        '/api/agent/web-shell/v1/workspaces/create',
        {
          method: 'POST',
          body: {
            displayName: `${config.runId}-${index}`,
            idempotencyKey: `${config.runId}-workspace-${index}`,
          },
        },
      );
      assert.ok(
        typeof workspace.workspaceId === 'string' &&
          workspace.workspaceId.length > 0,
      );
      report.workspaces.push({
        tenantId: actor.tenantId,
        actorId: actor.actorId,
        id: workspace.workspaceId,
      });
      await save(report);
      const own = await request(
        actor,
        `/v1/agents/workspaces/${encodeURIComponent(workspace.workspaceId)}`,
      );
      assert.equal(own.data.id, workspace.workspaceId);
      for (const intruder of config.actors.filter(
        (other) =>
          other.tenantId !== actor.tenantId || other.actorId !== actor.actorId,
      ))
        await request(
          intruder,
          `/v1/agents/workspaces/${encodeURIComponent(workspace.workspaceId)}`,
          { expected: 404 },
        );
      for (const [lane, agentId] of [
        ['files', actor.filesAgentId],
        ['shell', actor.shellAgentId],
      ]) {
        const key = `${config.runId}-session-${index}-${lane}`;
        const body = {
          agent_id: agentId,
          input: [],
          workspace: { workspace_id: workspace.workspaceId, cwd_relative: '.' },
        };
        const { data: session } = await request(actor, publicSessions, {
          method: 'POST',
          body,
          key,
          expected: 202,
        });
        assert.ok(
          typeof session.id === 'string' &&
            /^[A-Za-z0-9._:-]{1,128}$/u.test(session.id),
        );
        const owner = {
          actor,
          workspaceId: workspace.workspaceId,
          id: session.id,
          lane,
        };
        report.sessions.push({
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          id: session.id,
          lane,
        });
        owners.push(owner);
        await save(report);
        const replay = await request(actor, publicSessions, {
          method: 'POST',
          body,
          key,
          expected: 202,
        });
        assert.equal(replay.data.id, session.id);
        assert.ok(replay.replayed, 'Session replay receipt is required');
        for (const intruder of [
          config.actors.find((other) => other.tenantId !== actor.tenantId),
          config.actors.find(
            (other) =>
              other.tenantId === actor.tenantId &&
              other.actorId !== actor.actorId,
          ),
        ]) {
          for (const tail of ['', '/events?after=0&limit=1', '/items'])
            await request(intruder, `${publicSessions}/${session.id}${tail}`, {
              expected: 404,
            });
        }
      }
    }
    assert.equal(
      new Set(
        report.sessions.map((session) =>
          JSON.stringify([session.tenantId, session.actorId, session.id]),
        ),
      ).size,
      8,
      'Each admission lane must create a distinct Session',
    );
    await record(
      'two tenants and four users admit replay-safe Sessions with scoped access',
    );
    stage = 'physical file effects';
    for (const [index, owner] of owners
      .filter((owner) => owner.lane === 'files')
      .entries()) {
      const file = `${config.runId}-file-${index}.txt`;
      const expected = `edited-${config.runId}-${index}`;
      const turn = await submit(
        owner,
        `Use write_file to create ${file} containing initial-${config.runId}-${index}. Read it with read_file, then use edit to make it contain exactly ${expected} with no newline. Use no shell or other tools.`,
        `files-${index}`,
      );
      const events = await settled(owner, turn);
      assert.equal(
        await fileState(owner, file),
        expected,
        'Physical file content differs',
      );
      const tools = events.filter(
        (event) =>
          event.turn_id === turn &&
          event.type === 'item.tool_call.updated' &&
          event.data?.status === 'completed',
      );
      for (const name of ['write_file', 'read_file', 'edit'])
        assert.ok(
          tools.some((event) => event.data.name === name),
          `Persisted ${name} completion is required`,
        );
      const next = await submit(
        owner,
        'Without using tools, repeat the final text you put in the file in your previous turn.',
        `history-${index}`,
      );
      const history = await settled(owner, next);
      assert.ok(
        !history.some(
          (event) =>
            event.turn_id === next && event.type === 'item.tool_call.updated',
        ),
        'History must be recalled without another tool execution',
      );
      assert.ok(
        history
          .filter(
            (event) =>
              event.turn_id === next && event.type === 'item.output_text.delta',
          )
          .map((event) => event.data.text)
          .join('')
          .includes(expected),
        'Next Turn did not retain original history',
      );
    }
    await record('physical per-Workspace write/read/edit effects');
    const shell = owners.find((owner) => owner.lane === 'shell');
    for (const decision of ['allow', 'deny']) {
      stage = `shell ${decision}`;
      const file = `${config.runId}-${decision}.txt`,
        token = `${config.runId}-${decision}`;
      const command = `printf '${token}\\n' >> '${file}'`;
      const turn = await submit(
        shell,
        `Run exactly this foreground shell command, request permission and do not retry it: ${command}`,
        `shell-${decision}`,
      );
      await decide(shell, turn, decision, `decision-${decision}`, command, () =>
        fileState(shell, file, true),
      );
      const events = await settled(shell, turn);
      if (decision === 'allow')
        assert.equal(
          await fileState(shell, file),
          `${token}\n`,
          'Shell effect must occur exactly once',
        );
      else await fileState(shell, file, true);
      if (decision === 'allow') {
        stage = 'SSE disconnect and resume';
        const response = await request(
          shell.actor,
          `${publicSessions}/${shell.id}/events?stream=true`,
          { stream: true },
        );
        const initial = await readSse(response, shell.id, 0, () => true);
        const after = initial[0].sequence;
        const cursor = {
          sessionId: shell.id,
          disconnectedAtSequence: after,
          resumedThroughSequence: null,
        };
        report.eventCursors.push(cursor);
        await save(report);
        const last = events.at(-1).sequence;
        assert.ok(last > after, 'Need events on both sides of the reconnect');
        const resumed = await readSse(
          await request(
            shell.actor,
            `${publicSessions}/${shell.id}/events?stream=true`,
            { stream: true, after },
          ),
          shell.id,
          after,
          (event) => event.sequence === last,
        );
        assert.deepEqual(
          resumed,
          events.filter((event) => event.sequence > after),
        );
        cursor.resumedThroughSequence = resumed.at(-1).sequence;
        await record(
          'actual SSE disconnect/resume matches the scoped JSON feed',
        );
      }
    }
    await record(
      'Shell Allow/Deny, physical effects and idempotent permission decisions',
    );
    stage = 'foreground cancellation';
    const cancelFile = `${config.runId}-cancel.txt`;
    const command = `printf '${config.runId}\\n' >> '${cancelFile}'; sleep 60`;
    const turn = await submit(
      shell,
      `Run exactly this foreground shell command, request permission and do not retry it: ${command}`,
      'cancel-input',
    );
    const decision = await decide(
      shell,
      turn,
      'allow',
      'cancel-allow',
      command,
      () => fileState(shell, cancelFile, true),
      false,
    );
    await wait(
      () => fileState(shell, cancelFile),
      (text) => text === `${config.runId}\n`,
    );
    await request(shell.actor, `${publicSessions}/${shell.id}/events`, {
      method: 'POST',
      body: { type: 'agent.session.cancel', turn_id: turn },
      key: `${config.runId}-cancel`,
      expected: 202,
    });
    await settled(shell, turn, 'turn.cancelled');
    await operation(shell, decision);
    assert.equal(
      await fileState(shell, cancelFile),
      `${config.runId}\n`,
      'Cancellation replayed the physical effect',
    );
    await record(
      'original foreground Turn cancellation and no duplicate physical effect',
    );
    stage = 'close';
    for (const owner of owners) {
      const { data } = await request(
        owner.actor,
        `${publicSessions}/${owner.id}/close`,
        {
          method: 'POST',
          body: {},
          key: `${config.runId}-close-${owner.id}`,
          expected: 202,
        },
      );
      await operation(owner, data.id);
    }
    await record('all admitted Sessions closed with completed operations');
    report.status = 'PUBLIC_SCENARIOS_PASSED';
  } catch {
    report.status = 'FAILED';
    report.failedStage = stage;
  }
  report.completedAt = new Date().toISOString();
  await save(report);
  return report;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: 'string' },
        output: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help)
      console.log(
        'node --import tsx scripts/run-managed-harness-qualification.mjs --config PRIVATE_CONFIG.json --output NEW_REPORT.json',
      );
    else {
      assert.ok(values.config && values.output);
      const config = JSON.parse(await readFile(values.config, 'utf8'));
      validateConfig(config);
      const keyFile = path.resolve(
        path.dirname(values.config),
        config.signingKeyFile,
      );
      const info = await stat(keyFile);
      assert.ok(
        process.platform === 'win32' || (info.mode & 0o077) === 0,
        'Signing key file must be private',
      );
      const key = (await readFile(keyFile, 'utf8')).trim();
      await mkdir(path.dirname(path.resolve(values.output)), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(values.output, '{}\n', { mode: 0o600, flag: 'wx' });
      const report = await qualify(config, key, (value) =>
        writeFile(values.output, JSON.stringify(value, null, 2) + '\n', {
          mode: 0o600,
        }),
      );
      console.log(
        JSON.stringify({
          status: report.status,
          report: values.output,
          placementAcceptance: report.placementAcceptance,
          faultAcceptance: report.faultAcceptance,
        }),
      );
      if (report.status !== 'PUBLIC_SCENARIOS_PASSED') process.exitCode = 1;
    }
  } catch {
    console.error(
      'Qualification configuration or transport failed; no credentials or response bodies are logged.',
    );
    process.exitCode = 1;
  }
}
