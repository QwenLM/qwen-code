/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Issue #13533 finding A2 reproduction driver: drive session α through the
// A1 chain (background Shell start -> publication reserve 400 -> cancel ->
// close_not_started 400 -> turn recovery-blocked) against a real managed
// agent server + MariaDB, then start session β's first turn on the SAME
// hosted harness daemon and record whether it wedges after the
// `hostedModelAttempt` journal commit with the model never called. The Java
// side (HostedRecoveryBlockedWedgeIT) owns server/DB evidence and clears
// session α's store rows; this driver then verifies β's turn completes.

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  access,
} from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { LISTENING_LINE_RE, stopDaemon } from './daemon-process.js';
import { HOSTED_HOME_PREFIX } from '../scratch-dir.js';
import { relayUpstream } from './hosted-relay-headers.js';
import { waitUntil } from './hosted-harness-process.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  tenantId: string;
  storeUrl: string;
  brokerUrl: string;
  cliEntry: string;
  arm?: 'wedge' | 'publication';
  driveFault: boolean;
  control: boolean;
  bPreloaded?: boolean;
  bCaptureBytes?: number;
  bToolProfile?: string;
  holdAfterBlockMs?: number;
  injectReserveDenyForSessionId?: string;
  phaseFile: string;
  clearedFile: string;
  wireFile: string;
  evidenceDir: string;
  reportsDir: string;
  sessions: Array<{
    sessionId: string;
    workspaceId: string;
    directory: string;
    toolProfile: string;
    role?: 'background' | 'monitor' | 'foreground' | 'edge' | 'probe';
    shellCommand?: string;
  }>;
};

const HOSTED_TOKEN = 'hosted-wedge-fixture-token';
const HOSTED_DIGEST = `sha256:${'a'.repeat(64)}`;
await mkdir(config.reportsDir, { recursive: true });
await mkdir(config.evidenceDir, { recursive: true });
await writeFile(config.wireFile, '');
const aMarker = `A_TURN_${randomUUID()}`;
const bMarker = `B_TURN_${randomUUID()}`;
const cMarker = `C_TURN_${randomUUID()}`;
const aSession = config.sessions[0];
const bSession = config.sessions[1];
const cSession = config.sessions[2];
const direct = config.control === true;

async function wire(entry: Record<string, unknown>) {
  await appendFile(
    config.wireFile,
    JSON.stringify({ t: Date.now(), ...entry }) + '\n',
  );
}

async function phase(name: string) {
  await writeFile(config.phaseFile, `${name}\n`);
  console.log(`PHASE=${name}`);
}

class WedgeDaemon {
  root = '';
  baseUrl = '';
  bootId = '';
  output = '';
  child?: ChildProcess;

  async start(modelUrl: string): Promise<this> {
    this.root = await mkdtemp(path.join(tmpdir(), HOSTED_HOME_PREFIX));
    const configDir = path.join(this.root, '.qwen');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        model: { name: 'hosted-wedge' },
        telemetry: { enabled: false },
        modelProviders: {
          openai: [
            {
              id: 'hosted-wedge',
              envKey: 'OPENAI_API_KEY',
              baseUrl: modelUrl,
            },
          ],
        },
      }),
    );
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TMP|TEMP|TMPDIR|HOME|USERPROFILE)$/i.test(
          key,
        )
      )
        env[key] = value;
    }
    this.child = spawn(
      process.execPath,
      [
        '--report-on-signal',
        '--report-signal',
        'SIGUSR2',
        '--report-directory',
        config.reportsDir,
        config.cliEntry,
        'serve',
        '--profile',
        'hosted-harness',
        '--http-bridge',
        '--no-web',
        '--hostname',
        '127.0.0.1',
        '--port',
        '0',
        '--token',
        HOSTED_TOKEN,
        '--hosted-harness-capability-digest',
        HOSTED_DIGEST,
        '--workspace',
        this.root,
        '--managed-runtime-broker-url',
        config.brokerUrl,
        '--managed-runtime-broker-token',
        'hosted-tools-broker-token',
      ],
      {
        cwd: this.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...env,
          HOME: this.root,
          USERPROFILE: this.root,
          QWEN_HOME: configDir,
          QWEN_CODE_MODELS_DEV_REFRESH: 'off',
          QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(
            this.root,
            'system-settings.json',
          ),
          QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(
            this.root,
            'system-defaults.json',
          ),
          QWEN_RUNTIME_DIR: path.join(this.root, 'runtime'),
          OPENAI_API_KEY: 'local-wedge-key',
          OPENAI_BASE_URL: modelUrl,
          OPENAI_MODEL: 'hosted-wedge',
          QWEN_MODEL: 'hosted-wedge',
          QWEN_SANDBOX: 'false',
          NO_COLOR: '1',
        },
      },
    );
    const append = (data: Buffer) => {
      this.output = (this.output + data.toString()).slice(-32_768);
    };
    this.child.stdout!.on('data', append);
    this.child.stderr!.on('data', append);
    await waitUntil(() => {
      if (this.child!.exitCode !== null || this.child!.signalCode !== null)
        throw new Error(`Wedge harness daemon exited: ${this.output}`);
      const port = this.output.match(LISTENING_LINE_RE)?.groups?.['port'];
      if (port) this.baseUrl = `http://127.0.0.1:${port}`;
      return !!port;
    }, 60_000);
    await waitUntil(async () => {
      const capabilities = await this.request('/capabilities');
      if (capabilities.status === 503) return false;
      const text = await capabilities.text();
      if (!capabilities.ok)
        throw new Error(`Capabilities ${capabilities.status}: ${text}`);
      this.bootId = (
        JSON.parse(text) as { hostedHarness: { bootId: string } }
      ).hostedHarness.bootId;
      return true;
    }, 60_000);
    return this;
  }

  headers(clientId?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${HOSTED_TOKEN}`,
      'X-Qwen-Harness-Protocol-Version': '1',
      'X-Qwen-Harness-Boot-Id': this.bootId,
      ...(clientId ? { 'X-Qwen-Client-Id': clientId } : {}),
    };
  }

  async json(
    route: string,
    clientId: string,
    body?: unknown,
    expected = 200,
    method = body === undefined ? 'GET' : 'POST',
  ) {
    const response = await fetch(this.baseUrl + route, {
      method,
      headers: {
        ...this.headers(clientId),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (response.status !== expected)
      throw new Error(
        `${method} ${route} -> ${response.status}: ${text}\ndaemon: ${this.output}`,
      );
    return text ? JSON.parse(text) : undefined;
  }

  request(route: string, init: RequestInit = {}) {
    return fetch(this.baseUrl + route, {
      ...init,
      headers: init.headers ?? this.headers(),
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  }

  keepRoot = false;

  async close() {
    if (this.child) await stopDaemon(this.child);
    if (!this.keepRoot)
      await rm(this.root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  }
}

async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Transparent store relay that records the session-store / publication wire
// so the wedge can be localized by operation name. All request headers are
// forwarded wholesale; hop-by-hop response headers follow relayUpstream.
// In-flight store requests get a requestId with a begin/end pair so a server
// side that never answers still leaves a trace (a plain end-only log cannot
// see the commit that hung mid-flight).
let storeRequestCounter = 0;
let reserveDenyArmed = config.injectReserveDenyForSessionId !== undefined;
const reserveBodies = new Map<string, string>();
const reserveHeaders = new Map<string, Record<string, string>>();
const storeProxy = createServer(async (req, res) => {
  const at = Date.now();
  const requestId = ++storeRequestCounter;
  try {
    const payload = await bytes(req);
    let operation: string | undefined;
    try {
      const parsed = payload.length ? JSON.parse(payload.toString()) : {};
      if (req.url?.includes('/transactions:commit'))
        operation = `commit:${parsed.operation}`;
      else if (req.url?.includes('/grants'))
        operation = `grants:${parsed.operation}`;
      else if (req.url?.includes(':publish'))
        operation = `publish:${parsed.kind}`;
      else operation = undefined;
    } catch {
      operation = 'unparsed';
    }
    await wire({
      kind: 'store-begin',
      requestId,
      at,
      method: req.method,
      url: req.url,
      operation,
      requestSnippet: payload.toString().slice(0, 600),
    });
    if (operation === 'grants:reserve') {
      const sidMatch = req.url?.match(/\/sessions\/([^/]+)\/grants/);
      if (sidMatch) {
        reserveBodies.set(sidMatch[1], payload.toString());
        reserveHeaders.set(sidMatch[1], {
          'content-type': 'application/json',
          'x-qwen-tenant-id': String(req.headers['x-qwen-tenant-id']),
          'x-qwen-managed-writer-token': String(
            req.headers['x-qwen-managed-writer-token'],
          ),
          'x-qwen-managed-writer-id': String(
            req.headers['x-qwen-managed-writer-id'],
          ),
          'x-qwen-managed-writer-generation': String(
            req.headers['x-qwen-managed-writer-generation'],
          ),
          ...(req.headers['x-qwen-tool-publication-token']
            ? {
                'x-qwen-tool-publication-token': String(
                  req.headers['x-qwen-tool-publication-token'],
                ),
              }
            : {}),
        });
      }
    }
    // A2 wedge-arm substitute (post-A1-fix world): the A1 400-chain no longer
    // exists at the contract, so α's failed-start leftovers are reproduced by
    // injecting the same 400 invalid_request wire onto the admitted family's
    // first reserve — the turn then runs its real cancel/cleanup path and
    // lands the same recovery-blocked shape the A1 chain produced.
    if (
      reserveDenyArmed &&
      operation === 'grants:reserve' &&
      req.url?.includes(`/sessions/${config.injectReserveDenyForSessionId}/`)
    ) {
      reserveDenyArmed = false;
      const body = JSON.stringify({
        error: {
          code: 'invalid_request',
          message: 'The request body is invalid.',
          request_id: randomUUID(),
        },
      });
      await wire({
        kind: 'store-end',
        requestId,
        at,
        method: req.method,
        url: req.url,
        operation,
        status: 400,
        injected: true,
        responseSnippet: body,
      });
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    const headers = { ...req.headers } as Record<string, string>;
    delete headers['host'];
    delete headers['content-length'];
    delete headers['connection'];
    const response = await fetch(new URL(req.url!, config.storeUrl), {
      method: req.method,
      headers,
      ...(payload.length ? { body: payload } : {}),
      // A wedged server must not stall the relay indefinitely: 120 s is far
      // past every healthy response here and past the wedge threshold.
      signal: AbortSignal.timeout(120_000),
    });
    const output = Buffer.from(await response.arrayBuffer());
    await wire({
      kind: 'store-end',
      requestId,
      at,
      method: req.method,
      url: req.url,
      operation,
      status: response.status,
      responseSnippet: output.toString().slice(0, 600),
    });
    relayUpstream(res, response, output);
  } catch (cause) {
    await wire({
      kind: 'store-end',
      requestId,
      at,
      method: req.method,
      url: req.url,
      status: 598,
      responseSnippet: String(cause),
    });
    res.writeHead(598);
    res.end(String(cause));
  }
});
await new Promise<void>((resolve) =>
  storeProxy.listen(0, '127.0.0.1', resolve),
);
const proxyAddress = storeProxy.address();
if (!proxyAddress || typeof proxyAddress === 'string')
  throw new Error('store proxy did not bind');
const storeProxyUrl = `http://127.0.0.1:${proxyAddress.port}`;

let modelCallsA = 0;
let modelCallsB = 0;
let modelBAnsweredAt = 0;
const faultArmed = config.driveFault === true;
// Per-session role replies for the publication arm; wedge arms keep α's
// admitted background start plus plain-text probes.
const extraMarkers = [`D_TURN_${randomUUID()}`, `E_TURN_${randomUUID()}`];
const allMarkers = [aMarker, bMarker, cMarker, ...extraMarkers];
const sessionByMarker = new Map(
  config.sessions.map((session, index) => [allMarkers[index], session]),
);
const issued = new Set<string>();
const model = await startFakeOpenAIServer(({ body }) => {
  const text = JSON.stringify(body);
  const tools =
    (body['tools'] as Array<{ function: { name: string } }> | undefined) ?? [];
  const messages =
    (body['messages'] as
      | Array<{ role: string; content: unknown }>
      | undefined) ?? [];
  const entry = {
    kind: 'model',
    tools: tools.map((tool) => tool.function.name),
    roles: messages.map((message) => message.role),
  };
  if (text.includes(aMarker)) modelCallsA += 1;
  for (const [marker, session] of sessionByMarker) {
    if (!text.includes(marker)) continue;
    const role =
      session.role ?? (session === aSession ? 'background' : 'probe');
    // α owns the admitted-background reply only when a fault arm or the
    // publication arm asks for it; the control arm keeps α a plain-text
    // session so the healthy baseline stays healthy.
    const wantsFaultShell =
      role === 'background' && (faultArmed || config.arm === 'publication');
    if (wantsFaultShell) {
      if (!issued.has(session.sessionId)) {
        issued.add(session.sessionId);
        void wire({
          ...entry,
          replied: 'background-shell',
          session: session.sessionId,
        });
        return {
          toolCalls: [
            fakeToolCall(
              'run_shell_command',
              {
                command: session.shellCommand ?? 'sleep 25',
                timeout: 60_000,
                description: 'admitted background Shell start',
                is_background: true,
              },
              `bg-${session.sessionId.slice(0, 8)}`,
            ),
          ],
        };
      }
      const toolContent = messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.stringify(message.content).slice(0, 500));
      void wire({ ...entry, replied: 'background-second', toolContent });
      return { content: 'BACKGROUND_SECOND_CALL' };
    }
    if (role === 'monitor') {
      if (!issued.has(session.sessionId)) {
        issued.add(session.sessionId);
        void wire({
          ...entry,
          replied: 'monitor-start',
          session: session.sessionId,
        });
        return {
          toolCalls: [
            fakeToolCall(
              'monitor',
              {
                command: session.shellCommand ?? 'printf MON_OK\\n; sleep 1',
                idle_timeout_ms: 2_000,
                max_events: 5,
                description: 'admitted Monitor start',
              },
              `mon-${session.sessionId.slice(0, 8)}`,
            ),
          ],
        };
      }
      const toolContent = messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.stringify(message.content).slice(0, 500));
      void wire({ ...entry, replied: 'monitor-second', toolContent });
      return { content: 'MONITOR_SECOND_CALL' };
    }
    if (role === 'foreground') {
      if (!issued.has(session.sessionId)) {
        issued.add(session.sessionId);
        void wire({
          ...entry,
          replied: 'foreground-shell',
          session: session.sessionId,
        });
        return {
          toolCalls: [
            fakeToolCall(
              'run_shell_command',
              {
                command: session.shellCommand ?? 'printf FG_OK\\n',
                timeout: 60_000,
              },
              `fg-${session.sessionId.slice(0, 8)}`,
            ),
          ],
        };
      }
      const toolContent = messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.stringify(message.content).slice(0, 500));
      void wire({ ...entry, replied: 'foreground-second', toolContent });
      return { content: 'FOREGROUND_COMPLETE' };
    }
    modelCallsB += 1;
    modelBAnsweredAt = Date.now();
    void wire({ ...entry, replied: 'probe-text' });
    return { content: 'PROBE_TURN_COMPLETE' };
  }
  void wire({ ...entry, replied: 'other-text' });
  return { content: 'UNEXPECTED' };
});

const daemon = await new WedgeDaemon().start(model.baseUrl);

interface WireRow {
  kind?: string;
  requestId?: number;
  at?: number;
  method?: string;
  url?: string;
  operation?: string;
  status?: number;
  requestSnippet?: string;
  responseSnippet?: string;
  replied?: string;
}

async function readWire(): Promise<WireRow[]> {
  try {
    return (await readFile(config.wireFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WireRow);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw cause;
  }
}

async function evidenceFile(name: string, content: string) {
  await writeFile(path.join(config.evidenceDir, name), content);
}

try {
  const connectionFor = (workspaceId: string) => ({
    baseUrl: storeProxyUrl,
    tenantId: config.tenantId,
    workspaceId,
    writerId: daemon.bootId,
    leaseDurationMs: 60_000,
  });

  // --- Session α: drive the A1 chain into recovery-blocked ----------------
  // The A1 reserve path lives in the v3 publication lane: a Shell-profile
  // Session only owns it when created with captureBytes. The publication arm
  // creates every session through the generic path below instead, so this
  // legacy attach runs only for wedge arms (a second POST /session for the
  // same id is exactly what the daemon's already_attached guard exists for).
  const createdA =
    config.arm === 'publication'
      ? { clientId: '' }
      : ((await daemon.json('/session', '', {
          sessionId: aSession.sessionId,
          sessionScope: 'thread',
          managedSessionStore: connectionFor(aSession.workspaceId),
          toolProfile: aSession.toolProfile,
          captureBytes: 64 * 1024 * 1024,
        })) as { clientId: string });
  const aClient = createdA.clientId;
  const promptA = async () => {
    const aBlocks = [{ type: 'text', text: `Session alpha prompt ${aMarker}` }];
    await daemon.json(
      `/session/${aSession.sessionId}/prompt`,
      aClient,
      {
        promptId: randomUUID(),
        prompt: aBlocks,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(aBlocks)).digest('hex')}`,
      },
      202,
    );
  };
  const driveAFault = async () => {
    await promptA();
    await waitUntil(async () => {
      const status = await daemon.json(
        `/session/${aSession.sessionId}/status`,
        aClient,
      );
      return status.recoveryBlocked === true;
    }, 180_000);
    const status = await daemon.json(
      `/session/${aSession.sessionId}/status`,
      aClient,
    );
    console.log(`A_BLOCKED_STATUS=${JSON.stringify(status)}`);
    const rows = await readWire();
    // The server answers contract refusals with a deliberately generic
    // 400 invalid_request envelope; the exception text stays server-side.
    const reserveDenied = rows.find(
      (row) =>
        row.kind === 'store-end' &&
        row.operation === 'grants:reserve' &&
        row.status === 400 &&
        typeof row.responseSnippet === 'string' &&
        row.responseSnippet.includes('invalid_request'),
    );
    const closeDenied = rows.find(
      (row) =>
        row.kind === 'store-end' &&
        row.operation === 'grants:close_not_started' &&
        (row.status ?? 0) >= 400 &&
        (row.status ?? 0) < 500,
    );
    await evidenceFile(
      'a1-chain.txt',
      [
        `reserveDenied=${JSON.stringify(reserveDenied, null, 2)}`,
        `closeDenied=${JSON.stringify(closeDenied, null, 2)}`,
        `modelCallsA=${modelCallsA}`,
      ].join('\n'),
    );
    if (!reserveDenied || !closeDenied)
      throw new Error(
        `A1 chain did not materialize on the wire: reserve=${JSON.stringify(
          reserveDenied,
        )} close=${JSON.stringify(closeDenied)}`,
      );
    await phase('A_BLOCKED');
    if (config.holdAfterBlockMs) {
      console.log(`HOLDING_BLOCKED_STATE_MS=${config.holdAfterBlockMs}`);
      await new Promise((resolve) =>
        setTimeout(resolve, config.holdAfterBlockMs),
      );
      const heldRows = await readWire();
      const renewals = heldRows.filter(
        (row) =>
          row.kind === 'store-end' &&
          row.status === 200 &&
          (row.operation?.includes('renew') ?? false),
      );
      console.log(`A_RENEWALS_WHILE_BLOCKED=${renewals.length}`);
      await evidenceFile(
        'a-renewals.txt',
        renewals.map((row) => JSON.stringify(row)).join('\n'),
      );
    }
  };
  const driveAControlTurn = async () => {
    await promptA();
    await waitUntil(
      async () =>
        !(await daemon.json(`/session/${aSession.sessionId}/status`, aClient))
          .hasActivePrompt,
      120_000,
    );
    const status = await daemon.json(
      `/session/${aSession.sessionId}/status`,
      aClient,
    );
    console.log(`A_CONTROL_STATUS=${JSON.stringify(status)}`);
    await phase('A_COMPLETED');
  };

  // --- Probe turns for the non-blocked sessions on the same daemon ---------
  // A probe session's creation moment is part of the matrix (preloaded vs
  // fresh), so it is created where each arm decides, never earlier.
  interface ProbeTurn {
    outcome: 'completed' | 'wedged';
    promptId: string;
    promptAt: number;
    attemptAt: number;
    attemptHangingAt: number;
    hangingCommit: unknown;
    commitMessageAt: number;
    sessionId: string;
    clientId: string;
  }
  const createSession = async (
    entry: (typeof config.sessions)[number],
    toolProfile: string,
    captureBytes: number,
  ): Promise<string> => {
    const body: Record<string, unknown> = {
      sessionId: entry.sessionId,
      sessionScope: 'thread',
      managedSessionStore: connectionFor(entry.workspaceId),
      toolProfile,
      ...(captureBytes ? { captureBytes } : {}),
    };
    const response = await fetch(daemon.baseUrl + '/session', {
      method: 'POST',
      headers: { ...daemon.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (response.status !== 200) {
      await evidenceFile(
        `create-session-${entry.sessionId.slice(0, 8)}.txt`,
        `body=${JSON.stringify(body, null, 2)}\nstatus=${response.status}\nresponse=${text}`,
      );
      throw new Error(
        `create session ${entry.sessionId} -> ${response.status}: ${text}`,
      );
    }
    return (JSON.parse(text) as { clientId: string }).clientId;
  };
  async function driveProbeTurn(
    entry: (typeof config.sessions)[number],
    clientId: string,
    marker: string,
  ): Promise<ProbeTurn> {
    const turn: ProbeTurn = {
      outcome: 'completed',
      promptId: randomUUID(),
      promptAt: Date.now(),
      attemptAt: 0,
      attemptHangingAt: 0,
      hangingCommit: undefined,
      commitMessageAt: 0,
      sessionId: entry.sessionId,
      clientId,
    };
    const bBlocks = [{ type: 'text', text: `Session probe prompt ${marker}` }];
    const modelBefore = modelBAnsweredAt;
    await daemon.json(
      `/session/${entry.sessionId}/prompt`,
      clientId,
      {
        promptId: turn.promptId,
        prompt: bBlocks,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(bBlocks)).digest('hex')}`,
      },
      202,
    );
    const deadline = turn.promptAt + 120_000;
    while (Date.now() < deadline) {
      const rows = await readWire();
      const session = (row: WireRow) =>
        (row.url ?? '').includes(`/sessions/${entry.sessionId}/`) &&
        (row.at ?? 0) >= turn.promptAt - 500;
      const attempt = rows.find(
        (row) =>
          row.kind === 'store-end' &&
          row.operation === 'commit:hostedModelAttempt' &&
          session(row) &&
          row.status === 200,
      );
      const commitMessage = rows.find(
        (row) =>
          row.kind === 'store-end' &&
          row.operation === 'commit:commitMessage' &&
          session(row) &&
          row.status === 200,
      );
      const committed = new Set(
        rows
          .filter((row) => row.kind === 'store-end')
          .map((row) => row.requestId),
      );
      const hanging = rows.find(
        (row) =>
          row.kind === 'store-begin' &&
          session(row) &&
          !committed.has(row.requestId ?? -1) &&
          Date.now() - (row.at ?? 0) > 15_000,
      );
      if (attempt && !turn.attemptAt) {
        turn.attemptAt = attempt.at ?? 0;
        console.log(
          `PROBE_ATTEMPT_COMMITTED_AT=${turn.attemptAt} session=${entry.sessionId}`,
        );
      }
      if (hanging && !turn.attemptHangingAt) {
        turn.attemptHangingAt = hanging.at ?? 0;
        turn.hangingCommit = hanging;
        console.log(`PROBE_HANGING_STORE_REQUEST_AT=${turn.attemptHangingAt}`);
      }
      if (commitMessage && !turn.commitMessageAt)
        turn.commitMessageAt = commitMessage.at ?? 0;
      if (modelBAnsweredAt > modelBefore) {
        console.log(
          `PROBE_MODEL_CALLED_AFTER=${modelBAnsweredAt - turn.promptAt}ms attempt=${turn.attemptAt}`,
        );
        break;
      }
      if (
        (turn.attemptAt && Date.now() - turn.attemptAt > 30_000) ||
        (turn.attemptHangingAt && Date.now() - turn.attemptHangingAt > 45_000)
      ) {
        turn.outcome = 'wedged';
        return turn;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (
      turn.attemptAt === 0 &&
      turn.attemptHangingAt === 0 &&
      modelBAnsweredAt <= modelBefore
    )
      throw new Error(
        `Probe session never reached hostedModelAttempt within 120 s; daemon: ${daemon.output}`,
      );
    await waitUntil(
      async () =>
        !(await daemon.json(`/session/${entry.sessionId}/status`, clientId))
          .hasActivePrompt,
      120_000,
    );
    console.log(
      `PROBE_TURN_COMPLETED session=${entry.sessionId} attemptAt=+${turn.attemptAt - turn.promptAt}ms commitMessageAt=+${turn.commitMessageAt - turn.promptAt}ms modelAt=+${modelBAnsweredAt - turn.promptAt}ms`,
    );
    return turn;
  }

  async function wedgeEvidence(marker: string, turn: ProbeTurn) {
    console.log(
      `PROBE_WEDGED attemptAt=${turn.attemptAt} hangingAt=${turn.attemptHangingAt} now=${Date.now()} modelCallsOther=${modelCallsB}`,
    );
    process.kill(daemon.child!.pid!, 'SIGUSR2');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const statusProbe = await daemon.json(
      `/session/${turn.sessionId}/status`,
      turn.clientId,
    );
    const statusA = await daemon.json(
      `/session/${aSession.sessionId}/status`,
      aClient,
    );
    const rows = await readWire();
    await evidenceFile(
      'probe-wedged.txt',
      [
        `marker=${marker} session=${turn.sessionId} attemptAt=${turn.attemptAt} attemptHangingAt=${turn.attemptHangingAt} modelCallsA=${modelCallsA} modelCallsOther=${modelCallsB}`,
        `hangingCommit=${JSON.stringify(turn.hangingCommit, null, 2)}`,
        `statusA=${JSON.stringify(statusA)}`,
        `statusProbe=${JSON.stringify(statusProbe)}`,
        `daemonOutputTail=${daemon.output.slice(-2000)}`,
      ].join('\n'),
    );
    await evidenceFile(
      'wire-through-wedge.jsonl',
      rows.map((row) => JSON.stringify(row)).join('\n'),
    );
    await phase('B_WEDGED_CONFIRMED');

    // The Java side clears session α's store rows now.
    await waitUntil(
      () =>
        access(config.clearedFile).then(
          () => true,
          () => false,
        ),
      300_000,
    );
    const clearedAt = Date.now();
    console.log(`CLEARED_OBSERVED_AT=${clearedAt}`);
    await waitUntil(
      () => Promise.resolve(modelBAnsweredAt > clearedAt),
      240_000,
    );
    console.log(
      `PROBE_MODEL_CALLED_AFTER_CLEAR=${modelBAnsweredAt - clearedAt}ms`,
    );
    await waitUntil(
      async () =>
        !(await daemon.json(`/session/${turn.sessionId}/status`, turn.clientId))
          .hasActivePrompt,
      240_000,
    );
    const transcript = await daemon.json(
      `/session/${turn.sessionId}/transcript?cursor=0&limit=256`,
      turn.clientId,
    );
    const events = (
      transcript as { events: Array<{ type: string; promptId?: string }> }
    ).events;
    const complete = events.filter(
      (event) =>
        event.promptId === turn.promptId && event.type === 'turn_complete',
    );
    if (complete.length !== 1)
      throw new Error(
        `Probe turn did not complete after clearing: ${JSON.stringify(events)}`,
      );
    await evidenceFile(
      'probe-recovered.txt',
      `modelBAnsweredAt=${modelBAnsweredAt} clearedAt=${clearedAt}\ntranscript terminal=${JSON.stringify(complete)}`,
    );
    await phase('B_COMPLETED_AFTER_CLEAR');
    console.log('HOSTED_RECOVERY_WEDGE_OK');
  }

  // --- background-publication acceptance arm (post-A1-fix witness) ---------
  // Three shell-profile sessions (created with captureBytes, so they own the
  // v3 publication lane): α background, μ monitor, σ foreground regression;
  // the Arm-3 δ1/δ2 refusal edges are driver-posted forged-digest replays of
  // the captured α/μ reserves, not sessions.
  if (config.arm === 'publication') {
    const evidence: string[] = [];
    const clients = new Map<string, string>();
    for (const session of config.sessions) {
      clients.set(
        session.sessionId,
        await createSession(session, session.toolProfile, 64 * 1024 * 1024),
      );
    }
    const promptFor = async (
      entry: (typeof config.sessions)[number],
      index: number,
    ) => {
      const blocks = [
        {
          type: 'text',
          text: `publication probe ${allMarkers[index]} ${randomUUID()}`,
        },
      ];
      await daemon.json(
        `/session/${entry.sessionId}/prompt`,
        clients.get(entry.sessionId)!,
        {
          promptId: randomUUID(),
          prompt: blocks,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(blocks)).digest('hex')}`,
        },
        202,
      );
    };
    const reservesFor = (sessionId: string) =>
      readWire().then((rows) =>
        rows.filter(
          (row) =>
            row.kind === 'store-end' &&
            row.operation === 'grants:reserve' &&
            (row.url ?? '').includes(`/sessions/${sessionId}/`),
        ),
      );
    const closesFor = (sessionId: string) =>
      readWire().then((rows) =>
        rows.filter(
          (row) =>
            row.kind === 'store-end' &&
            row.operation === 'grants:close_not_started' &&
            (row.url ?? '').includes(`/sessions/${sessionId}/`),
        ),
      );
    const statusOf = (entry: (typeof config.sessions)[number]) =>
      daemon.json(
        `/session/${entry.sessionId}/status`,
        clients.get(entry.sessionId)!,
      );
    const waitTurnEndsBlocked = async (
      entry: (typeof config.sessions)[number],
      timeoutMs: number,
    ) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const status = await statusOf(entry);
        if (!status.hasActivePrompt) return status;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      throw new Error(
        `${entry.sessionId} turn still active after ${timeoutMs}ms: ${JSON.stringify(await statusOf(entry))}`,
      );
    };
    // Detached-family arm state at this slice, observed off-Linux (ephemeral
    // lane): the admitted family reserves (OPEN), dispatches, the worker
    // declines the start for lack of a cgroup v2 root (not_started), the
    // grant closes NOT_STARTED, and the recoverable sibling records commit
    // before the turn blocks. Pin exactly that; do not wait for a file the
    // never-started process cannot write.
    const detachedArmOf = async (
      entry: (typeof config.sessions)[number],
      index: number,
      label: string,
    ) => {
      await promptFor(entry, index);
      await waitUntil(async () => {
        const reserves = await reservesFor(entry.sessionId);
        return reserves.some(
          (row) =>
            row.status === 200 &&
            (row.responseSnippet ?? '').includes('"OPEN"'),
        );
      }, 120_000);
      const status = await waitTurnEndsBlocked(entry, 120_000);
      const reserves = await reservesFor(entry.sessionId);
      const closes = await closesFor(entry.sessionId);
      const mutations = (await readWire()).filter(
        (row) =>
          row.operation === 'commit:commitChildRunRecord' ||
          row.operation === 'commit:commitMonitorRecord',
      );
      const open = reserves.find(
        (row) =>
          row.status === 200 && (row.responseSnippet ?? '').includes('"OPEN"'),
      );
      const closure = closes.find((row) => row.status === 200);
      if (!open)
        throw new Error(
          `${label} reserve did not answer OPEN: ${JSON.stringify(reserves)}`,
        );
      if (!closure)
        throw new Error(
          `${label} grants close did not answer 200: ${JSON.stringify(closes)}`,
        );
      if (!status.hasActivePrompt && status.recoveryBlocked !== true)
        throw new Error(
          `${label} turn ended without the recovery-blocked state the not_started path reports at this slice: ${JSON.stringify(status)}`,
        );
      const stderr = daemon.output.match(/is recovery blocked: [^\n]*/g);
      evidence.push(
        `${label} reserve OPEN + close ${closure.status} + turn recovery-blocked=${status.recoveryBlocked} + childRecords=${mutations.length}`,
        `${label} blockCause=${JSON.stringify(stderr?.slice(-1) ?? [])}`,
        `${label} reserves=${JSON.stringify(reserves.map((row) => ({ status: row.status, snippet: (row.responseSnippet ?? '').slice(0, 160) })))}`,
        `${label} closes=${JSON.stringify(closes.map((row) => ({ status: row.status, snippet: (row.responseSnippet ?? '').slice(0, 160) })))}`,
      );
      return { status, reserves, closes };
    };

    // Arm 1 — background-reserve: admitted; off-Linux the ephemeral lane has
    // no cgroup root, so the start is declined not_started and the turn goes
    // recovery-blocked. Full detached-handle settlement after turn
    // completion stays the unlanded B1 arm — this arm pins OPEN + close +
    // the blocked state and names that dependency.
    const alpha = config.sessions[0];
    await detachedArmOf(alpha, 0, 'background');
    evidence.push(
      'background settlement target after turn completion is the unlanded B1 arm; intermediate state pinned (OPEN + close NOT_STARTED + turn recovery-blocked, blockCause recorded above)',
    );

    // Arm 2 — monitor-reserve: admitted, same detached-family chain as the
    // background arm, pinned strict like its siblings. A refused admitted
    // Monitor reserve is a regression of the admission layers this witness
    // exists to pin, never a passing outcome the witness may journal green.
    const mu = config.sessions[1];
    await detachedArmOf(mu, 1, 'monitor');

    // Arm 3 — refusal-edges-live: per-family raw negatives against the
    // running endpoint. Pure shape-level negatives can't be emitted by the
    // turn (it normalizes them away), and the digest-bound protocol refuses
    // forged bytes at identification, so replaying the real reserves of the
    // admitted families with forged digests is the honest wire-level
    // negative each family admits: fresh publicationId, forged
    // requestDigest/argsDigest — the endpoint must answer 400 with a live
    // refusal diagnostic (unit fixtures cover the field-shape refusals).
    const forgeArms: Array<{
      family: string;
      sourceId: string;
      argsDigest: string;
      requestDigest: string;
    }> = [
      {
        family: 'shell',
        sourceId: alpha.sessionId,
        argsDigest: `sha256:${'f'.repeat(64)}`,
        requestDigest: `sha256:${'e'.repeat(64)}`,
      },
      {
        family: 'monitor',
        sourceId: mu.sessionId,
        argsDigest: `sha256:${'d'.repeat(64)}`,
        requestDigest: `sha256:${'c'.repeat(64)}`,
      },
    ];
    for (const arm of forgeArms) {
      const source = reserveBodies.get(arm.sourceId);
      const headers = reserveHeaders.get(arm.sourceId);
      if (!source || !headers)
        throw new Error(`No captured reserve for ${arm.family} forging`);
      const body = JSON.parse(source);
      body.binding.publicationId = randomUUID();
      body.binding.reference.argsDigest = arm.argsDigest;
      body.binding.requestDigest = arm.requestDigest;
      const response = await fetch(
        `${storeProxyUrl}/internal/managed-tool-publications/v1/sessions/${arm.sourceId}/grants?workspaceId=${config.sessions.find((session) => session.sessionId === arm.sourceId)!.workspaceId}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const text = await response.text();
      evidence.push(
        `edge ${arm.family} forged-digest reserve -> ${response.status} ${text.slice(0, 240)}`,
      );
      if (response.status !== 400)
        throw new Error(
          `${arm.family} edge reserve must refuse with 400, got ${response.status}: ${text.slice(0, 240)}`,
        );
    }

    // Arm 4 — foreground reserve on the same v3 lane: off-Linux the worker
    // declines it just like the detached families (no cgroup root, no
    // capture publisher), so the turn closes NOT_STARTED and blocks; the
    // byte-level foreground regression is HostedWorkspaceToolTurnIT (v2
    // lane, G5), which runs the same harness against the foreground chain
    // unchanged.
    const sigma = config.sessions[2];
    await detachedArmOf(sigma, 2, 'foreground-v3');
    evidence.push(
      'foreground reserve OPEN + close NOT_STARTED + turn recovery-blocked (ephemeral-lane decline, all shell-typed tools); end-to-end foreground regression held by HostedWorkspaceToolTurnIT (G5)',
    );

    await evidenceFile('publication-arms.txt', evidence.join('\n'));
    await phase('PUBLICATION_DONE');
    console.log('HOSTED_BACKGROUND_PUBLICATION_OK');
    console.log(evidence.join('\n'));
  } else if (direct) {
    await driveAControlTurn();
    const bClient = await createSession(
      bSession,
      config.bToolProfile || bSession.toolProfile,
      config.bCaptureBytes ?? 0,
    );
    const turn = await driveProbeTurn(bSession, bClient, bMarker);
    if (turn.outcome !== 'completed')
      throw new Error('Control session β did not complete.');
    await phase('CONTROL_B_COMPLETED');
    console.log('HOSTED_WEDGE_CONTROL_OK');
  } else if (config.bPreloaded) {
    // Overlap variant: β already lives on the daemon with a healthy first
    // turn when α goes recovery-blocked; its next turn is the A2 probe.
    console.log('B_PRELOADED_HEALTHY_TURN_FIRST');
    const bClient = await createSession(
      bSession,
      config.bToolProfile || bSession.toolProfile,
      config.bCaptureBytes ?? 0,
    );
    const before = await driveProbeTurn(bSession, bClient, bMarker);
    if (before.outcome !== 'completed')
      throw new Error('Preloaded session β first turn did not complete.');
    await driveAFault();
    const marker2 = `${bMarker}_SECOND`;
    const turn = await driveProbeTurn(bSession, bClient, marker2);
    if (turn.outcome === 'completed') {
      await evidenceFile(
        'b-not-wedged.txt',
        `preloaded B second turn completed: attemptAt=${turn.attemptAt} modelBAnsweredAt=${modelBAnsweredAt} commitMessageAt=${turn.commitMessageAt}`,
      );
      await phase('B_NOT_WEDGED');
      console.log('HOSTED_WEDGE_ABSENT');
    } else {
      await wedgeEvidence(marker2, turn);
    }
  } else {
    await driveAFault();
    const bClient = await createSession(
      bSession,
      config.bToolProfile || bSession.toolProfile,
      config.bCaptureBytes ?? 0,
    );
    const turnB = await driveProbeTurn(bSession, bClient, bMarker);
    if (turnB.outcome === 'wedged') {
      await wedgeEvidence(bMarker, turnB);
    } else {
      // The rig reproduced twice in fresh sessions; probe a second fresh
      // session on the same daemon as well.
      const cClient = await createSession(
        cSession,
        config.bToolProfile || cSession.toolProfile,
        config.bCaptureBytes ?? 0,
      );
      const turnC = await driveProbeTurn(cSession, cClient, cMarker);
      if (turnC.outcome === 'wedged') {
        await wedgeEvidence(cMarker, turnC);
      } else {
        await evidenceFile(
          'b-not-wedged.txt',
          [
            `fresh B first turn completed: attemptAt=+${turnB.attemptAt - turnB.promptAt}ms commitMessageAt=+${turnB.commitMessageAt - turnB.promptAt}ms modelBAnsweredAt=${modelBAnsweredAt}`,
            `fresh C first turn completed: attemptAt=+${turnC.attemptAt - turnC.promptAt}ms commitMessageAt=+${turnC.commitMessageAt - turnC.promptAt}ms`,
          ].join('\n'),
        );
        await phase('B_NOT_WEDGED');
        console.log('HOSTED_WEDGE_ABSENT');
      }
    }
  }
} catch (cause) {
  console.error('WEDGE_DRIVER_FAILURE', cause);
  console.error('daemon output tail:', daemon.output.slice(-4000));
  daemon.keepRoot = true;
  console.error(`daemon root kept for inspection: ${daemon.root}`);
  try {
    await evidenceFile(
      'driver-failure.txt',
      `${String(cause)}\n${daemon.output.slice(-4000)}\ndaemonRoot=${daemon.root}`,
    );
  } catch {
    // best effort
  }
  try {
    await phase('DRIVER_FAILURE');
  } catch {
    // best effort
  }
  process.exitCode = 1;
} finally {
  await daemon.close().catch(() => undefined);
  storeProxy.close();
  await model.close();
}
