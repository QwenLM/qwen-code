// @vitest-environment node
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelWebhookTask } from '@qwen-code/channel-base';
import {
  ChannelWorkerStartupError,
  cleanupMintedWorkerCaBundleDirs,
  createChannelWorkerSupervisor,
  resolveWorkerCaCertPath,
  type ChannelWorkerChild,
} from './channel-worker-supervisor.js';
import * as pemCertificateBlocks from './pem-certificate-blocks.js';
import { isChannelWorkerPromptAuthorized } from './channel-worker-prompt-authorization.js';
import { CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS } from './channel-worker-env.js';
import { MAX_CHANNEL_STARTUP_FAILURES } from './channel-worker-startup-ipc.js';
import {
  CHANNEL_DELIVERY_IPC_TIMEOUT_MS,
  MAX_CHANNEL_DELIVERIES_IN_FLIGHT,
  type ChannelDeliveryRequest,
} from '../runtime/channel-delivery-ipc.js';
import { expectWithinLatencyBudget } from '../test-utils/latency-budget.js';

// `tls.getCACertificates` arrives in Node 22.15, while engines still allow
// 22.0: there the loader oracle answers `legacy` and the inspection throws,
// so merge tests that drive the real oracle skip instead of failing.
const loaderOracleTest = it.skipIf(typeof tls.getCACertificates !== 'function');

const TEST_HEARTBEAT_TIMEOUT_MS = CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS + 5;

class FakeChild extends EventEmitter implements ChannelWorkerChild {
  pid: number | undefined = 12345;
  killed = false;
  stdout?: EventEmitter;
  stderr?: EventEmitter;
  constructor(private readonly emitExitOnKill = true) {
    super();
  }

  kill = vi.fn((signal?: NodeJS.Signals | number) => {
    this.killed = true;
    if (this.emitExitOnKill) {
      this.emit('exit', null, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
    }
    return true;
  });
  send = vi.fn(
    (_message: unknown, _callback?: (err: Error | null) => void) => true,
  );
}

const webhookTask: ChannelWebhookTask = {
  channelName: 'telegram',
  source: 'github-ci',
  eventType: 'check_failed',
  targetRef: 'default',
  title: 'CI failed',
  payload: { runId: 123 },
};

const deliveryRequest: ChannelDeliveryRequest = {
  deliveryId: 'delivery-1',
  channelName: 'telegram',
  target: { type: 'chat', id: 'group-1' },
  text: 'inspection result',
};

/**
 * Real PEM material: the merge now validates its inputs the way Node's
 * certificate loader does, so placeholder text like `OP-CERT` no longer
 * exercises the merge path at all.
 */
const OPERATOR_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDHjCCAgagAwIBAgIUMfJwZrF6DjLX1ypLgu2A4v/SwKEwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRcXdlbiB0ZXN0IHJvb3QgQ0EwIBcNMjYwODE4MDk0NzE4
WhgPMjEyNjA3MjUwOTQ3MThaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAOff38zsoMq+oe2koKyZJ7aoGJC8CuAc
oYoLcJaWdp6yJaj5BpYeHAnQt8QCQZB86Fj1f3yuK6KwmGm3p49NrVJMl/T39CnK
ZAcIWATBw8mCWLFWlWhRgqrIQ5ka935m+z63gVhSQiCq2mNkAzm9I4UcbeAucSXn
Plk0Bc/CBUh5knrjxPEebicbCUaKteWnG3SBe5PjgP6DKZojd0VakmbrDhTW+yD4
9LRqURfzvQZghA7stqErp+WJREKAaJbNNUEhGvRSwucIsah6u7OAbYP1IRaYBGDm
nlxaYBETRg0/3Kzx4SnPUuyx3uR6YP9MNuSzK5udCf39+iWSFCC+AnMCAwEAAaNe
MFwwGgYDVR0RBBMwEYcEfwAAAYIJbG9jYWxob3N0MB0GA1UdDgQWBBSItY/bpVFx
QRATvUzvo+JRFVpuyjAfBgNVHSMEGDAWgBRfCBabaBn4orvntHRiDcBU8W3vEzAN
BgkqhkiG9w0BAQsFAAOCAQEAjIiKztoj9JtpKfP2qSYsTe+4nvCZ1ZT4PtmXQMVp
lyHI02iH+NSSY92/ZdvGn2jBMzAFpVgJFlI6aZOne/qHI5qMf1RW7BfHBXza7wF6
mdILIKRUYzm96o6IEuObE+QkSjRuA5OpLkObzGZLWfem0+fxnz0djbzeEBhHpP+b
VUUcl7r2wFb3+ClobIYS24Y+tWCl53XF+2YFNebECkA+19TivHPYgyywljyFNmzk
jCELOKOvOESV6kWBGUcrj8rcXoaF3BABInxZURGMRqWuivfYSjkGj65Trf2sVCXS
9mkiDfB/mYPvq3ODVYLvOjcxqPFsKaRA0Gw5Nm7WKGiOhg==
-----END CERTIFICATE-----
`;

const DAEMON_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUfuVC8Ulq3HIg+1tf36JrjAa6dr4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDYzMDAyMjIxOVoYDzIxMjYw
NjA2MDIyMjE5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCnEk5caJsr2ShJwi4bkAMr1/IzzueiUFbnnqs3XpaB
ANxpIZxi8WN1gf8MoAOioZteH51Q2nz8Zb2MVHoDMH3zx4V36VcXUaeR+/wZbFRN
94NlzYCXPnzPH+Mw/vle1PTM/boPON8F4ATGJZkzmGT8+M5CqDCW4isHlpGvbn0T
SdmqnmzihNBdaREVVkGJYa7JSFcgRth52+wTAOIM8e8HC1VTMw1OhXDAus6ro7z+
u5XKGpG+JfsCpimNPYzNOPSkIr/QmxuaMq7kmYwT9J1Gyw9cQQj8vcipyLq6q3Hz
iMhxUXbWp7moi4e6CzxLKyPrWwhuh+3SXqIYshAYRsKNAgMBAAGjbzBtMB0GA1Ud
DgQWBBSM8bvfq77vXg5fsuhYGXsLuKjqxzAfBgNVHSMEGDAWgBSM8bvfq77vXg5f
suhYGXsLuKjqxzAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxv
Y2FsaG9zdDANBgkqhkiG9w0BAQsFAAOCAQEAGUBgaBYEO119e28j61PTijfhw7mV
Q8AxlUjlv+HHx+IAPR+E8w7jiS97oxvFSIkmbV+FAQOWwTE+oNvrL5qSFlG7cI60
wj+Jxwxr+/SShV5Jm7JlynAGxOvOZ1mfxzyGrlm5cg4hoRvcoWAtB/qtiIyFIz/s
fDAdZiFXRoTaZnpyPWA6iydf3mc0ZOastHib+mlFb+aedKz9by/f2Z1CY6RfckEj
20c9Mar85RYkVtVTIWNSwItASmQVBaoXsXK33y4C0P1NmPoYBzyPSXsOlmIZXui5
WYj2mrPe2DL5gCeNUxMhmzgv0bgoYiksHmdyNjRmO5AQlcdjX/7CHg0zEQ==
-----END CERTIFICATE-----
`;

const DAEMON_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCnEk5caJsr2ShJ
wi4bkAMr1/IzzueiUFbnnqs3XpaBANxpIZxi8WN1gf8MoAOioZteH51Q2nz8Zb2M
VHoDMH3zx4V36VcXUaeR+/wZbFRN94NlzYCXPnzPH+Mw/vle1PTM/boPON8F4ATG
JZkzmGT8+M5CqDCW4isHlpGvbn0TSdmqnmzihNBdaREVVkGJYa7JSFcgRth52+wT
AOIM8e8HC1VTMw1OhXDAus6ro7z+u5XKGpG+JfsCpimNPYzNOPSkIr/QmxuaMq7k
mYwT9J1Gyw9cQQj8vcipyLq6q3HziMhxUXbWp7moi4e6CzxLKyPrWwhuh+3SXqIY
shAYRsKNAgMBAAECggEAQW/tG0qphEog+orAznDgnRqOtfYTScLX1w6RlzVIE60H
p3HPs/1B7HOHNyWxZtCPbxVI47NAAwfCbyVjSL6EhqgeQbI2N173GDmvKzH/7y3D
3GraM+L4tZOSw80KVTdpzqSObInk6IMuu4FceRX2cBLvjrIbne1l1yoFU8Yd3SCM
t8J46vMys7Rh4yR0iOl1hFeLYj8KolTdp6uNYTxaHMt363G7/TcJYRqjrLkpBpXJ
dJiP58a3WulvVKVHBjZYVmHLlkvla7LQ9tPRsk0gUQfzNpLzl6oBacrNrRv1F7Oe
keYqt+Kpy9HhZIHt57ahwKmjhjrfIUpyQadF/me0rQKBgQDVbLV6VngGjMSCPQOQ
VZcAMFZ+y1fgaHeVZwuFeRlCEHBDDmw5eWdUdUQNIRckpqf0IlU39aP/cLgjNZ0W
nmxfUwhdgEMam2aHZ/8eqrOl0HTa+F5PWz8NPLKsQ970vPb1XCsoEtDVXEsMqK+s
4h+zjRzy6lLy2cWvYZrDr/KwywKBgQDIZmitKO0MIJOWeqwI3MQvbBXCz9aEIG+3
0ISQreD/7Z/IEcwrMpDD+z1sOj9OUO2GFflECdhtqo416cv3uo8LLABxuzsYOgug
ZPgW9oPKVRLfqc43/n0JMtIvS+Na/7C/nCNwcZZZU91V+VG4+1rexINQybnCRbQw
cBZLcX8nBwKBgQDMdZhl2vChVbnsCwee/l/qjmROk/9bvLjTKCSheaH46Eaj9u03
IlcbUjwfV9QUCJReDYYWVf0GebXuBS64vIyVxbX93SJsGvPeRILjniT8dPd9zvKK
k5+TztJctaiiTWVJKUMu4NevjvtW5UNnHDnCiS1yiYltnbMEkTzyu1yEgQKBgAYk
pYbRX1rk0MFnJ0jqQ5VUkeIz7taEDAiterLYsbIGvcQrT3/vf+KSHBLqQjCLaIyY
tdhxGNJbzRo3/YmtjV8BTU4vOCOI+/xBvB0wF2AndXmnweuTgI+8oBbVE7YhanCl
P6zdvocke/97shailemISqI6XNhovJpThUtwwj4XAoGATwSvzX0VLRpoWwDl30oi
hxyfpb0iCzGik49j/oL+ZB5C8F8AdBpza8eTXJAeAVP7L5nvWffMgvcXs5sGMF7e
ARaOwZHpfsTw4Aq74yAWUKXumVGFXQpZMRj/QWgQEItTYF7rJVARIssv5miDbHvW
1Qm2tDpPnmCd1BedIYWCnHA=
-----END PRIVATE KEY-----
`;

describe('createChannelWorkerSupervisor', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('accepts loop MCP registration before the worker ready signal', async () => {
    const child = new FakeChild();
    const registerChannelLoopMcp = vi.fn(async () => {});
    const unregisterChannelLoopMcp = vi.fn(async () => {});
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      registerChannelLoopMcp,
      unregisterChannelLoopMcp,
    });
    const started = supervisor.start();

    child.emit('message', {
      type: 'channel_loop_mcp_register',
      id: 'register-before-ready',
      sessionId: 'session-early',
    });

    await vi.waitFor(() =>
      expect(registerChannelLoopMcp).toHaveBeenCalledWith({
        sessionId: 'session-early',
        ownerId: expect.stringMatching(/^channel-worker:/),
        sendMessage: expect.any(Function),
      }),
    );
    await vi.waitFor(() =>
      expect(child.send).toHaveBeenCalledWith({
        type: 'channel_loop_mcp_control_result',
        id: 'register-before-ready',
        ok: true,
      }),
    );

    child.emit('message', {
      type: 'ready',
      channels: ['telegram'],
    });
    await started;
    await supervisor.stop();
  });

  it('correlates exact-session loop MCP traffic and unregisters on exit', async () => {
    const child = new FakeChild();
    let reverseSender: ((payload: unknown) => Promise<unknown>) | undefined;
    let ownerId: string | undefined;
    const registerChannelLoopMcp = vi.fn(
      async (request: {
        sessionId: string;
        ownerId: string;
        sendMessage: (payload: unknown) => Promise<unknown>;
      }) => {
        ownerId = request.ownerId;
        reverseSender = request.sendMessage;
      },
    );
    const unregisterChannelLoopMcp = vi.fn(async () => {});
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      registerChannelLoopMcp,
      unregisterChannelLoopMcp,
    });
    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      channels: ['telegram'],
    });
    await started;

    child.emit('message', {
      type: 'channel_loop_mcp_register',
      id: 'register-1',
      sessionId: 'session-1',
    });
    await vi.waitFor(() => expect(registerChannelLoopMcp).toHaveBeenCalled());
    expect(registerChannelLoopMcp).toHaveBeenCalledWith({
      sessionId: 'session-1',
      ownerId: expect.stringMatching(/^channel-worker:/),
      sendMessage: expect.any(Function),
    });
    await vi.waitFor(() =>
      expect(child.send).toHaveBeenCalledWith({
        type: 'channel_loop_mcp_control_result',
        id: 'register-1',
        ok: true,
      }),
    );

    const response = reverseSender?.({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const request = child.send.mock.calls
      .map(([message]) => message)
      .find(
        (message) =>
          (message as { type?: string }).type === 'channel_loop_mcp_message',
      ) as { id: string; sessionId: string };
    expect(request.sessionId).toBe('session-1');
    child.emit('message', {
      type: 'channel_loop_mcp_result',
      id: request.id,
      ok: true,
      payload: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
    });
    await expect(response).resolves.toMatchObject({
      result: { tools: [] },
    });

    await supervisor.stop();
    await vi.waitFor(() =>
      expect(unregisterChannelLoopMcp).toHaveBeenCalledWith(
        'session-1',
        ownerId,
      ),
    );
  });

  it('passes daemon connection details through env without putting token in argv', async () => {
    vi.stubEnv('QWEN_SERVER_TOKEN', 'serve-token');
    vi.stubEnv('QWEN_DAEMON_TOKEN', 'stale-daemon-token');
    vi.stubEnv('QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN', 'guard-secret');
    vi.stubEnv('OPENAI_API_KEY', 'openai-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-secret');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret');
    vi.stubEnv('GITHUB_TOKEN', 'github-secret');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'telegram-secret');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.com:8080');
    const child = new FakeChild();
    const spawnWorker = vi.fn(
      (_execPath: string, _argv: string[], _options: unknown) => child,
    );
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'secret-token',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      workerBaseEnv: { ...process.env, CUSTOM: 'value' },
      spawnWorker,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 54321,
      channels: ['telegram', 'feishu'],
      requestedChannels: ['telegram', 'feishu'],
    });
    await started;

    expect(spawnWorker).toHaveBeenCalledWith(
      process.execPath,
      [
        '/repo/dist/index.js',
        'channel',
        'daemon-worker',
        '--channel',
        'telegram',
        '--channel',
        'feishu',
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          QWEN_DAEMON_URL: 'http://127.0.0.1:4170',
          QWEN_DAEMON_TOKEN: 'secret-token',
          QWEN_DAEMON_WORKSPACE: '/workspace',
          QWEN_CODE_NO_RELAUNCH: 'true',
          QWEN_CODE_SERVE: '1',
          QWEN_CHANNEL_DAEMON_WORKER: expect.any(String),
        }),
        cwd: '/workspace',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
    );
    const env = (spawnWorker.mock.calls[0]![2] as { env: NodeJS.ProcessEnv })
      .env;
    expect(env).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(env).not.toHaveProperty('QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN');
    expect(env).toHaveProperty('CUSTOM', 'value');
    expect(env).toHaveProperty('QWEN_DAEMON_TOKEN', 'secret-token');
    expect(env).toHaveProperty('OPENAI_API_KEY', 'openai-secret');
    expect(env).toHaveProperty('ANTHROPIC_API_KEY', 'anthropic-secret');
    expect(env).toHaveProperty('AWS_SECRET_ACCESS_KEY', 'aws-secret');
    expect(env).toHaveProperty('GITHUB_TOKEN', 'github-secret');
    expect(env).toHaveProperty('TELEGRAM_BOT_TOKEN', 'telegram-secret');
    expect(env).toHaveProperty('HTTPS_PROXY', 'http://proxy.example.com:8080');
    expect(env['QWEN_CHANNEL_DAEMON_WORKER']).not.toBe('1');
    const promptAuthorization = env['QWEN_CHANNEL_DAEMON_WORKER']!;
    expect(
      isChannelWorkerPromptAuthorized(promptAuthorization, '/workspace'),
    ).toBe(true);
    expect(isChannelWorkerPromptAuthorized(promptAuthorization, '/other')).toBe(
      false,
    );
    const argv = spawnWorker.mock.calls[0]![1];
    expect(argv).not.toContain('secret-token');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 54321,
      channels: ['telegram', 'feishu'],
      requestedChannels: ['telegram', 'feishu'],
    });
    supervisor.killAllSync();
    expect(
      isChannelWorkerPromptAuthorized(promptAuthorization, '/workspace'),
    ).toBe(false);
  });

  it('injects NODE_EXTRA_CA_CERTS when the daemon serves TLS', async () => {
    const child = new FakeChild();
    const spawnWorker = vi.fn(
      (_execPath: string, _argv: string[], _options: unknown) => child,
    );
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'https://127.0.0.1:4170',
      tlsCaCertPath: '/certs/daemon.pem',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      workerBaseEnv: {},
      spawnWorker,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 54321,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const env = (spawnWorker.mock.calls[0]![2] as { env: NodeJS.ProcessEnv })
      .env;
    expect(env['NODE_EXTRA_CA_CERTS']).toBe('/certs/daemon.pem');
  });

  loaderOracleTest(
    'merges an operator-set NODE_EXTRA_CA_CERTS with the daemon cert',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-merge-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(operatorCa, OPERATOR_CA_PEM);
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);
      const child = new FakeChild();
      const spawnWorker = vi.fn(
        (_execPath: string, _argv: string[], _options: unknown) => child,
      );
      const supervisor = createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'https://127.0.0.1:4170',
        tlsCaCertPath: daemonCa,
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        workerBaseEnv: { NODE_EXTRA_CA_CERTS: operatorCa },
        spawnWorker,
      });

      const started = supervisor.start();
      child.emit('message', {
        type: 'ready',
        pid: 54321,
        channels: ['telegram'],
        requestedChannels: ['telegram'],
      });
      await started;

      const env = (spawnWorker.mock.calls[0]![2] as { env: NodeJS.ProcessEnv })
        .env;
      const combined = fs.readFileSync(env['NODE_EXTRA_CA_CERTS']!, 'utf8');
      // R2-5: exact text, not two `toContain`s — those survive a mutated
      // separator, and with real PEM inputs that mutant fuses
      // `-----END CERTIFICATE-----` onto the next `-----BEGIN CERTIFICATE-----`
      // and makes the whole bundle unparseable.
      expect(combined).toBe(
        `${OPERATOR_CA_PEM.trimEnd()}\n${DAEMON_CERT_PEM.trimEnd()}\n`,
      );
      fs.rmSync(path.dirname(env['NODE_EXTRA_CA_CERTS']!), {
        recursive: true,
        force: true,
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  it('reuses one merged bundle across worker spawns', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-reuse-'));
    const operatorCa = path.join(dir, 'operator.pem');
    const daemonCa = path.join(dir, 'daemon.pem');
    fs.writeFileSync(operatorCa, OPERATOR_CA_PEM);
    fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);
    const spawnWorker = vi.fn(
      (_execPath: string, _argv: string[], _options: unknown) =>
        new FakeChild(),
    );
    const makeSupervisor = () =>
      createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'https://127.0.0.1:4170',
        tlsCaCertPath: daemonCa,
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        workerBaseEnv: { NODE_EXTRA_CA_CERTS: operatorCa },
        spawnWorker,
      });

    for (const supervisor of [makeSupervisor(), makeSupervisor()]) {
      const started = supervisor.start();
      const child = spawnWorker.mock.results.at(-1)!.value as FakeChild;
      child.emit('message', {
        type: 'ready',
        pid: 54321,
        channels: ['telegram'],
        requestedChannels: ['telegram'],
      });
      await started;
    }

    // Workers respawn on every restart; minting a fresh bundle directory per
    // spawn would leak one per restart for the daemon's whole lifetime.
    const paths = spawnWorker.mock.calls.map(
      (call) =>
        (call[2] as { env: NodeJS.ProcessEnv }).env['NODE_EXTRA_CA_CERTS'],
    );
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(paths[1]);
    fs.rmSync(path.dirname(paths[0]!), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the daemon cert when the operator CA cannot be merged', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-fallback-'));
    const daemonCa = path.join(dir, 'daemon.pem');
    fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.message);
    process.on('warning', onWarning);
    const child = new FakeChild();
    const spawnWorker = vi.fn(
      (_execPath: string, _argv: string[], _options: unknown) => child,
    );
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'https://127.0.0.1:4170',
      tlsCaCertPath: daemonCa,
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      workerBaseEnv: {
        NODE_EXTRA_CA_CERTS: path.join(dir, 'missing-operator.pem'),
      },
      spawnWorker,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 54321,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const env = (spawnWorker.mock.calls[0]![2] as { env: NodeJS.ProcessEnv })
      .env;
    expect(env['NODE_EXTRA_CA_CERTS']).toBe(daemonCa);
    await new Promise((resolve) => setImmediate(resolve));
    process.off('warning', onWarning);
    expect(
      warnings.some((message) => message.includes('missing-operator.pem')),
    ).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startWorkerWithCaPaths(
    daemonCa: string,
    operatorCa: string,
  ): Promise<{ env: NodeJS.ProcessEnv }> {
    const child = new FakeChild();
    const spawnWorker = vi.fn(
      (_execPath: string, _argv: string[], _options: unknown) => child,
    );
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'https://127.0.0.1:4170',
      tlsCaCertPath: daemonCa,
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      workerBaseEnv: { NODE_EXTRA_CA_CERTS: operatorCa },
      spawnWorker,
    });
    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 54321,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    return spawnWorker.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
  }

  loaderOracleTest(
    'keeps the daemon cert when the operator CA is readable but unloadable',
    async () => {
      // R2-11: `cat a.pem b.pem` with no trailing newline in a.pem fuses
      // `-----END CERTIFICATE----------BEGIN CERTIFICATE-----` onto one line.
      // Node's loader is all-or-nothing on that shape — it drops the WHOLE
      // bundle with `bad end line`, taking the daemon cert appended after it
      // down too, so every worker handshake fails while /health stays green.
      // The read succeeds, so the ENOENT fallback above never sees this.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-fused-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(
        operatorCa,
        `${OPERATOR_CA_PEM.trimEnd()}${OPERATOR_CA_PEM}`,
      );
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);
      expect(fs.readFileSync(operatorCa, 'utf8')).toContain(
        '-----END CERTIFICATE----------BEGIN CERTIFICATE-----',
      );
      const warnings: string[] = [];
      const onWarning = (warning: Error) => warnings.push(warning.message);
      process.on('warning', onWarning);

      const { env } = await startWorkerWithCaPaths(daemonCa, operatorCa);

      expect(env['NODE_EXTRA_CA_CERTS']).toBe(daemonCa);
      await new Promise((resolve) => setImmediate(resolve));
      process.off('warning', onWarning);
      expect(
        warnings.some(
          (message) =>
            message.includes(operatorCa) &&
            message.includes('no PEM certificate block Node can load'),
        ),
      ).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  it('keeps the daemon cert when an operator CA block does not decode', async () => {
    // R3-1(lax arm): the marker check validates block SHAPE only. A body made
    // of base64 *characters* that does not decode (one misplaced `=` in a
    // truncated or hand-edited cert) passed it, was merged ahead of the daemon
    // cert, and Node's loader then discarded the WHOLE bundle with `bad base64
    // decode` — measured on Node 22: the worker ends up trusting NEITHER the
    // operator CA nor the daemon cert, while /health stays green.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-badb64-'));
    const operatorCa = path.join(dir, 'operator.pem');
    const daemonCa = path.join(dir, 'daemon.pem');
    const lines = OPERATOR_CA_PEM.trimEnd().split('\n');
    const body = Math.floor(lines.length / 2);
    lines[body] = `${lines[body]!.slice(0, 10)}=${lines[body]!.slice(11)}`;
    const corrupted = `${lines.join('\n')}\n`;
    // Still matches the marker/alphabet shape — only decoding tells them apart.
    expect(corrupted).toMatch(
      /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END CERTIFICATE-----\n$/,
    );
    fs.writeFileSync(operatorCa, corrupted);
    fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);

    const { env } = await startWorkerWithCaPaths(daemonCa, operatorCa);

    expect(env['NODE_EXTRA_CA_CERTS']).toBe(daemonCa);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the daemon cert and re-warns when certificate inspection fails', async () => {
    // R22-2: an oracle failure (spawn error, killed child, truncated answer)
    // used to collapse into "the loader takes nothing", so the merge stripped
    // the operator file while blaming its PEM format. The inspection failure
    // now carries its own fallback family — a read error that already warned
    // for the pair cannot silence it — and its warning blames no contents.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-inspect-'));
    const operatorCa = path.join(dir, 'operator.pem');
    const daemonCa = path.join(dir, 'daemon.pem');
    fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.message);
    process.on('warning', onWarning);
    const inspection = vi
      .spyOn(pemCertificateBlocks, 'extractCertificateBlocks')
      .mockImplementation(() => {
        throw new pemCertificateBlocks.ExtraCaInspectionError(
          'Inspecting NODE_EXTRA_CA_CERTS failed before its contents could be judged.',
        );
      });
    try {
      // The pair warns under the read-error family before the file exists...
      expect(resolveWorkerCaCertPath(daemonCa, operatorCa)).toBe(daemonCa);
      fs.writeFileSync(operatorCa, OPERATOR_CA_PEM);
      // ...and a later inspection failure still emits its own warning.
      expect(resolveWorkerCaCertPath(daemonCa, operatorCa)).toBe(daemonCa);
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        warnings.some(
          (message) =>
            message.includes(operatorCa) &&
            message.includes('failed before its contents could be judged'),
        ),
      ).toBe(true);
      expect(
        warnings.some(
          (message) =>
            message.includes(operatorCa) &&
            message.includes('no PEM certificate block Node can load'),
        ),
      ).toBe(false);
    } finally {
      inspection.mockRestore();
      process.off('warning', onWarning);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  loaderOracleTest('merges a CRLF-terminated operator CA file', async () => {
    // R3-4: the CRLF normalization is the only thing keeping Windows-edited
    // and vendor-exported bundles out of the daemon-cert-only fallback —
    // Node's loader accepts CRLF PEM (measured: NODE_EXTRA_CA_CERTS with a
    // CRLF root handshakes authorized=true), so rejecting it would drop an
    // operator CA the loader would have taken.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-crlf-'));
    const operatorCa = path.join(dir, 'operator.pem');
    const daemonCa = path.join(dir, 'daemon.pem');
    fs.writeFileSync(operatorCa, OPERATOR_CA_PEM.replace(/\n/g, '\r\n'));
    fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);

    const { env } = await startWorkerWithCaPaths(daemonCa, operatorCa);

    const bundlePath = env['NODE_EXTRA_CA_CERTS']!;
    expect(bundlePath).not.toBe(daemonCa);
    // Normalized to LF on the way in, so the bundle is canonical PEM.
    expect(fs.readFileSync(bundlePath, 'utf8')).toBe(
      `${OPERATOR_CA_PEM.trimEnd()}\n${DAEMON_CERT_PEM.trimEnd()}\n`,
    );
    fs.rmSync(path.dirname(bundlePath), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  loaderOracleTest(
    'merges an operator CA file behind a UTF-8 BOM',
    async () => {
      // R3-1(strict arm): a corporate bundle saved by Windows tooling carries a
      // BOM. Node's loader reads it fine (measured), so rejecting it sent the
      // operator to edit a file that was never the problem.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-bom-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(operatorCa, `\uFEFF${OPERATOR_CA_PEM}`);
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);

      const { env } = await startWorkerWithCaPaths(daemonCa, operatorCa);

      const bundlePath = env['NODE_EXTRA_CA_CERTS']!;
      expect(bundlePath).not.toBe(daemonCa);
      expect(fs.readFileSync(bundlePath, 'utf8')).toBe(
        `${OPERATOR_CA_PEM.trimEnd()}\n${DAEMON_CERT_PEM.trimEnd()}\n`,
      );
      fs.rmSync(path.dirname(bundlePath), { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  loaderOracleTest(
    'merges an operator CA file with marker and body whitespace',
    async () => {
      // R3-1(strict arm): Node's loader also accepts trailing whitespace after a
      // marker line and leading whitespace on body lines (measured through a
      // real NODE_EXTRA_CA_CERTS handshake), so the line-anchored match must not
      // send either shape to the daemon-cert-only fallback.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-ws-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      const padded = OPERATOR_CA_PEM.split('\n')
        .map((line) =>
          line.startsWith('-----')
            ? `${line}  `
            : line === ''
              ? line
              : `  ${line}`,
        )
        .join('\n');
      fs.writeFileSync(operatorCa, padded);
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);

      const { env } = await startWorkerWithCaPaths(daemonCa, operatorCa);

      const bundlePath = env['NODE_EXTRA_CA_CERTS']!;
      expect(bundlePath).not.toBe(daemonCa);
      expect(fs.readFileSync(bundlePath, 'utf8')).toBe(
        `${OPERATOR_CA_PEM.trimEnd()}\n${DAEMON_CERT_PEM.trimEnd()}\n`,
      );
      fs.rmSync(path.dirname(bundlePath), { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  it('warns once per path pair, not once per spawn', async () => {
    // R3-5: every fallback branch returns without caching and `launch()`
    // rebuilds the env on each 'initial'/'restart' spawn, while
    // `process.emitWarning` does not dedup identical text — so a crash-looping
    // worker appended one identical multi-line warning per restart, burying
    // the log stream the operator reads to diagnose the loop.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-dedup-'));
    const operatorCa = path.join(dir, 'operator.pem');
    const daemonCa = path.join(dir, 'daemon.pem');
    fs.writeFileSync(
      operatorCa,
      `${OPERATOR_CA_PEM.trimEnd()}${OPERATOR_CA_PEM}`,
    );
    fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.message);
    process.on('warning', onWarning);

    await startWorkerWithCaPaths(daemonCa, operatorCa);
    await startWorkerWithCaPaths(daemonCa, operatorCa);
    await startWorkerWithCaPaths(daemonCa, operatorCa);

    await new Promise((resolve) => setImmediate(resolve));
    process.off('warning', onWarning);
    expect(
      warnings.filter((message) => message.includes(operatorCa)),
    ).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  loaderOracleTest(
    'registers one exit hook however many times the bundle is rebuilt',
    async () => {
      // R4-1: a `process.once('exit')` per mint accumulated a listener, a
      // closure and an orphaned directory per rebuild — and the cache is
      // rebuilt on purpose (in-place rotation, tmp-cleaner aging), so a
      // long-lived daemon crossed Node's threshold and printed
      // `MaxListenersExceededWarning: Possible EventEmitter memory leak
      // detected` into the very log stream the fallback dedup keeps readable.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-exit-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(operatorCa, OPERATOR_CA_PEM);
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);

      const before = process.listenerCount('exit');
      const bundlePaths: string[] = [];
      for (let round = 0; round < 5; round += 1) {
        // Rotate in place so every spawn misses the cache and rebuilds.
        fs.writeFileSync(
          operatorCa,
          round % 2 === 0 ? DAEMON_CERT_PEM : OPERATOR_CA_PEM,
        );
        const { env } = await startWorkerWithCaPaths(daemonCa, operatorCa);
        bundlePaths.push(env['NODE_EXTRA_CA_CERTS']!);
      }

      expect(new Set(bundlePaths).size).toBe(5);
      expect(process.listenerCount('exit')).toBeLessThanOrEqual(before + 1);
      // Each rebuild also supersedes the previous bundle; holding those until
      // process exit leaks a directory per rotation.
      for (const superseded of bundlePaths.slice(0, -1)) {
        expect(fs.existsSync(path.dirname(superseded))).toBe(false);
      }

      fs.rmSync(path.dirname(bundlePaths.at(-1)!), {
        recursive: true,
        force: true,
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  loaderOracleTest(
    'warns again when the SAME path pair fails a different way',
    async () => {
      // R4-5(a): keying the dedup on the paths alone meant the first reason was
      // the only one ever printed. An operator CA that is missing before a mount
      // appears and a DER export afterwards are different fixes, and the second
      // diagnosis was swallowed — sending the operator to fix mounts while the
      // real problem was the format.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-family-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);
      const warnings: string[] = [];
      const onWarning = (warning: Error) => warnings.push(warning.message);
      process.on('warning', onWarning);

      // (1) not there yet — read error.
      await startWorkerWithCaPaths(daemonCa, operatorCa);
      // (2) there, but nothing Node's loader can take from it.
      fs.writeFileSync(
        operatorCa,
        `${OPERATOR_CA_PEM.trimEnd()}${OPERATOR_CA_PEM}`,
      );
      await startWorkerWithCaPaths(daemonCa, operatorCa);
      // (3) same failure as (2): still deduped.
      await startWorkerWithCaPaths(daemonCa, operatorCa);

      await new Promise((resolve) => setImmediate(resolve));
      process.off('warning', onWarning);
      const mine = warnings.filter((message) => message.includes(operatorCa));
      expect(mine).toHaveLength(2);
      expect(mine[0]).toContain('ENOENT');
      expect(mine[1]).toContain('no PEM certificate block Node can load');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  loaderOracleTest(
    'warns again when a pair that merged successfully fails later',
    async () => {
      // R4-5(b): the dedup Set was add-only, so a pair that once failed kept its
      // key forever. A genuinely NEW later failure of the same pair was then
      // swallowed and the workers restart-looped with no diagnostic at all.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-relapse-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);
      const warnings: string[] = [];
      const onWarning = (warning: Error) => warnings.push(warning.message);
      process.on('warning', onWarning);

      fs.writeFileSync(
        operatorCa,
        `${OPERATOR_CA_PEM.trimEnd()}${OPERATOR_CA_PEM}`,
      );
      await startWorkerWithCaPaths(daemonCa, operatorCa);
      // Operator fixes the file; the merge works again.
      fs.writeFileSync(operatorCa, OPERATOR_CA_PEM);
      const merged = await startWorkerWithCaPaths(daemonCa, operatorCa);
      expect(merged.env['NODE_EXTRA_CA_CERTS']).not.toBe(daemonCa);
      // And breaks it again — new information, not a repeat.
      fs.writeFileSync(
        operatorCa,
        `${OPERATOR_CA_PEM.trimEnd()}${OPERATOR_CA_PEM}`,
      );
      const relapsed = await startWorkerWithCaPaths(daemonCa, operatorCa);
      expect(relapsed.env['NODE_EXTRA_CA_CERTS']).toBe(daemonCa);

      await new Promise((resolve) => setImmediate(resolve));
      process.off('warning', onWarning);
      expect(
        warnings.filter((message) => message.includes(operatorCa)),
      ).toHaveLength(2);
      fs.rmSync(path.dirname(merged.env['NODE_EXTRA_CA_CERTS']!), {
        recursive: true,
        force: true,
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  loaderOracleTest(
    'names decoding and DER, not just markers, in the fallback warning',
    async () => {
      // R4-6: `extractCertificateBlocks` rejects for three reasons, and this
      // commit's X509 decode gate added the third without updating the message.
      // A CA corrupted by a misplaced `=` was told its markers must sit alone on
      // their lines — while they already did. After boot this is the ONLY
      // diagnostic the operator gets, so it has to name the same three the
      // boot-time check does.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-cause-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      const lines = OPERATOR_CA_PEM.trimEnd().split('\n');
      const body = Math.floor(lines.length / 2);
      lines[body] = `${lines[body]!.slice(0, 10)}=${lines[body]!.slice(11)}`;
      fs.writeFileSync(operatorCa, `${lines.join('\n')}\n`);
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);
      const warnings: string[] = [];
      const onWarning = (warning: Error) => warnings.push(warning.message);
      process.on('warning', onWarning);

      await startWorkerWithCaPaths(daemonCa, operatorCa);

      await new Promise((resolve) => setImmediate(resolve));
      process.off('warning', onWarning);
      const warning = warnings.find((message) => message.includes(operatorCa));
      expect(warning).toBeDefined();
      // Markers ARE already alone on their lines here, so blaming them alone
      // sends the operator to fix nothing.
      expect(warning).toContain('every block must decode');
      expect(warning).toContain('a DER file is never read at all');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  loaderOracleTest(
    'leaves the private key of a combined operator PEM out of the bundle',
    async () => {
      // R2-13: boot validation parses the first block only, so a combined
      // cert+key PEM serves fine — and copying its key into a tmpdir bundle
      // NODE_EXTRA_CA_CERTS never reads leaves key material behind a SIGKILLed
      // daemon, where the `exit` cleanup cannot run.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-combined-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(operatorCa, `${OPERATOR_CA_PEM}${DAEMON_KEY_PEM}`);
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);

      const { env } = await startWorkerWithCaPaths(daemonCa, operatorCa);

      const bundlePath = env['NODE_EXTRA_CA_CERTS']!;
      expect(bundlePath).not.toBe(daemonCa);
      const bundle = fs.readFileSync(bundlePath, 'utf8');
      expect(bundle).not.toContain('PRIVATE KEY');
      expect(bundle).toBe(
        `${OPERATOR_CA_PEM.trimEnd()}\n${DAEMON_CERT_PEM.trimEnd()}\n`,
      );
      fs.rmSync(path.dirname(bundlePath), { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  loaderOracleTest(
    'rebuilds the bundle after the operator CA is rotated in place',
    async () => {
      // R2-4(a): before this bundle existed a respawned worker read the
      // operator's file live, so a path-only cache turns an in-place rotation
      // into stale trust that lasts the daemon's whole lifetime.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-rotate-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(operatorCa, OPERATOR_CA_PEM);
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);

      const first = await startWorkerWithCaPaths(daemonCa, operatorCa);
      const firstPath = first.env['NODE_EXTRA_CA_CERTS']!;
      expect(fs.readFileSync(firstPath, 'utf8')).toContain(
        OPERATOR_CA_PEM.trimEnd(),
      );

      // Rotate to a different certificate under the same path.
      fs.writeFileSync(operatorCa, DAEMON_CERT_PEM);
      const rotated = await startWorkerWithCaPaths(daemonCa, operatorCa);
      const rotatedPath = rotated.env['NODE_EXTRA_CA_CERTS']!;
      expect(fs.readFileSync(rotatedPath, 'utf8')).toBe(
        `${DAEMON_CERT_PEM.trimEnd()}\n${DAEMON_CERT_PEM.trimEnd()}\n`,
      );

      fs.rmSync(path.dirname(firstPath), { recursive: true, force: true });
      fs.rmSync(path.dirname(rotatedPath), { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  loaderOracleTest(
    'keeps the daemon cert when the DAEMON cert holds no loadable block',
    async () => {
      // R5-2: every other fallback test corrupts the OPERATOR CA, so the
      // `no-daemon-blocks` arm had no test at all — returning `existing`
      // instead of the daemon cert, dropping the warning, or filing it under
      // the `no-operator-blocks` family key (which also silently merges the
      // two families' dedup) all shipped green.
      //
      // R4-2: the arm is reachable, but NOT through the shape this test used to
      // use. `[block without its END line][complete block]` was measured again
      // on Node v22.23.0: the loader TAKES the truncated block (`authorized:
      // true`, no warning), so that file was never a `no-daemon-blocks` file —
      // the fixture was pinning this module's own divergence from the loader as
      // if it were the loader's behavior.
      //
      // A `TRUSTED CERTIFICATE` block is the real shape, and the same probe
      // settles both halves: `tls.createSecureContext` ACCEPTS it (the daemon
      // boots and serves), while the workers' `NODE_EXTRA_CA_CERTS` loader
      // takes nothing from it and says nothing — a handshake against a daemon
      // serving one fails DEPTH_ZERO_SELF_SIGNED_CERT with an empty stderr.
      // `openssl x509 -trustout` writes exactly this label.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-nodaemon-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(operatorCa, OPERATOR_CA_PEM);
      fs.writeFileSync(
        daemonCa,
        DAEMON_CERT_PEM.replace(
          /CERTIFICATE-----/g,
          'TRUSTED CERTIFICATE-----',
        ),
      );
      const warnings: string[] = [];
      const onWarning = (warning: Error) => warnings.push(warning.message);
      process.on('warning', onWarning);

      const { env } = await startWorkerWithCaPaths(daemonCa, operatorCa);

      expect(env['NODE_EXTRA_CA_CERTS']).toBe(daemonCa);
      await new Promise((resolve) => setImmediate(resolve));
      process.off('warning', onWarning);
      expect(
        warnings.some((message) =>
          message.includes('no PEM certificate block to merge into'),
        ),
      ).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  loaderOracleTest(
    'sweeps the minted registry from exactly one process exit hook',
    async () => {
      // R5-27/R5-5/R5-6: nothing in this suite observed process exit, so
      // deleting the whole `process.once('exit', …)` registration — a superset
      // of deleting the `clear()` inside it — left all 103 tests green while
      // every clean daemon exit orphaned a 0700 directory of cert material in
      // the shared tmpdir. The listener-count guard nearby bounds the hook from
      // ABOVE only, so it passes when the hook is gone entirely.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-exit-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(operatorCa, OPERATOR_CA_PEM);
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);

      const first = await startWorkerWithCaPaths(daemonCa, operatorCa);
      const firstBundle = first.env['NODE_EXTRA_CA_CERTS']!;
      expect(
        process
          .listeners('exit')
          .filter((listener) => listener === cleanupMintedWorkerCaBundleDirs),
      ).toHaveLength(1);

      // Rotate the operator CA in place so the next spawn rebuilds and
      // supersedes the first bundle. The registry must NOT grow: it held one
      // entry per rotation for the daemon's lifetime before the supersede
      // path deleted the old one.
      fs.writeFileSync(operatorCa, DAEMON_CERT_PEM);
      const second = await startWorkerWithCaPaths(daemonCa, operatorCa);
      const secondBundle = second.env['NODE_EXTRA_CA_CERTS']!;
      expect(secondBundle).not.toBe(firstBundle);

      const swept = cleanupMintedWorkerCaBundleDirs();
      expect(swept).toContain(path.dirname(secondBundle));
      // The rebuild already dropped the superseded directory; leaving it here
      // is the once-per-rotation growth the delete exists to prevent.
      expect(swept).not.toContain(path.dirname(firstBundle));
      expect(fs.existsSync(path.dirname(secondBundle))).toBe(false);
      // The sweep resets the registry; without that, every later exit would
      // rmSync paths it already removed and the set would never shrink.
      expect(cleanupMintedWorkerCaBundleDirs()).not.toContain(
        path.dirname(secondBundle),
      );

      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  loaderOracleTest(
    'keeps a failed mint in the registry, so the exit sweep still reclaims it',
    async () => {
      // R5-9's own regression test. The fix moved `mintedWorkerCaBundleDirs.add`
      // ahead of the bundle write so a throw there leaves a directory the exit
      // hook can still see; nothing pinned that, because forcing the write to
      // fail appeared to need `node:fs` mocked for the whole file, which would
      // change how the other tests here resolve fs.
      //
      // It does not. `vi.doMock` is NOT hoisted, so it binds only to the dynamic
      // import below: that one supervisor instance sees a throwing
      // `writeFileSync`, and every other test in this file keeps the real
      // `node:fs` it imported at module load. `vi.spyOn(fs, 'writeFileSync')` is
      // what cannot work — an ESM module namespace is not configurable.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-enospc-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(operatorCa, OPERATOR_CA_PEM);
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);
      const mintedBefore = new Set(
        fs
          .readdirSync(os.tmpdir())
          .filter((e) => e.startsWith('qwen-worker-ca-')),
      );

      vi.resetModules();
      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs')>();
        const writeFileSync: typeof actual.writeFileSync = (file, ...rest) => {
          if (typeof file === 'string' && file.endsWith('ca-bundle.pem')) {
            const enospc: NodeJS.ErrnoException = new Error(
              'ENOSPC: no space left on device',
            );
            enospc.code = 'ENOSPC';
            throw enospc;
          }
          return actual.writeFileSync(file, ...rest);
        };
        return {
          ...actual,
          default: { ...actual, writeFileSync },
          writeFileSync,
        };
      });

      let sweep: () => string[];
      try {
        const module = await import('./channel-worker-supervisor.js');
        sweep = module.cleanupMintedWorkerCaBundleDirs;
        const child = new FakeChild();
        const spawnWorker = vi.fn(
          (_execPath: string, _argv: string[], _options: unknown) => child,
        );
        const supervisor = module.createChannelWorkerSupervisor({
          cliEntryPath: '/repo/dist/index.js',
          daemonUrl: 'https://127.0.0.1:4170',
          tlsCaCertPath: daemonCa,
          workspace: '/workspace',
          selection: { mode: 'names', names: ['telegram'] },
          workerBaseEnv: { NODE_EXTRA_CA_CERTS: operatorCa },
          spawnWorker,
        });
        const started = supervisor.start();
        child.emit('message', {
          type: 'ready',
          pid: 54321,
          channels: ['telegram'],
          requestedChannels: ['telegram'],
        });
        await started;

        // The merge threw, so workers fall back to the daemon cert alone —
        // degraded but serving, which is the existing read-error contract.
        const { env } = spawnWorker.mock.calls[0]![2] as {
          env: NodeJS.ProcessEnv;
        };
        expect(env['NODE_EXTRA_CA_CERTS']).toBe(daemonCa);
      } finally {
        vi.doUnmock('node:fs');
      }

      const minted = fs
        .readdirSync(os.tmpdir())
        .filter(
          (entry) =>
            entry.startsWith('qwen-worker-ca-') && !mintedBefore.has(entry),
        )
        .map((entry) => path.join(os.tmpdir(), entry));
      // The write failed after mkdtemp, so exactly one directory was minted and
      // it is still on disk — deliberately, per the fix: reclaiming it belongs
      // to the sweep, not to the failure path.
      expect(minted).toHaveLength(1);

      // The assertion the fix is actually about. Registered AFTER the write, as
      // it was before, this directory is in no registry at all: the sweep below
      // returns without it and it survives on disk, one 0700 orphan per failing
      // respawn, holding nothing but reachable by nobody.
      const swept = sweep!();
      expect(swept).toContain(minted[0]);
      expect(fs.existsSync(minted[0]!)).toBe(false);

      vi.resetModules();
      fs.rmSync(minted[0]!, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  loaderOracleTest(
    'rebuilds the bundle after a tmp cleaner removes it',
    async () => {
      // R2-4(b): systemd-tmpfiles-clean ages out /tmp. A path-only cache then
      // hands every future respawn a dead path — Node logs "Ignoring extra
      // certs … load failed" and the worker restart-loops until the daemon
      // itself restarts.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-aged-'));
      const operatorCa = path.join(dir, 'operator.pem');
      const daemonCa = path.join(dir, 'daemon.pem');
      fs.writeFileSync(operatorCa, OPERATOR_CA_PEM);
      fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);

      const first = await startWorkerWithCaPaths(daemonCa, operatorCa);
      const firstPath = first.env['NODE_EXTRA_CA_CERTS']!;
      fs.rmSync(path.dirname(firstPath), { recursive: true, force: true });

      const respawned = await startWorkerWithCaPaths(daemonCa, operatorCa);
      const respawnedPath = respawned.env['NODE_EXTRA_CA_CERTS']!;
      expect(respawnedPath).not.toBe(firstPath);
      expect(fs.existsSync(respawnedPath)).toBe(true);

      fs.rmSync(path.dirname(respawnedPath), { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  it('writes the merged bundle into a private directory, not a predictable tmp path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-private-'));
    const operatorCa = path.join(dir, 'operator.pem');
    const daemonCa = path.join(dir, 'daemon.pem');
    fs.writeFileSync(operatorCa, OPERATOR_CA_PEM);
    fs.writeFileSync(daemonCa, DAEMON_CERT_PEM);
    const child = new FakeChild();
    const spawnWorker = vi.fn(
      (_execPath: string, _argv: string[], _options: unknown) => child,
    );
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'https://127.0.0.1:4170',
      tlsCaCertPath: daemonCa,
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      workerBaseEnv: { NODE_EXTRA_CA_CERTS: operatorCa },
      spawnWorker,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 54321,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const bundlePath = (
      spawnWorker.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }
    ).env['NODE_EXTRA_CA_CERTS']!;
    // A pre-planted path is only exploitable when it is predictable; the
    // bundle now lives in a 0700 mkdtemp directory with a random suffix.
    expect(bundlePath).not.toBe(
      path.join(os.tmpdir(), `qwen-worker-ca-${process.pid}.pem`),
    );
    const bundleDir = path.dirname(bundlePath);
    expect(path.dirname(bundleDir)).toBe(os.tmpdir());
    // Windows ignores mkdtempSync's mode and libuv synthesises st_mode from
    // file attributes (0o666 for a writable directory, structurally never
    // 0o700), so this POSIX assertion is guarded the way
    // observed-contact-store.test.ts guards the identical pair.
    if (process.platform !== 'win32') {
      expect(fs.statSync(bundleDir).mode & 0o777).toBe(0o700);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  });

  it('ignores non-ready IPC messages before the ready message', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', { type: 'not-ready' });
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      channels: ['telegram'],
    });
  });

  it('stores and acknowledges startup failures before exposing a deep-copied running snapshot', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        code: 'ECONNREFUSED',
        message: 'connection refused',
      },
    });
    expect(child.send).toHaveBeenCalledWith(
      { type: 'channel_startup_report_ack' },
      expect.any(Function),
    );
    child.emit('message', {
      type: 'ready',
      channels: ['feishu'],
      requestedChannels: ['telegram', 'feishu'],
    });
    await started;

    const first = supervisor.snapshot();
    expect(first.adapters).toEqual([
      {
        name: 'telegram',
        state: 'error',
        error: 'connection refused',
      },
      { name: 'feishu', state: 'connected' },
    ]);
    expect(first.startupFailures).toEqual([
      {
        channel: 'telegram',
        phase: 'connect',
        code: 'ECONNREFUSED',
        message: 'connection refused',
      },
    ]);
    first.startupFailures![0]!.message = 'mutated';
    expect(supervisor.snapshot().startupFailures![0]!.message).toBe(
      'connection refused',
    );
  });

  it('retains accepted and redacted startup failures when the worker exits before ready', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'daemon-secret',
      workspace: '/trusted/workspace',
      workerBaseEnv: { PROVIDER_API_KEY: '\tprovider-secret' },
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram-provider-secret',
        phase: 'connect',
        code: 'daemon-secret',
        message:
          'prefix \tprovider-secret Authorization: Bearer abcdef123456 failed',
      },
    });
    child.emit('exit', 1, null);

    const error = await started.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ChannelWorkerStartupError);
    expect(error).toMatchObject({
      startupFailures: [
        {
          workspaceCwd: '/trusted/workspace',
          channel: 'telegram-<redacted>',
          phase: 'connect',
          code: '<redacted>',
        },
      ],
    });
    expect(
      (error as ChannelWorkerStartupError).startupFailures[0]!.message,
    ).not.toContain('provider-secret');
    expect(
      (error as ChannelWorkerStartupError).startupFailures[0]!.message,
    ).not.toContain('abcdef123456');
    expect(supervisor.snapshot().startupFailures).toEqual(
      (error as ChannelWorkerStartupError).startupFailures.map(
        ({ workspaceCwd: _workspaceCwd, ...failure }) => failure,
      ),
    );
  });

  it('retains accepted startup failures across startup timeout', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      startupTimeoutMs: 1,
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        message: 'failed before feishu hung',
      },
    });

    const error = await started.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ChannelWorkerStartupError);
    expect(error).toMatchObject({
      startupFailures: [
        expect.objectContaining({ message: 'failed before feishu hung' }),
      ],
    });
    expect(supervisor.snapshot()).toMatchObject({
      state: 'failed',
      startupFailures: [
        expect.objectContaining({ message: 'failed before feishu hung' }),
      ],
    });
  });

  it('terminates startup on malformed reports and acknowledgement failures', async () => {
    const malformedChild = new FakeChild();
    const malformedSupervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => malformedChild),
    });
    const malformedStart = malformedSupervisor.start();
    malformedChild.emit('message', {
      type: 'channel_startup_failure',
      failure: { channel: '', phase: 'connect', message: 'invalid' },
    });
    await expect(malformedStart).rejects.toThrow(
      'Channel worker startup IPC protocol error: invalid startup report.',
    );
    expect(malformedChild.kill).toHaveBeenCalledWith('SIGTERM');

    const ackChild = new FakeChild();
    ackChild.send.mockImplementation((_message, callback) => {
      callback?.(new Error('ipc closed'));
      return true;
    });
    const ackSupervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => ackChild),
    });
    const ackStart = ackSupervisor.start();
    ackChild.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        message: 'failed',
      },
    });
    const ackError = await ackStart.catch((value: unknown) => value);
    expect(ackError).toBeInstanceOf(ChannelWorkerStartupError);
    expect((ackError as Error).message).toContain('acknowledgement failed');
    expect(
      (ackError as ChannelWorkerStartupError).startupFailures,
    ).toHaveLength(1);

    const markerChild = new FakeChild();
    const markerSupervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => markerChild),
    });
    const markerStart = markerSupervisor.start();
    markerChild.emit('message', {
      type: 'channel_startup_failures_truncated',
    });
    await expect(markerStart).rejects.toThrow('invalid truncation marker');
  });

  it('retains an accepted failure when the child emits a pre-ready error', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });
    const started = supervisor.start();
    child.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        message: 'provider failed',
      },
    });
    child.emit('error', new Error('child IPC failed'));

    const error = await started.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ChannelWorkerStartupError);
    expect(error).toMatchObject({
      startupFailures: [
        expect.objectContaining({ message: 'provider failed' }),
      ],
    });
  });

  it('accepts exactly 64 failures followed by one truncation marker', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    for (let index = 0; index < MAX_CHANNEL_STARTUP_FAILURES; index += 1) {
      child.emit('message', {
        type: 'channel_startup_failure',
        failure: {
          channel: `channel-${index}`,
          phase: 'connect',
          message: `failure-${index}`,
        },
      });
    }
    child.emit('message', { type: 'channel_startup_failures_truncated' });
    child.emit('message', {
      type: 'ready',
      channels: ['connected'],
    });
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      state: 'running',
      startupFailuresTruncated: true,
    });
    expect(supervisor.snapshot().startupFailures).toHaveLength(
      MAX_CHANNEL_STARTUP_FAILURES,
    );
    expect(child.send).toHaveBeenCalledTimes(MAX_CHANNEL_STARTUP_FAILURES + 1);
  });

  it('rejects a 65th startup failure without a truncation marker', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    for (let index = 0; index < MAX_CHANNEL_STARTUP_FAILURES; index += 1) {
      child.emit('message', {
        type: 'channel_startup_failure',
        failure: {
          channel: `channel-${index}`,
          phase: 'connect',
          message: `failure-${index}`,
        },
      });
    }
    child.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'channel-overflow',
        phase: 'connect',
        message: 'overflow',
      },
    });

    const error = await started.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ChannelWorkerStartupError);
    expect((error as Error).message).toContain('too many startup failures.');
    expect((error as ChannelWorkerStartupError).startupFailures).toHaveLength(
      MAX_CHANNEL_STARTUP_FAILURES,
    );
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.send).toHaveBeenCalledTimes(MAX_CHANNEL_STARTUP_FAILURES);
  });

  it('clears startup failure details when a new generation starts', async () => {
    const firstChild = new FakeChild();
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      spawnWorker,
    });

    const firstStart = supervisor.start();
    firstChild.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        message: 'first generation failure',
      },
    });
    firstChild.emit('message', { type: 'ready', channels: ['feishu'] });
    await firstStart;
    await supervisor.stop();

    const secondStart = supervisor.start();
    secondChild.emit('message', {
      type: 'ready',
      channels: ['telegram', 'feishu'],
    });
    await secondStart;

    expect(supervisor.snapshot()).not.toHaveProperty('startupFailures');
    expect(supervisor.snapshot()).not.toHaveProperty(
      'startupFailuresTruncated',
    );
  });

  it('rejects startup when the worker exits before ready', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('exit', 1, null);

    await expect(started).rejects.toThrow('Channel worker exited before ready');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      exitCode: 1,
    });
  });

  it('marks startup failed when spawning the worker throws', async () => {
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => {
        throw new Error('fork failed');
      }),
    });

    await expect(supervisor.start()).rejects.toThrow('fork failed');

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'fork failed',
      restartCount: 0,
    });
  });

  it('rejects heartbeat timeouts that cannot exceed the worker heartbeat interval', () => {
    expect(() =>
      createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        heartbeatTimeoutMs: CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS,
      }),
    ).toThrow(
      `heartbeatTimeoutMs (${CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS}) must exceed the worker heartbeat interval (${CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS}ms) or be 0 to disable.`,
    );
  });

  it('rejects restart policies without a restart delay', () => {
    expect(() =>
      createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [] },
      }),
    ).toThrow('restartPolicy.delaysMs must be non-empty.');
  });

  it('rejects startup when the worker never becomes ready', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      startupTimeoutMs: 1,
      spawnWorker: vi.fn(() => child),
    });

    await expect(supervisor.start()).rejects.toThrow(
      'Channel worker did not become ready within 1ms.',
    );
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'Channel worker did not become ready within 1ms.',
      exitCode: null,
      signal: 'SIGTERM',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not signal a worker that already failed before ready', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('exit', 1, null);
    await expect(started).rejects.toThrow('Channel worker exited before ready');

    await supervisor.stop();

    expect(child.kill).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('still signals a worker that errors before an exit is observed', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('error', new Error('spawn error'));
    await expect(started).rejects.toThrow('spawn error');

    await supervisor.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('sanitizes the pre-ready error when the worker exits after an error', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'telegram-secret');
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'secret-token',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    const unsafeMessage =
      `spawn error secret-token https://proxy-user:telegram-secret@proxy.example:8080\n` +
      `fake log line\r${'\u001b'}[31m${'x'.repeat(600)}`;
    child.emit('error', new Error(unsafeMessage));
    child.emit('exit', 1, null);

    await expect(started).rejects.toThrow('spawn error');
    const snapshot = supervisor.snapshot();
    expect(snapshot).toMatchObject({
      enabled: true,
      state: 'failed',
      exitCode: null,
      signal: 'SIGTERM',
    });
    expect(snapshot.error).toContain('spawn error');
    expect(snapshot.error).not.toContain('\n');
    expect(snapshot.error).not.toContain('\r');
    expect(snapshot.error).not.toContain('\u001b');
    expect(snapshot.error).not.toContain('secret-token');
    expect(snapshot.error).not.toContain('telegram-secret');
    expect(snapshot.error).not.toContain('proxy-user');
    expect(snapshot.error).toContain('https://<redacted>@proxy.example:8080');
    expect(snapshot.error!.length).toBeLessThanOrEqual(512);
  });

  it('still signals a worker error without an observed exit when pid is absent', async () => {
    const child = new FakeChild();
    child.pid = undefined;
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('error', new Error('spawn ENOENT'));
    await expect(started).rejects.toThrow('spawn ENOENT');

    await supervisor.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('can start a new worker after a stopped worker exits', async () => {
    const firstChild = new FakeChild();
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
    });

    const firstStart = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
    });
    await firstStart;
    await supervisor.stop();

    const secondStart = supervisor.start();
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
    });
    await secondStart;

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
    });
  });

  it('waits for the worker webhook drain window before force killing on stop', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const stopped = supervisor.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(9_999);
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('exit', null, 'SIGKILL');
    await stopped;
  });

  it('notifies when a ready worker exits unexpectedly', async () => {
    const child = new FakeChild();
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.emit('exit', 1, null);

    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        state: 'exited',
        exitCode: 1,
        signal: null,
      }),
    );
  });

  it('revokes the worker prompt authorization when the worker exits naturally', async () => {
    const child = new FakeChild();
    const spawnWorker = vi.fn(
      (_execPath: string, _argv: string[], _options: unknown) => child,
    );
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
    });

    const started = supervisor.start();
    child.emit('message', { type: 'ready', channels: ['telegram'] });
    await started;

    const env = (spawnWorker.mock.calls[0]![2] as { env: NodeJS.ProcessEnv })
      .env;
    const promptAuthorization = env['QWEN_CHANNEL_DAEMON_WORKER']!;
    expect(
      isChannelWorkerPromptAuthorized(promptAuthorization, '/workspace'),
    ).toBe(true);

    child.emit('exit', 1, null);

    expect(
      isChannelWorkerPromptAuthorized(promptAuthorization, '/workspace'),
    ).toBe(false);
  });

  it('revokes the worker prompt authorization when spawn throws', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(
        (_execPath: string, _argv: string[], options: unknown) => {
          capturedEnv = (options as { env: NodeJS.ProcessEnv }).env;
          throw new Error('spawn ENOENT');
        },
      ),
    });

    await expect(supervisor.start()).rejects.toThrow('spawn ENOENT');

    const promptAuthorization = capturedEnv?.['QWEN_CHANNEL_DAEMON_WORKER'];
    expect(promptAuthorization).toBeDefined();
    expect(
      isChannelWorkerPromptAuthorized(promptAuthorization!, '/workspace'),
    ).toBe(false);
  });

  it('restarts a ready worker after unexpected exit within budget', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const onReady = vi.fn();
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      onReady,
      onExit,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    firstChild.emit('exit', 1, null);

    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'exited',
        pid: 11111,
        nextRestartAt: expect.any(String),
      }),
    );

    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'running',
        pid: 22222,
        restartCount: 1,
        requestedChannels: ['telegram'],
      }),
    );
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      restartCount: 1,
      requestedChannels: ['telegram'],
    });
  });

  it('uses escalating restart delays from the restart policy', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild(false);
    const thirdChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
      .mockReturnValueOnce(thirdChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: {
        maxRestarts: 3,
        windowMs: 300_000,
        delaysMs: [10, 50, 100],
      },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);

    await vi.advanceTimersByTimeAsync(9);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnWorker).toHaveBeenCalledTimes(2);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();
    secondChild.emit('exit', 1, null);

    await vi.advanceTimersByTimeAsync(49);
    expect(spawnWorker).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnWorker).toHaveBeenCalledTimes(3);
    thirdChild.emit('message', {
      type: 'ready',
      pid: 33333,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 33333,
      restartCount: 2,
    });
  });

  it('does not restart a pre-ready startup failure', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const spawnWorker = vi.fn(() => child);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    child.emit('exit', 1, null);

    await expect(started).rejects.toThrow('Channel worker exited before ready');
    await vi.advanceTimersByTimeAsync(100);

    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      restartCount: 0,
    });
  });

  it('stops restarting after restart budget is exhausted', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild(false);
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 1, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(100);

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      restartCount: 1,
      error: expect.stringContaining(
        'Channel worker restart budget exhausted. Last error: Channel worker exited before ready',
      ),
    });
  });

  it('resets restart budget after an intentional stop and start', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild();
    const thirdChild = new FakeChild(false);
    const fourthChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
      .mockReturnValueOnce(thirdChild)
      .mockReturnValueOnce(fourthChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 1, windowMs: 300_000, delaysMs: [10] },
    });

    const firstStart = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await firstStart;
    firstChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    await supervisor.stop();

    const secondStart = supervisor.start();
    thirdChild.emit('message', {
      type: 'ready',
      pid: 33333,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await secondStart;
    thirdChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);
    fourthChild.emit('message', {
      type: 'ready',
      pid: 44444,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(spawnWorker).toHaveBeenCalledTimes(4);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 44444,
    });
  });

  it('does not double-notify or reschedule when a restart launch times out then exits', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild(false);
    const thirdChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
      .mockReturnValueOnce(thirdChild);
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      startupTimeoutMs: 5,
      spawnWorker,
      onExit,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(5);
    expect(secondChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(onExit).toHaveBeenCalledTimes(1);

    secondChild.emit('exit', null, 'SIGTERM');
    expect(onExit).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    thirdChild.emit('message', {
      type: 'ready',
      pid: 33333,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(onExit).toHaveBeenCalledTimes(2);
    expect(spawnWorker).toHaveBeenCalledTimes(3);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 33333,
      restartCount: 2,
    });
  });

  it('does not restart when a pre-ready worker never exits after SIGKILL', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild(false);
    const thirdChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
      .mockReturnValueOnce(thirdChild);
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      onExit,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('error', new Error('ipc setup failed'));
    await Promise.resolve();

    expect(secondChild.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(secondChild.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onExit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'failed',
        error: 'ipc setup failed',
      }),
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'ipc setup failed',
    });
    await expect(supervisor.start()).rejects.toThrow(
      'Channel worker stop is not yet confirmed.',
    );
    expect(spawnWorker).toHaveBeenCalledTimes(2);
  });

  it('captures restart spawn failures and schedules the next restart internally', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const thirdChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockImplementationOnce(() => {
        throw new Error('fork failed');
      })
      .mockReturnValueOnce(thirdChild);
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      onExit,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);

    await vi.advanceTimersByTimeAsync(10);
    expect(onExit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'failed',
        error: 'fork failed',
        restartCount: 1,
        nextRestartAt: expect.any(String),
      }),
    );

    await vi.advanceTimersByTimeAsync(10);
    thirdChild.emit('message', {
      type: 'ready',
      pid: 33333,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(spawnWorker).toHaveBeenCalledTimes(3);
    expect(onExit).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 33333,
      restartCount: 2,
    });
  });

  it('keeps the last restart failure in the budget exhausted error', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const spawnWorker = vi.fn().mockReturnValueOnce(firstChild);
    spawnWorker.mockImplementationOnce(() => {
      throw new Error('fork failed');
    });
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      onExit,
      restartPolicy: { maxRestarts: 1, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);

    await vi.advanceTimersByTimeAsync(10);

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(onExit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'failed',
        error:
          'Channel worker restart budget exhausted. Last error: fork failed',
        restartCount: 1,
      }),
    );
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'Channel worker restart budget exhausted. Last error: fork failed',
      restartCount: 1,
    });
  });

  it('does not clobber restart spawn failure state on force shutdown', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const spawnWorker = vi.fn().mockReturnValueOnce(firstChild);
    spawnWorker.mockImplementationOnce(() => {
      throw new Error('fork failed');
    });
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);

    supervisor.killAllSync();

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'fork failed',
    });
  });

  it('does not count expired restart attempts against the restart budget', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild(false);
    const thirdChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
      .mockReturnValueOnce(thirdChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 1, windowMs: 50, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(51);
    secondChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);
    thirdChild.emit('message', {
      type: 'ready',
      pid: 33333,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(spawnWorker).toHaveBeenCalledTimes(3);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 33333,
      restartCount: 2,
    });
  });

  it('cancels a pending restart when stopped', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [100] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);

    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
    expect(supervisor.snapshot()).not.toHaveProperty('nextRestartAt');
  });

  it('clears a pending restart timestamp when force shutdown cancels the timer', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const spawnWorker = vi.fn().mockReturnValueOnce(firstChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [100] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);

    expect(supervisor.snapshot()).toHaveProperty('nextRestartAt');
    supervisor.killAllSync();

    expect(supervisor.snapshot()).not.toHaveProperty('nextRestartAt');
  });

  it('restarts when no heartbeat arrives after ready', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      onExit,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
      heartbeatTimeoutMs: TEST_HEARTBEAT_TIMEOUT_MS,
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    await vi.advanceTimersByTimeAsync(TEST_HEARTBEAT_TIMEOUT_MS);
    firstChild.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'exited',
        staleHeartbeatAt: expect.any(String),
      }),
    );
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      restartCount: 1,
    });
    expect(supervisor.snapshot()).not.toHaveProperty('error');
    expect(supervisor.snapshot()).not.toHaveProperty('nextRestartAt');
    expect(supervisor.snapshot()).not.toHaveProperty('staleHeartbeatAt');
  });

  it('restarts when heartbeat becomes stale after ready', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
      heartbeatTimeoutMs: TEST_HEARTBEAT_TIMEOUT_MS,
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('message', {
      type: 'heartbeat',
      pid: 11111,
      at: new Date().toISOString(),
    });

    await vi.advanceTimersByTimeAsync(TEST_HEARTBEAT_TIMEOUT_MS);
    firstChild.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      restartCount: 1,
    });
    expect(supervisor.snapshot()).not.toHaveProperty('lastHeartbeatAt');
  });

  it('ignores heartbeats from a mismatched pid without rearming stale detection', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      heartbeatTimeoutMs: TEST_HEARTBEAT_TIMEOUT_MS,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    await vi.advanceTimersByTimeAsync(TEST_HEARTBEAT_TIMEOUT_MS - 1);

    child.emit('message', {
      type: 'heartbeat',
      pid: 22222,
      at: '2026-07-01T00:00:00.000Z',
    });

    expect(supervisor.snapshot()).not.toHaveProperty('lastHeartbeatAt');
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('keeps the worker running and heartbeat-armed when onReady throws', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onReady: () => {
        throw new Error('pidfile write failed');
      },
      heartbeatTimeoutMs: TEST_HEARTBEAT_TIMEOUT_MS,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 11111,
    });
    await vi.advanceTimersByTimeAsync(TEST_HEARTBEAT_TIMEOUT_MS);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('cancels stale heartbeat detection when stopped intentionally', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
      heartbeatTimeoutMs: TEST_HEARTBEAT_TIMEOUT_MS,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(TEST_HEARTBEAT_TIMEOUT_MS);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('forwards worker stdout and stderr lines with secrets redacted', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'telegram-secret');
    vi.stubEnv('REDIS_PASSWORD', 'redis-secret');
    vi.stubEnv('BASIC_AUTH', 'basic-auth-secret');
    vi.stubEnv('AUTH_ENABLED', 'true');
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy-user:p@ssword@proxy.example:8080');
    const esc = String.fromCharCode(0x1b);
    const child = new FakeChild();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'secret-token',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    child.stderr.emit('data', Buffer.from('failed with secret-token\n'));
    child.stderr.emit('data', Buffer.from('split secret-to\u200bken\n'));
    child.stderr.emit('data', Buffer.from(`ansi secret-${esc}[31mtoken\n`));
    child.stdout.emit('data', Buffer.from('adapter token telegram-secret'));
    child.stdout.emit('data', Buffer.from('\nredis redis-secret\n'));
    child.stdout.emit('data', Buffer.from('auth basic-auth-secret\n'));
    child.stdout.emit(
      'data',
      Buffer.from('benign true wayland authenticated user\n'),
    );
    child.stdout.emit('end');
    child.stderr.emit(
      'data',
      Buffer.from('proxy http://proxy-user:p@ssword@proxy.example:8080/path\n'),
    );
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'failed with <redacted>',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'split <redacted>',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'ansi <redacted>',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stdout',
      line: 'adapter token <redacted>',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stdout',
      line: 'redis <redacted>',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stdout',
      line: 'auth <redacted>',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stdout',
      line: 'benign true wayland authenticated user',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'proxy http://<redacted>@proxy.example:8080/path',
    });
    expect(
      onLog.mock.calls.flatMap((call) => call[0].line).join('\n'),
    ).not.toContain('ssword');
  });

  it('decodes Uint8Array worker log chunks and preserves separation', async () => {
    const child = new FakeChild();
    child.stdout = new EventEmitter();
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    child.stdout.emit(
      'data',
      new Uint8Array(Buffer.from('\tat stack frame\nmetric\tvalue\t42\n')),
    );
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(onLog).toHaveBeenCalledWith({
      stream: 'stdout',
      line: ' at stack frame',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stdout',
      line: 'metric value 42',
    });
  });

  it('forwards CRLF-delimited worker log lines without trailing carriage returns', async () => {
    const child = new FakeChild();
    child.stderr = new EventEmitter();
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    child.stderr.emit('data', Buffer.from('line one\r\nline two\r\n'));
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(onLog).toHaveBeenNthCalledWith(1, {
      stream: 'stderr',
      line: 'line one',
    });
    expect(onLog).toHaveBeenNthCalledWith(2, {
      stream: 'stderr',
      line: 'line two',
    });
  });

  it('flushes oversized worker log buffers without waiting for a newline', async () => {
    const child = new FakeChild();
    child.stderr = new EventEmitter();
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    child.stderr.emit('data', Buffer.from('x'.repeat(70_000)));
    child.stderr.emit('data', Buffer.from('discarded oversized tail'));
    child.stderr.emit('data', Buffer.from('still oversized tail'));
    child.stderr.emit('data', Buffer.from('\nnext line\n'));
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const firstLog = onLog.mock.calls[0]?.[0];
    expect(firstLog).toMatchObject({ stream: 'stderr' });
    expect(firstLog?.line).toHaveLength(4096);
    expect(onLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ line: 'discarded oversized tail' }),
    );
    expect(onLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ line: 'still oversized tail' }),
    );
    expect(onLog).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenLastCalledWith({
      stream: 'stderr',
      line: 'next line',
    });
  });

  it('resumes worker log forwarding after bounded oversized tail discard', async () => {
    const child = new FakeChild();
    child.stderr = new EventEmitter();
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    child.stderr.emit('data', Buffer.from('x'.repeat(70_000)));
    child.stderr.emit('data', Buffer.from('discarded tail'.repeat(6000)));
    child.stderr.emit('data', Buffer.from('resumed line\n'));
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(onLog).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenLastCalledWith({
      stream: 'stderr',
      line: 'resumed line',
    });
  });

  it('handles long non-url worker log lines while applying credential redaction', async () => {
    const child = new FakeChild();
    child.stderr = new EventEmitter();
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    const startedAt = Date.now();
    child.stderr.emit('data', Buffer.from('a.'.repeat(33_000)));
    expectWithinLatencyBudget(Date.now() - startedAt, 1_000);
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const firstLog = onLog.mock.calls[0]?.[0];
    expect(firstLog).toMatchObject({ stream: 'stderr' });
    expect(firstLog?.line).toHaveLength(4096);
  });

  it('does not throw when worker log forwarding bookkeeping fails', async () => {
    const child = new FakeChild();
    child.stderr = new EventEmitter();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog: () => {
        throw new Error('log sink failed');
      },
    });

    const started = supervisor.start();
    expect(() =>
      child.stderr?.emit('data', Buffer.from('line\n')),
    ).not.toThrow();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 12345,
    });
  });

  it('does not throw when a worker log pipe emits an error', async () => {
    const child = new FakeChild();
    child.stderr = new EventEmitter();
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    child.stderr.emit('data', Buffer.from('partial line'));
    expect(() =>
      child.stderr?.emit('error', new Error('pipe failed')),
    ).not.toThrow();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 12345,
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'partial line',
    });
  });

  it('does not throw when onExit bookkeeping fails', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit: () => {
        throw new Error('pidfile cleanup failed');
      },
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;

    expect(() => child.emit('exit', 1, null)).not.toThrow();
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'exited',
      exitCode: 1,
    });
  });

  it('does not notify onExit when stopping a ready worker intentionally', async () => {
    const child = new FakeChild();
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    await supervisor.stop();

    expect(onExit).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('terminates and notifies once when a ready worker emits error', async () => {
    const child = new FakeChild();
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.emit('error', new Error('ipc failed'));

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'exited',
        exitCode: null,
        signal: 'SIGTERM',
        error: 'ipc failed',
      }),
    );
  });

  it('ignores a late error after a ready worker exit is already recorded', async () => {
    const child = new FakeChild();
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.emit('exit', 7, null);
    child.emit('error', new Error('late ipc failed'));

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'exited',
      exitCode: 7,
      signal: null,
    });
  });

  it('can still stop a ready worker after an error without exit', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit: vi.fn(),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.emit('error', new Error('ipc failed'));

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      channels: ['telegram'],
      error: 'ipc failed',
    });

    const stopped = supervisor.stop();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('exit', null, 'SIGKILL');
    await stopped;

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
      signal: 'SIGKILL',
    });
  });

  it('force-kills a ready worker after a post-ready error without marking it failed', async () => {
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.emit('error', new Error('ipc failed'));

    supervisor.killAllSync();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
      signal: 'SIGKILL',
      error: 'ipc failed',
    });
  });

  it('kills the worker synchronously on force shutdown', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;

    supervisor.killAllSync();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
      signal: 'SIGKILL',
    });
  });

  it('force-kills even after SIGTERM was already sent', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.killed = true;

    supervisor.killAllSync();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not clobber failed startup state on force shutdown', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('exit', 1, null);
    await expect(started).rejects.toThrow('Channel worker exited before ready');

    supervisor.killAllSync();

    expect(child.kill).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      exitCode: 1,
      error: expect.stringContaining('Channel worker exited before ready'),
    });
  });

  it('does not clobber failed startup state before exit on force shutdown', async () => {
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('error', new Error('ipc setup failed'));
    await expect(started).rejects.toThrow('ipc setup failed');

    supervisor.killAllSync();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'ipc setup failed',
    });
  });

  it('escalates pre-ready termination to SIGKILL when the worker ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    child.emit('error', new Error('ipc setup failed'));
    await expect(started).rejects.toThrow('ipc setup failed');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'ipc setup failed',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'Channel worker did not exit after SIGKILL; automatic restart is disabled.',
    });
  });

  it('does not release or restart a worker whose SIGKILL exit is unconfirmed', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      spawnWorker,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;

    const stopped = supervisor.stop();
    void stopped.catch(() => {});
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stopped).rejects.toThrow(
      'Channel worker did not exit after SIGKILL.',
    );

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'Channel worker did not exit after SIGKILL.',
    });
    expect(supervisor.snapshot()).not.toHaveProperty('signal');

    await expect(supervisor.start()).rejects.toThrow(
      'Channel worker stop is not yet confirmed.',
    );
    expect(spawnWorker).toHaveBeenCalledTimes(1);

    const retriedStop = supervisor.stop();
    void retriedStop.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(retriedStop).rejects.toThrow(
      'Channel worker did not exit after SIGKILL.',
    );
    await expect(supervisor.start()).rejects.toThrow(
      'Channel worker stop is not yet confirmed.',
    );
    expect(spawnWorker).toHaveBeenCalledTimes(1);

    child.emit('exit', 0, null);

    const restarted = supervisor.start();
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await restarted;

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
  });

  it('delivers a channel message through a running worker', async () => {
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const delivered = supervisor.deliverChannelMessage!(deliveryRequest);
    const sent = child.send.mock.calls[0]![0] as { id: string };
    expect(sent).toMatchObject({
      type: 'channel_delivery',
      id: expect.any(String),
      expiresAt: expect.any(Number),
      request: deliveryRequest,
    });
    child.emit('message', {
      type: 'channel_delivery_result',
      id: sent.id,
      ok: true,
    });

    await expect(delivered).resolves.toEqual({ delivered: true });
  });

  it('rejects channel delivery when the supervisor is full', async () => {
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });
    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const pending = Array.from(
      { length: MAX_CHANNEL_DELIVERIES_IN_FLIGHT },
      () => supervisor.deliverChannelMessage!(deliveryRequest),
    );
    const overflow = supervisor.deliverChannelMessage!(deliveryRequest).catch(
      (error: unknown) => error,
    );

    expect(child.send).toHaveBeenCalledTimes(MAX_CHANNEL_DELIVERIES_IN_FLIGHT);
    await expect(overflow).resolves.toMatchObject({
      code: 'channel_delivery_queue_full',
      message: 'Channel delivery queue is full.',
    });

    const first = child.send.mock.calls[0]![0] as { id: string };
    child.emit('message', {
      type: 'channel_delivery_result',
      id: first.id,
      ok: true,
    });
    await expect(pending[0]).resolves.toEqual({ delivered: true });

    const replacement = supervisor.deliverChannelMessage!(deliveryRequest);
    expect(child.send).toHaveBeenCalledTimes(
      MAX_CHANNEL_DELIVERIES_IN_FLIGHT + 1,
    );
    child.emit('exit', 1, null);
    await Promise.allSettled([...pending.slice(1), replacement]);
  });

  it('rejects channel delivery when the worker is not running', async () => {
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => new FakeChild()),
    });

    await expect(
      supervisor.deliverChannelMessage!(deliveryRequest),
    ).rejects.toMatchObject({
      code: 'channel_worker_unavailable',
      message: 'Channel worker is not running.',
    });
  });

  it('rejects typed delivery errors reported by the worker', async () => {
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });
    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;

    const delivered = supervisor.deliverChannelMessage!(deliveryRequest);
    const sent = child.send.mock.calls[0]![0] as { id: string };
    child.emit('message', {
      type: 'channel_delivery_result',
      id: sent.id,
      ok: false,
      code: 'channel_delivery_failed',
      error: 'Platform send failed.',
    });

    await expect(delivered).rejects.toMatchObject({
      code: 'channel_delivery_failed',
      message: 'Platform send failed.',
    });
  });

  it('rejects channel delivery when IPC send throws synchronously', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    child.send.mockImplementationOnce(() => {
      throw new Error('send boom');
    });
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const rejected = supervisor.deliverChannelMessage!(deliveryRequest).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Channel worker IPC send failed: send boom',
    );
    expect((error as { code?: string }).code).toBe(
      'channel_worker_unavailable',
    );
  });

  it('rejects channel delivery when the IPC send callback reports an error', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    child.send.mockImplementationOnce((_message, callback) => {
      callback?.(new Error('callback boom'));
      return true;
    });
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const rejected = supervisor.deliverChannelMessage!(deliveryRequest).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Channel worker IPC send failed: callback boom',
    );
    expect((error as { code?: string }).code).toBe(
      'channel_worker_unavailable',
    );
  });

  it('times out delivery and rejects pending work when the worker exits', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });
    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;

    const timedOut = supervisor.deliverChannelMessage!(deliveryRequest).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(CHANNEL_DELIVERY_IPC_TIMEOUT_MS);
    await expect(timedOut).resolves.toMatchObject({
      code: 'channel_delivery_timeout',
    });

    const pending = supervisor.deliverChannelMessage!(deliveryRequest);
    child.emit('exit', 1, null);
    await expect(pending).rejects.toMatchObject({
      code: 'channel_worker_unavailable',
      message: 'Channel worker exited.',
    });
  });

  it('sends a webhook task to a running worker over IPC', async () => {
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask);
    const sent = child.send.mock.calls[0]![0] as { id: string };
    expect(sent).toMatchObject({
      type: 'webhook_task',
      id: expect.any(String),
      expiresAt: expect.any(Number),
      task: webhookTask,
    });

    child.emit('message', {
      type: 'webhook_task_result',
      id: sent.id,
      ok: true,
    });

    await expect(accepted).resolves.toEqual({ accepted: true });
  });

  it('rejects webhook tasks when the worker is not running', async () => {
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => new FakeChild()),
    });

    await expect(supervisor.enqueueWebhookTask(webhookTask)).rejects.toThrow(
      'Channel worker is not running.',
    );
  });

  it('rejects webhook tasks when the worker reports an IPC error', async () => {
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask);
    const sent = child.send.mock.calls[0]![0] as { id: string };
    child.emit('message', {
      type: 'webhook_task_result',
      id: sent.id,
      ok: false,
      error: 'boom',
    });

    await expect(accepted).rejects.toThrow('boom');
  });

  it('keeps webhook tasks pending when IPC send reports backpressure', async () => {
    const child = new FakeChild(false);
    child.send.mockReturnValueOnce(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask);
    const sent = child.send.mock.calls[0]![0] as { id: string };
    child.emit('message', {
      type: 'webhook_task_result',
      id: sent.id,
      ok: true,
    });

    await expect(accepted).resolves.toEqual({ accepted: true });
  });

  it('rejects webhook tasks when IPC send throws synchronously', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    child.send.mockImplementationOnce(() => {
      throw new Error('send boom');
    });
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const rejected = supervisor.enqueueWebhookTask(webhookTask).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Channel worker IPC send failed: send boom',
    );
    expect((error as { code?: string }).code).toBe(
      'channel_worker_unavailable',
    );
  });

  it('rejects webhook tasks when the IPC send callback reports an error', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    child.send.mockImplementationOnce((_message, callback) => {
      callback?.(new Error('callback boom'));
      return true;
    });
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const rejected = supervisor.enqueueWebhookTask(webhookTask).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Channel worker IPC send failed: callback boom',
    );
    expect((error as { code?: string }).code).toBe(
      'channel_worker_unavailable',
    );
  });

  it('rejects webhook tasks when IPC result times out', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await accepted;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Channel webhook task IPC timed out.',
    );
  });

  it('rejects pending webhook tasks when the worker exits', async () => {
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask);
    child.emit('exit', 1, null);

    await expect(accepted).rejects.toThrow('Channel worker exited.');
  });

  it('rejects pending webhook tasks when the supervisor stops', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask);
    await supervisor.stop();

    await expect(accepted).rejects.toThrow('Channel worker stopped.');
  });

  describe('restart()', () => {
    const waitForCalls = async (getCount: () => number, count: number) => {
      for (let i = 0; i < 100 && getCount() < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    it('stops the running worker and relaunches it so settings are re-read', async () => {
      const child1 = new FakeChild();
      const child2 = new FakeChild();
      const queue = [child1, child2];
      const spawnWorker = vi.fn(() => queue.shift()!);
      const supervisor = createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        spawnWorker,
      });

      const started = supervisor.start();
      child1.emit('message', {
        type: 'ready',
        pid: 111,
        channels: ['telegram'],
      });
      await started;
      expect(supervisor.snapshot()).toMatchObject({
        state: 'running',
        pid: 111,
      });

      const restarted = supervisor.restart();
      await waitForCalls(() => spawnWorker.mock.calls.length, 2);
      child2.emit('message', {
        type: 'ready',
        pid: 222,
        channels: ['telegram'],
      });
      const snapshot = await restarted;

      expect(child1.kill).toHaveBeenCalled();
      expect(spawnWorker).toHaveBeenCalledTimes(2);
      expect(snapshot).toMatchObject({ state: 'running', pid: 222 });
      expect(supervisor.snapshot()).toMatchObject({
        state: 'running',
        pid: 222,
      });
    });

    it('coalesces concurrent restarts onto a single relaunch', async () => {
      const child1 = new FakeChild();
      const child2 = new FakeChild();
      const queue = [child1, child2];
      const spawnWorker = vi.fn(() => queue.shift()!);
      const supervisor = createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        spawnWorker,
      });

      const started = supervisor.start();
      child1.emit('message', {
        type: 'ready',
        pid: 111,
        channels: ['telegram'],
      });
      await started;

      const first = supervisor.restart();
      const second = supervisor.restart();
      await waitForCalls(() => spawnWorker.mock.calls.length, 2);
      child2.emit('message', {
        type: 'ready',
        pid: 222,
        channels: ['telegram'],
      });
      const [a, b] = await Promise.all([first, second]);

      // Initial start + exactly one relaunch: concurrent restarts share the
      // same in-flight promise and never fork a second worker.
      expect(spawnWorker).toHaveBeenCalledTimes(2);
      expect(a).toMatchObject({ state: 'running', pid: 222 });
      expect(b).toMatchObject({ state: 'running', pid: 222 });
    });

    it('rejects on relaunch failure, then recovers on a later restart', async () => {
      const child1 = new FakeChild();
      const child2 = new FakeChild();
      let call = 0;
      const spawnWorker = vi.fn(() => {
        call += 1;
        if (call === 2) {
          throw new Error('fork failed');
        }
        return call === 1 ? child1 : child2;
      });
      const supervisor = createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        spawnWorker,
      });

      const started = supervisor.start();
      child1.emit('message', {
        type: 'ready',
        pid: 111,
        channels: ['telegram'],
      });
      await started;

      // Second spawn throws — the relaunch fails and the worker parks in
      // `failed` (channels down), and restart() surfaces the error.
      await expect(supervisor.restart()).rejects.toThrow(/fork failed/);
      expect(supervisor.snapshot()).toMatchObject({ state: 'failed' });

      // A later restart resets the budget and recovers once spawning works.
      const recovered = supervisor.restart();
      await waitForCalls(() => spawnWorker.mock.calls.length, 3);
      child2.emit('message', {
        type: 'ready',
        pid: 333,
        channels: ['telegram'],
      });
      expect(await recovered).toMatchObject({ state: 'running', pid: 333 });
    });

    it('does not relaunch after killAllSync latches disposed', async () => {
      const child1 = new FakeChild();
      const spawnWorker = vi.fn(() => child1);
      const supervisor = createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        spawnWorker,
      });

      const started = supervisor.start();
      child1.emit('message', {
        type: 'ready',
        pid: 111,
        channels: ['telegram'],
      });
      await started;

      supervisor.killAllSync();
      expect(spawnWorker).toHaveBeenCalledTimes(1);

      // A reload after a hard shutdown must be a no-op, not a relaunch.
      const snapshot = await supervisor.restart();
      expect(spawnWorker).toHaveBeenCalledTimes(1);
      expect(snapshot.state).toBe('stopped');
    });

    it('does not fork a new worker when killAllSync races an in-flight restart', async () => {
      const child1 = new FakeChild();
      const child2 = new FakeChild();
      const queue = [child1, child2];
      const spawnWorker = vi.fn(() => queue.shift()!);
      const supervisor = createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        spawnWorker,
      });

      const started = supervisor.start();
      child1.emit('message', {
        type: 'ready',
        pid: 111,
        channels: ['telegram'],
      });
      await started;

      // Begin a reload, then simulate a hard daemon shutdown before the
      // relaunch's start() runs. The disposed latch must prevent a new fork
      // (which would otherwise orphan a worker spawned during shutdown).
      const restarted = supervisor.restart();
      supervisor.killAllSync();
      await restarted;

      expect(spawnWorker).toHaveBeenCalledTimes(1);
    });
  });
});
