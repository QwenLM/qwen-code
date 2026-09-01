/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen serve` daemon — HTTP route + middleware integration tests.
 *
 * These exercise the daemon end-to-end without needing a working model
 * credential: they spawn a real `node packages/cli/dist/index.js serve`
 * with dummy OpenAI auth env, then probe the HTTP surface without issuing
 * model calls. Session creation, listing, cancellation, validation, SSE
 * wiring, the CORS guard, the bearer-auth guard and shutdown all run here.
 *
 * Tests that require prompt streaming or real permission flows live in
 * `qwen-serve-streaming.test.ts`, backed by the local fake OpenAI server.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DaemonClient,
  DaemonHttpError,
  type DaemonSessionSummary,
} from '@qwen-code/sdk';
import { AcpWsTransport } from '@qwen-code/sdk/daemon/transports';
import {
  SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
  Storage,
  type ChatRecord,
} from '@qwen-code/qwen-code-core';
import { isNativeDirectoryPickerAvailable } from '../../packages/cli/src/serve/native-directory-picker.js';
import {
  isLocalPathOpenAvailable,
  isLocalTerminalAvailable,
} from '../../packages/cli/src/serve/local-path-open.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Match the rest of the integration suite: prefer the bundled CLI
// path that `globalSetup.ts` configures via `TEST_CLI_PATH` (root
// `dist/cli.js`), falling back to the per-package output for direct
// `vitest run integration-tests/...` invocations that bypass
// globalSetup. Without this two-tier resolution the suite became
// sensitive to which build step (`npm run build` vs `npm run bundle`)
// last ran.
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ??
  path.resolve(__dirname, '../../packages/cli/dist/index.js');
const TOKEN = 'integration-test-token';
const REPO_ROOT = path.resolve(__dirname, '../..');

let daemon: ChildProcess;
let homeDir = '';
let port = 0;
let base = '';
let client: DaemonClient;
// The daemon evaluates isNativeDirectoryPickerAvailable() in its own process
// at boot. Probe once at spawn time (same host, same uid, same relevant env)
// so the expectation matches the daemon's boot-time view; re-probing at
// assertion time minutes later diverged when the host's GUI session state
// drifted mid-run (red macOS E2E runs after #9406, tracked in #10453).
let nativeDirectoryPickerAtBoot = false;
// Same boot-time probe pinning as above, for the workspace_local_open tag.
let localPathOpenAtBoot = false;
// Same boot-time probe pinning as above, for the workspace_local_terminal tag.
let localTerminalOpenAtBoot = false;

function writePersistedTranscript(
  sessionId: string,
  records: ChatRecord[],
  state: 'active' | 'archived' = 'active',
): string {
  const qwenHome = path.join(homeDir, '.qwen');
  const projectDir = Storage.runWithRuntimeBaseDir(qwenHome, REPO_ROOT, () =>
    new Storage(REPO_ROOT).getProjectDir(),
  );
  const chatsDir = path.join(
    projectDir,
    'chats',
    ...(state === 'archived' ? ['archive'] : []),
  );
  mkdirSync(chatsDir, { recursive: true });
  const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
  writeFileSync(
    filePath,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
  return filePath;
}

function chatRecord(
  sessionId: string,
  uuid: string,
  parentUuid: string | null,
  text: string,
): ChatRecord {
  const assistant = uuid.startsWith('a');
  return {
    uuid,
    parentUuid,
    sessionId,
    timestamp: assistant
      ? '2026-07-08T00:00:01.000Z'
      : '2026-07-08T00:00:00.000Z',
    type: assistant ? 'assistant' : 'user',
    cwd: REPO_ROOT,
    version: '1.0.0',
    message: {
      role: assistant ? 'model' : 'user',
      parts: [{ text }],
    },
  };
}

beforeAll(async () => {
  homeDir = mkdtempSync(path.join(tmpdir(), 'qwen-serve-routes-home-'));
  nativeDirectoryPickerAtBoot = isNativeDirectoryPickerAvailable();
  localPathOpenAtBoot = isLocalPathOpenAvailable();
  localTerminalOpenAtBoot = isLocalTerminalAvailable();
  daemon = spawn(
    process.execPath,
    [
      CLI_BIN,
      'serve',
      '--port',
      '0',
      '--token',
      TOKEN,
      '--hostname',
      '127.0.0.1',
      // Per #3803 §02 (1 daemon = 1 workspace), pin the bound
      // workspace so test assertions that POST `workspaceCwd:
      // REPO_ROOT` succeed regardless of where the test runner
      // happens to be cwd'd. Without this the daemon would inherit
      // the test runner's cwd, which is brittle across CI / local
      // / IDE-launcher environments.
      '--workspace',
      REPO_ROOT,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Strip the env toggles that flip conditional capability tags
      // (`prompt_absolute_deadline`, `writer_idle_timeout`,
      // `rate_limit`, and the pool tags via the kill switch). The
      // capabilities baseline below assumes their default state; a
      // dev machine exporting any of these would otherwise fail the
      // exact-equality assertion.
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) =>
              ![
                'QWEN_SERVE_PROMPT_DEADLINE_MS',
                'QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS',
                'QWEN_SERVE_RATE_LIMIT',
                'QWEN_SERVE_NO_MCP_POOL',
                'QWEN_SERVE_NO_PERSISTENT_REGISTRATION',
                'QWEN_SERVE_CLIENT_MCP_OVER_WS',
                'QWEN_SERVE_CDP_TUNNEL_OVER_WS',
              ].includes(k),
          ),
        ),
        HOME: homeDir,
        QWEN_HOME: path.join(homeDir, '.qwen'),
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
      },
    },
  );
  // Read stdout until we see the listening line + parse the port.
  port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    // Capture the timeout handle so we can clear it on success — an
    // un-cleared timer outlives the spawn promise and keeps the
    // vitest event loop alive past the test, manifesting as
    // intermittent `Test timed out` retries on slow CI.
    // 25s is strictly below the 30s beforeAll backstop so this
    // descriptive rejection fires first on a genuine boot hang.
    const bootTimer = setTimeout(
      () => reject(new Error('daemon boot timeout')),
      25_000,
    );
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        daemon.stdout?.off('data', onData);
        clearTimeout(bootTimer);
        resolve(Number(m[1]));
      }
    };
    daemon.stdout!.on('data', onData);
    daemon.once('exit', (c) => {
      clearTimeout(bootTimer);
      reject(new Error(`daemon exited with ${c}`));
    });
  });
  base = `http://127.0.0.1:${port}`;
  client = new DaemonClient({ baseUrl: base, token: TOKEN });
}, 30_000);

afterAll(async () => {
  try {
    if (!daemon || daemon.exitCode !== null) return;
    daemon.kill('SIGTERM');
    await new Promise((r) => daemon.once('exit', r));
  } finally {
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }
}, 15_000);

describe('qwen serve — bearer auth (timing-safe compare)', () => {
  // Probe `/capabilities` for the rejection cases instead of `/health`
  // — `/health` is intentionally registered before the bearer middleware
  // so liveness probes work without credentials. `/capabilities` is the
  // cheapest route still gated by the bearer chain.
  it('right token → 200', async () => {
    const res = await fetch(`${base}/capabilities`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('wrong same-length token → 401', async () => {
    const res = await fetch(`${base}/capabilities`, {
      headers: { Authorization: `Bearer ${'X'.repeat(TOKEN.length)}` },
    });
    expect(res.status).toBe(401);
  });

  it('wrong shorter token → 401', async () => {
    const res = await fetch(`${base}/capabilities`, {
      headers: { Authorization: 'Bearer x' },
    });
    expect(res.status).toBe(401);
  });

  it('missing Authorization header → 401', async () => {
    const res = await fetch(`${base}/capabilities`);
    expect(res.status).toBe(401);
  });

  it('Basic scheme (not Bearer) → 401', async () => {
    const res = await fetch(`${base}/capabilities`, {
      headers: { Authorization: `Basic ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('/health exempt: missing Authorization header → 200', async () => {
    // Locks the auth-bypass exemption documented in
    // docs/developers/qwen-serve-protocol.md so a future middleware
    // ordering change can't silently break liveness probes.
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('qwen serve — CORS browser-origin denial', () => {
  it('GET with Origin header → 403 + JSON', async () => {
    const res = await fetch(`${base}/health`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'https://evil.example.com',
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({
      error: 'Request denied by CORS policy',
    });
  });

  it('GET without Origin header → 200', async () => {
    const res = await fetch(`${base}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('qwen serve — capabilities envelope', () => {
  it('advertises all baseline capabilities', async () => {
    const caps = await client.capabilities();
    expect(caps.v).toBe(1);
    expect(caps.mode).toBe('http-bridge');
    // Order must match `SERVE_CAPABILITY_REGISTRY` in
    // `packages/cli/src/serve/capabilities.ts` and the unit-level
    // baseline features in `packages/cli/src/serve/server.test.ts`.
    //
    // Conditional tags absent under this suite's spawn flags (no
    // `--require-auth` / `--allow-origin` / deadline env vars /
    // rate-limit opt-in, no `--channel`, no configured batch ASR model):
    // `require_auth`, `allow_origin`, `cdp_tunnel_over_ws`,
    // `prompt_absolute_deadline`, `writer_idle_timeout`,
    // `workspace_voice_transcription`, `rate_limit`, `channel_reload`.
    // `native_directory_picker` is host-conditional (the daemon host's GUI
    // environment, not a spawn flag) and is spliced at its registry
    // position below, using the boot-time probe captured when the daemon
    // was spawned rather than a fresh probe at assertion time.
    // Pool tags (`mcp_workspace_pool`, `mcp_pool_restart`) ARE present
    // because the workspace MCP pool is on by default, as are
    // `workspace_settings`, `workspace_permissions`, `workspace_voice`,
    // `workspace_trust`, `workspace_github_setup`, and `workspace_reload`.
    // `scheduled_task_session_reuse` appears only after the managed runtime
    // mounts, so the fast-path bootstrap and runtime envelopes legitimately
    // differ by that tag. Its transition is covered by the serve startup tests.
    expect(
      caps.features.filter(
        (feature) => feature !== 'scheduled_task_session_reuse',
      ),
    ).toEqual([
      'health',
      'daemon_status',
      'capabilities',
      'session_create',
      'session_id_override',
      'session_scope_override',
      'session_load',
      'session_resume',
      'unstable_session_resume',
      'session_list',
      'session_info',
      'session_source_metadata',
      'session_side_task',
      'session_prompt',
      'session_turn_status',
      'session_attachments',
      'session_mid_turn_message_mutation',
      'session_mid_turn_message_query',
      'session_cancel',
      'session_events',
      'session_artifacts',
      'session_artifacts_persistence',
      'slow_client_warning',
      'typed_event_schema',
      'session_set_model',
      'client_identity',
      'client_heartbeat',
      'session_permission_vote',
      'permission_vote',
      'workspace_mcp',
      'workspace_skills',
      'workspace_skills_config_runtime',
      'workspace_providers',
      'workspace_acp_preheat',
      'workspace_acp_status',
      'auth_provider_install',
      'workspace_memory',
      'workspace_memory_remember',
      'workspace_memory_remember_project_scope',
      'workspace_memory_remember_user_scope',
      'workspace_memory_forget',
      'workspace_memory_forget_scope',
      'workspace_memory_dream',
      'workspace_agents',
      'workspace_agent_generate',
      'workspace_env',
      'workspace_preflight',
      'session_context',
      'session_context_usage',
      'session_supported_commands',
      'session_tasks',
      'session_monitor_tool_correlation',
      'session_stats',
      'session_lsp',
      'session_status',
      'session_close',
      'session_archive',
      'session_storage_conflict_repair',
      'session_metadata',
      'session_organization',
      'session_export',
      'standalone_sessions_v1',
      'session_transcript',
      'session_transcript_pagination',
      'mcp_guardrails',
      'workspace_mcp_manage',
      'mcp_guardrail_events',
      'mcp_server_runtime_mutation',
      'workspace_file_read',
      'workspace_file_bytes',
      'workspace_file_read_cursor',
      'workspace_file_write',
      'workspace_file_upload',
      'session_approval_mode_control',
      'workspace_tool_toggle',
      'workspace_skill_settings_toggle',
      'workspace_skill_settings_batch_toggle',
      'extension_batch_activation_v2',
      'workspace_skill_manage',
      'workspace_settings',
      'workspace_permissions',
      'workspace_voice',
      'workspace_trust',
      'workspace_trust_hot_reload',
      'workspace_init',
      'workspace_github_setup',
      'workspace_github_prs',
      'workspace_mcp_restart',
      'session_recap',
      'session_generation',
      'workspace_generation',
      'session_btw',
      'mcp_workspace_pool',
      'mcp_pool_restart',
      'auth_device_flow',
      'permission_mediation',
      'non_blocking_prompt',
      'session_language',
      'user_language_sync',
      'session_rewind',
      'workspace_hooks',
      'session_hooks',
      'workspace_extensions',
      'session_branch',
      'workspace_reload',
      'channel_delivery',
      'channel_control',
      'channel_management',
      'workspace_channel_observed_contacts',
      'dynamic_workspace_registration',
      'persistent_workspace_registration',
      'workspace_display_name',
      'scratch_workspace_registration',
      'workspace_runtime_removal',
      ...(nativeDirectoryPickerAtBoot ? ['native_directory_picker'] : []),
      'workspace_runtime',
      ...(localPathOpenAtBoot ? ['workspace_local_open'] : []),
      ...(localTerminalOpenAtBoot ? ['workspace_local_terminal'] : []),
      'workspace_qualified_rest_core',
      'extension_management_v2',
      'extension_state',
      'extension_git_credentials',
      'extension_local_path_install',
      'workspace_persisted_transcript',
      'workspace_session_export',
      'workspace_archived_session_export',
      'workspace_session_live_state',
      'workspace_session_metadata',
      'voice_transcribe',
      'web_terminal',
    ]);
  });
});

describe('qwen serve — local Extension install', () => {
  it('installs an absolute daemon-local directory into managed storage', async () => {
    const source = path.join(homeDir, 'local-extension-source');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      path.join(source, 'qwen-extension.json'),
      JSON.stringify({
        name: 'daemon-local-path-e2e',
        version: '1.0.0',
      }),
      'utf8',
    );

    const accepted = await client.installExtension({ source, consent: true });
    await expect
      .poll(
        async () =>
          (await client.extensionOperationStatus(accepted.operationId)).status,
        { timeout: 10_000 },
      )
      .toBe('succeeded');

    const operation = await client.extensionOperationStatus(
      accepted.operationId,
    );
    expect(operation.result).toMatchObject({
      status: 'installed',
      source,
      name: 'daemon-local-path-e2e',
    });
    const status = await client.workspaceExtensions();
    const installed = status.extensions.find(
      (extension) => extension.name === 'daemon-local-path-e2e',
    );
    expect(installed).toMatchObject({
      source,
      installType: 'local',
    });
    expect(installed?.path).not.toBe(source);
    expect(
      installed?.path.startsWith(
        `${path.join(homeDir, '.qwen', 'extensions')}${path.sep}`,
      ),
    ).toBe(true);
  });
});

describe('qwen serve — transcript paging route', () => {
  const getTranscript = (sessionId: string, query = '') =>
    fetch(`${base}/session/${sessionId}/transcript${query}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

  it('serves persisted transcript pages through the SDK helper', async () => {
    const sessionId = '99999999-aaaa-bbbb-cccc-111111111111';
    writePersistedTranscript(sessionId, [
      chatRecord(sessionId, 'u1', null, 'hello persisted transcript'),
      chatRecord(sessionId, 'a1', 'u1', 'hello from replay'),
    ]);

    const first = await client.getSessionTranscriptPage(sessionId, {
      limit: 1,
    });
    expect(first.sessionId).toBe(sessionId);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.every((event) => event.type === 'session_update')).toBe(
      true,
    );
    expect(first.events.some((event) => 'id' in event)).toBe(false);

    const second = await client.getSessionTranscriptPage(sessionId, {
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect(second.sessionId).toBe(sessionId);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
    expect(second.events.length).toBeGreaterThan(0);
    expect(
      second.events.every((event) => event.type === 'session_update'),
    ).toBe(true);
    expect(second.events.some((event) => 'id' in event)).toBe(false);
  });

  it('maps transcript request validation errors through the real daemon', async () => {
    const sessionId = '99999999-aaaa-bbbb-cccc-222222222222';
    writePersistedTranscript(sessionId, [
      chatRecord(sessionId, 'u1', null, 'validation transcript'),
    ]);

    const invalidLimit = await getTranscript(sessionId, '?limit=0');
    expect(invalidLimit.status).toBe(400);
    await expect(invalidLimit.json()).resolves.toMatchObject({
      code: 'invalid_transcript_limit',
    });

    const invalidCursor = await getTranscript(
      sessionId,
      '?cursor=not-a-cursor',
    );
    expect(invalidCursor.status).toBe(400);
    await expect(invalidCursor.json()).resolves.toMatchObject({
      code: 'invalid_transcript_cursor',
    });

    const missing = await getTranscript('99999999-aaaa-bbbb-cccc-333333333333');
    expect(missing.status).toBe(404);
  });

  it('reads exact conflicts from active and maps archived/unavailable snapshots to 409', async () => {
    const archivedId = '99999999-aaaa-bbbb-cccc-444444444444';
    const archivedRecord = chatRecord(
      archivedId,
      'u1',
      null,
      'archived transcript',
    );
    writePersistedTranscript(archivedId, [archivedRecord], 'archived');
    const archived = await getTranscript(archivedId);
    expect(archived.status).toBe(409);
    await expect(archived.json()).resolves.toMatchObject({
      code: 'session_archived',
    });

    const conflictId = '99999999-aaaa-bbbb-cccc-555555555555';
    const activeConflictRecord = chatRecord(
      conflictId,
      'u1',
      null,
      'active conflicting transcript',
    );
    const archivedConflictRecord = chatRecord(
      conflictId,
      'u1',
      null,
      'archived conflicting transcript',
    );
    writePersistedTranscript(conflictId, [activeConflictRecord]);
    writePersistedTranscript(conflictId, [archivedConflictRecord], 'archived');
    const conflict = await getTranscript(conflictId);
    expect(conflict.status).toBe(200);
    const conflictBody = await conflict.json();
    expect(conflictBody).toMatchObject({
      sessionId: conflictId,
      hasMore: false,
    });
    expect(JSON.stringify(conflictBody)).toContain(
      'active conflicting transcript',
    );
    expect(JSON.stringify(conflictBody)).not.toContain(
      'archived conflicting transcript',
    );

    const unavailable = await getTranscript(
      '99999999-aaaa-bbbb-cccc-666666666666',
      '?cursor=stale',
    );
    expect(unavailable.status).toBe(409);
    await expect(unavailable.json()).resolves.toMatchObject({
      code: 'transcript_snapshot_unavailable',
    });
  });

  it('rejects oversized transcript snapshots with 413', async () => {
    const sessionId = '99999999-aaaa-bbbb-cccc-777777777777';
    const filePath = writePersistedTranscript(sessionId, [
      chatRecord(sessionId, 'u1', null, 'oversized transcript'),
    ]);
    truncateSync(filePath, SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1);

    const response = await getTranscript(sessionId);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: 'transcript_too_large',
      maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
    });
  });

  afterAll(() => {
    // The persisted transcript fixtures above live in the daemon's project
    // `chats/` dir. Remove them so later suites (e.g. PATCH metadata's
    // listWorkspaceSessions readback) start from a clean session list: extra
    // persisted sessions widen a pre-existing listing race and flake them.
    const qwenHome = path.join(homeDir, '.qwen');
    const projectDir = Storage.runWithRuntimeBaseDir(qwenHome, REPO_ROOT, () =>
      new Storage(REPO_ROOT).getProjectDir(),
    );
    rmSync(path.join(projectDir, 'chats'), { recursive: true, force: true });
  });
});

describe('qwen serve — POST /session validation + concurrent coalescing', () => {
  it('rejects relative cwd', async () => {
    const res = await fetch(`${base}/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ cwd: 'relative/path' }),
    });
    expect(res.status).toBe(400);
  });

  it('honors and reserves a normalized caller-supplied session ID', async () => {
    const requestedId = '550E8400-E29B-41D4-A716-446655440000';
    const normalizedId = requestedId.toLowerCase();
    const created = await fetch(`${base}/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        cwd: REPO_ROOT,
        sessionId: requestedId,
        sessionScope: 'single',
      }),
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      sessionId: normalizedId,
      attached: false,
    });

    try {
      let conflict: unknown;
      try {
        await client.createOrAttachSession({
          workspaceCwd: REPO_ROOT,
          sessionId: normalizedId,
        });
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(DaemonHttpError);
      expect((conflict as DaemonHttpError).status).toBe(409);
      expect((conflict as DaemonHttpError).body).toMatchObject({
        code: 'session_id_conflict',
        sessionId: normalizedId,
      });

      await client.closeSession(normalizedId);

      const sdkRest = await client.createOrAttachSession({
        workspaceCwd: REPO_ROOT,
        sessionId: requestedId,
      });
      expect(sdkRest).toMatchObject({
        sessionId: normalizedId,
        attached: false,
      });
      await client.closeSession(normalizedId);

      const acpTransport = new AcpWsTransport(
        `ws://127.0.0.1:${port}/acp`,
        TOKEN,
      );
      const acpClient = new DaemonClient({
        baseUrl: base,
        token: TOKEN,
        transport: acpTransport,
      });
      try {
        const sdkAcp = await acpClient.createOrAttachSession({
          workspaceCwd: REPO_ROOT,
          sessionId: requestedId,
        });
        expect(sdkAcp).toMatchObject({ sessionId: normalizedId });
        await client.closeSession(normalizedId);
      } finally {
        acpClient.dispose();
      }

      const invalid = await fetch(`${base}/session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cwd: REPO_ROOT, sessionId: '../escape' }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        code: 'invalid_session_id',
      });
    } finally {
      await client.closeSession(normalizedId).catch(() => undefined);
    }
  });

  it('two parallel POSTs same workspace coalesce to one session', async () => {
    const cwd = REPO_ROOT;
    const [a, b] = await Promise.all([
      client.createOrAttachSession({ workspaceCwd: cwd }),
      client.createOrAttachSession({ workspaceCwd: cwd }),
    ]);
    expect(a.sessionId).toBe(b.sessionId);
    // Exactly one of the two reports `attached: false` (the spawn owner).
    expect([a.attached, b.attached].sort()).toEqual([false, true]);
  });

  it('bad modelServiceId keeps the session alive on the default model', async () => {
    // Per #3889 review A05Ym: when the requested model is rejected at
    // create-session time, the session stays operational on the
    // agent's default model. The caller gets a sessionId they can
    // retry the model switch against (via POST /session/:id/model).
    // Tearing the session down on model-switch failure would force
    // the caller into a 500 with no way to recover. The
    // `model_switch_failed` SSE event is the visible failure signal.
    //
    // Use REPO_ROOT (the daemon's bound workspace) — under #3803 §02
    // any other cwd would return 400 workspace_mismatch before the
    // session is even spawned.
    const cwd = REPO_ROOT;
    const session = await client.createOrAttachSession({
      workspaceCwd: cwd,
      modelServiceId: 'definitely-not-a-real-model',
    });
    expect(session.sessionId).toBeTypeOf('string');
    // `attached` may be true or false depending on whether earlier
    // tests in this file already created a REPO_ROOT session. The
    // shape of the response is what matters here (sessionId present,
    // listWorkspaceSessions sees it).
    expect(typeof session.attached).toBe('boolean');
    const sessions = await client.listWorkspaceSessions(cwd);
    expect(sessions.some((s) => s.sessionId === session.sessionId)).toBe(true);
    // No teardown — Stage 1 has no DELETE /session route, and the
    // session persists in `byId` until daemon shutdown.
  });

  it('rejects cross-workspace cwd with 400 workspace_mismatch (#3803 §02)', async () => {
    // The daemon is bound to REPO_ROOT (via `--workspace` in beforeAll).
    // A POST /session with `cwd: '/tmp'` (or any other absolute path
    // that doesn't canonicalize to REPO_ROOT) must reject with 400
    // `workspace_mismatch`, carrying both paths in the body so an
    // orchestrator-aware client can spawn / route to the right
    // daemon.
    const res = await fetch(`${base}/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ cwd: '/tmp' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code?: string;
      boundWorkspace?: string;
      requestedWorkspace?: string;
    };
    expect(body.code).toBe('workspace_mismatch');
    expect(body.boundWorkspace).toBe(REPO_ROOT);
    // The bridge canonicalizes the requested cwd via `realpathSync.native`
    // so the response carries the on-disk canonical form, NOT the literal
    // we POSTed. On macOS `/tmp` is a symlink to `/private/tmp`, so the
    // hardcoded `/tmp` literal would diverge there. Resolve the same way
    // the bridge does to keep the assertion portable.
    expect(body.requestedWorkspace).toBe(realpathSync.native('/tmp'));
  });

  it('omits cwd → falls back to bound workspace (#3803 §02)', async () => {
    // The route accepts an empty body and falls back to the daemon's
    // bound workspace. Asserting this end-to-end through a real
    // daemon process verifies the runQwenServe → createServeApp →
    // bridge plumbing for the fallback path.
    const res = await fetch(`${base}/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const session = (await res.json()) as {
      sessionId?: string;
      workspaceCwd?: string;
    };
    expect(session.workspaceCwd).toBe(REPO_ROOT);
  });

  it('GET /capabilities surfaces workspaceCwd (#3803 §02)', async () => {
    const caps = await client.capabilities();
    expect(caps.workspaceCwd).toBe(REPO_ROOT);
  });
});

describe('qwen serve — POST /permission/:requestId validation', () => {
  it('400 on empty optionId', async () => {
    const res = await fetch(`${base}/permission/req-1`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        outcome: { outcome: 'selected', optionId: '' },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('400 on missing optionId', async () => {
    const res = await fetch(`${base}/permission/req-1`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ outcome: { outcome: 'selected' } }),
    });
    expect(res.status).toBe(400);
  });

  it('404 when valid vote targets unknown requestId', async () => {
    const res = await fetch(`${base}/permission/never-existed`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        outcome: { outcome: 'selected', optionId: 'allow' },
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe('qwen serve — SSE Content-Type guard (SDK side)', () => {
  it('throws DaemonHttpError when upstream returns 200 + JSON', async () => {
    const ghostFetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const ghost = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch: ghostFetch,
    });
    let threw: unknown = null;
    try {
      const it2 = ghost.subscribeEvents('s-1');
      await it2.next();
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(DaemonHttpError);
    expect((threw as DaemonHttpError).message).toMatch(/text\/event-stream/);
  });
});

describe('qwen serve — Last-Event-ID strict parsing', () => {
  it('malformed Last-Event-ID accepted but ignored', async () => {
    // Spawn a session so /events has somewhere to attach.
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
    });
    const res = await fetch(`${base}/session/${session.sessionId}/events`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'text/event-stream',
        'Last-Event-ID': '1abc',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    await res.body?.cancel();
  });
});

describe('qwen serve — cancel + list', () => {
  it('cancel called twice does not throw', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
    });
    await client.cancel(session.sessionId);
    await client.cancel(session.sessionId);
  });

  it('listWorkspaceSessions returns the live session with metadata', async () => {
    await client.createOrAttachSession({ workspaceCwd: REPO_ROOT });
    const sessions = await client.listWorkspaceSessions(REPO_ROOT);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(
      sessions.every((s: DaemonSessionSummary) => s.workspaceCwd === REPO_ROOT),
    ).toBe(true);
    const first = sessions[0]!;
    expect(first.createdAt).toBeDefined();
    expect(typeof first.createdAt).toBe('string');
    expect(typeof first.clientCount).toBe('number');
    expect(typeof first.hasActivePrompt).toBe('boolean');
  });
});

describe('qwen serve — GET /goals', () => {
  const getGoals = async () => {
    const res = await fetch(`${base}/goals`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return { status: res.status, body: await res.json() };
  };

  it('returns an empty, versioned list when no session has a goal', async () => {
    const { status, body } = await getGoals();
    expect(status).toBe(200);
    expect(body).toEqual({ v: 1, goals: [], droppedCount: 0 });
  });

  it('probes each live session over the bridge without reporting a goal', async () => {
    // The real round trip: serve -> bridge -> `sessionGoalGet` ext method in
    // the `qwen --acp` child -> back. A live session with no `/goal` must come
    // back as "no goal" rather than an error or a phantom entry.
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
      sessionScope: 'thread',
    });
    try {
      const { status, body } = await getGoals();
      expect(status).toBe(200);
      // `droppedCount: 0` is the load-bearing half: it proves the ext-method
      // probe actually reached the child. A dropped probe would also yield an
      // empty `goals`, so that alone cannot tell success from a silent failure.
      expect(body).toEqual({ v: 1, goals: [], droppedCount: 0 });
    } finally {
      await client.closeSession(session.sessionId);
    }
  });

  it('requires the bearer token', async () => {
    const res = await fetch(`${base}/goals`);
    expect(res.status).toBe(401);
  });
});

describe('qwen serve — DELETE /session/:id', () => {
  it('204 on explicit close', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
      sessionScope: 'thread',
    });
    await client.closeSession(session.sessionId);
    const sessions = await client.listWorkspaceSessions(REPO_ROOT);
    expect(
      sessions.some(
        (s: DaemonSessionSummary) => s.sessionId === session.sessionId,
      ),
    ).toBe(false);
  });

  it('204 on double close (idempotent via 404 absorption)', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
      sessionScope: 'thread',
    });
    await client.closeSession(session.sessionId);
    await client.closeSession(session.sessionId);
  });
});

describe('qwen serve — PATCH /session/:id/metadata', () => {
  it('updates displayName', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
      sessionScope: 'thread',
    });
    await client.updateSessionMetadata(session.sessionId, {
      displayName: 'Integration Test Session',
    });
    const sessions = await client.listWorkspaceSessions(REPO_ROOT);
    const updated = sessions.find(
      (s: DaemonSessionSummary) => s.sessionId === session.sessionId,
    );
    expect(updated?.displayName).toBe('Integration Test Session');
    await client.closeSession(session.sessionId);
  });

  it('400 on non-string displayName', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
      sessionScope: 'thread',
    });
    const res = await fetch(`${base}/session/${session.sessionId}/metadata`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ displayName: 42 }),
    });
    expect(res.status).toBe(400);
    await client.closeSession(session.sessionId);
  });
});

describe('qwen serve — POST /session/:id/continue', () => {
  // Real-daemon wiring check for the continuation lifecycle path
  // (route → bridge.continueSession → control method → agent
  // continueLastTurn). Model-free: a fresh session has no interrupted turn,
  // so the pre-check rejects and no continuation turn is dispatched — the
  // happy/reject path that exercises the full HTTP round-trip.
  it('returns accepted:false on a session with no interrupted turn', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
      sessionScope: 'thread',
    });
    const res = await fetch(`${base}/session/${session.sessionId}/continue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accepted: false,
      interruption: 'none',
    });
    await client.closeSession(session.sessionId);
  });
});

describe('qwen serve — prompt clientId admission', () => {
  // Validates the three real-daemon behaviors that DaemonSessionClient's
  // clientId self-heal relies on (see
  // docs/design/2026-06-24-daemon-clientid-self-heal-design.md).
  // Model-free: prompt admission (where invalid_client_id is decided) runs
  // before any model call, so promptNonBlocking returns 202 on acceptance
  // without reaching the (unreachable, fake) model.
  it('rejects an unregistered prompt clientId and re-registers via resume', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
      sessionScope: 'thread',
    });
    const prompt = { prompt: [{ type: 'text', text: 'hi' }] };

    // (1) An unregistered clientId (e.g. one held across a daemon restart) is
    //     rejected at admission with 400 invalid_client_id — the exact signal
    //     the SDK self-heals on.
    const rejected = await client
      .promptNonBlocking(
        session.sessionId,
        prompt,
        undefined,
        'client-never-registered',
      )
      .catch((err: unknown) => err);
    expect(rejected).toBeInstanceOf(DaemonHttpError);
    expect((rejected as DaemonHttpError).status).toBe(400);
    expect((rejected as DaemonHttpError).body).toMatchObject({
      code: 'invalid_client_id',
    });

    // (2) resume re-registers and mints a fresh, valid clientId.
    const reattached = await client.resumeSession(session.sessionId, {
      workspaceCwd: REPO_ROOT,
    });
    expect(reattached.clientId).toBeTypeOf('string');
    expect(reattached.clientId).not.toBe('client-never-registered');

    // (3) Retrying admission with the fresh clientId is accepted (202),
    //     proving reattach + retry recovers the turn end-to-end.
    const accepted = await client.promptNonBlocking(
      session.sessionId,
      prompt,
      undefined,
      reattached.clientId,
    );
    expect(accepted).toMatchObject({ promptId: expect.any(String) });

    // The accepted turn dispatches to the unreachable fake model
    // asynchronously; cancel so nothing lingers past the test.
    await client.cancel(session.sessionId, reattached.clientId).catch(() => {});
    await client.closeSession(session.sessionId);
  });
});
