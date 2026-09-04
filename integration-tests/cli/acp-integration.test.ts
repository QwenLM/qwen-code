/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { TestRig } from '../test-helper.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';

const REQUEST_TIMEOUT_MS = 60_000;
const INITIAL_PROMPT = 'Create a quick note (smoke test).';
const IS_SANDBOX =
  process.env['QWEN_SANDBOX'] &&
  process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

type UsageMetadata = {
  inputTokens?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  thoughtsTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
};

type SessionUpdateNotification = {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    availableCommands?: Array<{
      name: string;
      description: string;
      input?: { hint: string } | null;
    }>;
    content?: {
      type: string;
      text?: string;
    };
    modeId?: string;
    currentModeId?: string;
    used?: number;
    size?: number;
    _meta?: {
      usage?: UsageMetadata;
    };
  };
};

type PermissionRequest = {
  id: number;
  sessionId?: string;
  toolCall?: {
    toolCallId: string;
    title: string;
    kind: string;
    status: string;
    content?: Array<{
      type: string;
      text?: string;
      path?: string;
      oldText?: string;
      newText?: string;
    }>;
  };
  options?: Array<{
    optionId: string;
    name: string;
    kind: string;
  }>;
};

type PermissionHandler = (
  request: PermissionRequest,
) => { optionId: string } | { outcome: 'cancelled' };

/**
 * Sets up an ACP test environment with all necessary utilities.
 * @param useNewFlag - If true, uses --acp; if false, uses --experimental-acp (for backward compatibility testing)
 */
function setupAcpTest(
  rig: TestRig,
  options?: {
    permissionHandler?: PermissionHandler;
    useNewFlag?: boolean;
    env?: NodeJS.ProcessEnv;
  },
) {
  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 1;
  const sessionUpdates: SessionUpdateNotification[] = [];
  const permissionRequests: PermissionRequest[] = [];
  const stderr: string[] = [];

  // Default permission handler: auto-approve all
  const permissionHandler =
    options?.permissionHandler ?? (() => ({ optionId: 'proceed_once' }));

  // Use --acp by default, but allow testing with --experimental-acp for backward compatibility
  const acpFlag =
    options?.useNewFlag !== false ? '--acp' : '--experimental-acp';

  // Isolate this agent's GLOBAL (User-scope) qwen config dir via QWEN_HOME.
  // `globalSetup` does not sandbox HOME, so every integration test shares the
  // real `$HOME/.qwen`, and `vitest.config.ts` runs test files with
  // `fileParallelism: true` (up to 4 at once). The ACP `authenticate` /
  // `setModel` handlers persist `security.auth.selectedType` (and `model.name`)
  // to User scope, so a concurrent test (e.g. `system-control`'s
  // `setModel('qwen3-...')`) can clobber the persisted auth type in the window
  // between this agent's `authenticate({ methodId: 'openai' })` and its
  // `session/new`. When that happens the new session config resolves a
  // non-openai auth, the openai runtime model is never captured, and it drops
  // out of `availableModels` — flaking `expect(openaiModel).toBeDefined()` in
  // the `set_config_option` test (acp-integration.test.ts:516). A per-agent
  // QWEN_HOME redirects `getGlobalQwenDir()` so the authenticate -> session/new
  // round-trip reads back exactly what this agent wrote.
  const qwenHome = join(rig.testDir!, '.qwen-home');
  mkdirSync(qwenHome, { recursive: true });

  const agent = spawn(
    'node',
    [rig.bundlePath, acpFlag, '--no-chat-recording'],
    {
      cwd: rig.testDir!,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options?.env, QWEN_HOME: qwenHome },
    },
  );

  agent.stderr?.on('data', (chunk) => {
    stderr.push(chunk.toString());
  });

  const rl = createInterface({ input: agent.stdout });

  const send = (json: unknown) => {
    agent.stdin.write(`${JSON.stringify(json)}\n`);
  };

  const sendResponse = (id: number, result: unknown) => {
    send({ jsonrpc: '2.0', id, result });
  };

  const sendRequest = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextRequestId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Request ${id} (${method}) timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timeout });
      send({ jsonrpc: '2.0', id, method, params });
    });

  const handleResponse = (msg: {
    id: number;
    result?: unknown;
    error?: { message?: string };
  }) => {
    const waiter = pending.get(msg.id);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timeout);
    pending.delete(msg.id);
    if (msg.error) {
      const error = new Error(msg.error.message ?? 'Unknown error');
      (error as Error & { response?: unknown }).response = msg.error;
      waiter.reject(error);
    } else {
      waiter.resolve(msg.result);
    }
  };

  const handleMessage = (msg: {
    id?: number;
    method?: string;
    params?: SessionUpdateNotification & {
      path?: string;
      content?: string;
      sessionId?: string;
      toolCall?: PermissionRequest['toolCall'];
      options?: PermissionRequest['options'];
    };
    result?: unknown;
    error?: { message?: string };
  }) => {
    if (typeof msg.id !== 'undefined' && ('result' in msg || 'error' in msg)) {
      handleResponse(
        msg as {
          id: number;
          result?: unknown;
          error?: { message?: string };
        },
      );
      return;
    }

    if (msg.method === 'session/update') {
      sessionUpdates.push({
        sessionId: msg.params?.sessionId,
        update: msg.params?.update,
      });
      return;
    }

    if (
      msg.method === 'session/request_permission' &&
      typeof msg.id === 'number'
    ) {
      // Track permission request
      const permRequest: PermissionRequest = {
        id: msg.id,
        sessionId: msg.params?.sessionId,
        toolCall: msg.params?.toolCall,
        options: msg.params?.options,
      };
      permissionRequests.push(permRequest);

      // Use custom handler or default
      const response = permissionHandler(permRequest);
      if ('outcome' in response) {
        sendResponse(msg.id, { outcome: response });
      } else {
        sendResponse(msg.id, {
          outcome: { optionId: response.optionId, outcome: 'selected' },
        });
      }
      return;
    }

    if (msg.method === 'fs/read_text_file' && typeof msg.id === 'number') {
      try {
        const content = readFileSync(msg.params?.path ?? '', 'utf8');
        sendResponse(msg.id, { content });
      } catch (e) {
        sendResponse(msg.id, { content: `ERROR: ${(e as Error).message}` });
      }
      return;
    }

    if (msg.method === 'fs/write_text_file' && typeof msg.id === 'number') {
      try {
        writeFileSync(
          msg.params?.path ?? '',
          msg.params?.content ?? '',
          'utf8',
        );
        sendResponse(msg.id, null);
      } catch (e) {
        sendResponse(msg.id, { message: (e as Error).message });
      }
      return;
    }

    // JSON-RPC requires every request to get a response. Reject unknown
    // agent->client requests (e.g. optional extension methods like
    // craft/drainMidTurnQueue) with -32601 so the agent fails fast instead
    // of awaiting a reply that never comes.
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      });
    }
  };

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch {
      // Ignore non-JSON output from the agent.
    }
  });

  const waitForExit = () =>
    new Promise<void>((resolve) => {
      if (agent.exitCode !== null || agent.signalCode) {
        resolve();
        return;
      }
      agent.once('exit', () => resolve());
    });

  const cleanup = async () => {
    rl.close();
    agent.kill();
    pending.forEach(({ timeout }) => clearTimeout(timeout));
    pending.clear();
    await waitForExit();
  };

  return {
    sendRequest,
    sendResponse,
    cleanup,
    stderr,
    sessionUpdates,
    permissionRequests,
    agent,
  };
}

(IS_SANDBOX ? describe.skip : describe)('acp integration', () => {
  it('basic smoke test', async () => {
    const rig = new TestRig();
    await rig.setup('acp load session');

    const { sendRequest, cleanup, stderr } = setupAcpTest(rig);

    try {
      const initResult = await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });
      expect(initResult).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((initResult as any).agentInfo.version).toBeDefined();

      await sendRequest('authenticate', { methodId: 'openai' });

      const newSession = (await sendRequest('session/new', {
        cwd: rig.testDir!,
        mcpServers: [],
      })) as { sessionId: string };
      expect(newSession.sessionId).toBeTruthy();

      const promptResult = await sendRequest('session/prompt', {
        sessionId: newSession.sessionId,
        prompt: [{ type: 'text', text: INITIAL_PROMPT }],
      });
      expect(promptResult).toBeDefined();
    } catch (e) {
      if (stderr.length) {
        console.error('Agent stderr:', stderr.join(''));
      }
      throw e;
    } finally {
      await cleanup();
    }
  });

  it('initializes and allows setting mode', async () => {
    const rig = new TestRig();
    await rig.setup('acp mode and model');

    const { sendRequest, cleanup, stderr } = setupAcpTest(rig);

    try {
      // Test 1: Initialize and verify modes are returned
      const initResult = (await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      })) as { protocolVersion: number };

      expect(initResult).toBeDefined();
      expect(initResult.protocolVersion).toBe(1);

      // Test 2: Authenticate
      await sendRequest('authenticate', { methodId: 'openai' });

      // Test 3: Create a new session
      const newSession = (await sendRequest('session/new', {
        cwd: rig.testDir!,
        mcpServers: [],
      })) as {
        sessionId: string;
        models: {
          availableModels: Array<{ modelId: string }>;
        };
      };
      expect(newSession.sessionId).toBeTruthy();
      expect(newSession.models.availableModels.length).toBeGreaterThan(0);

      // Test 4: Set approval mode to 'yolo'
      const setModeResult = (await sendRequest('session/set_mode', {
        sessionId: newSession.sessionId,
        modeId: 'yolo',
      })) as unknown;
      expect(setModeResult).toEqual({});

      // Test 5: Set approval mode to 'auto-edit'
      const setModeResult2 = (await sendRequest('session/set_mode', {
        sessionId: newSession.sessionId,
        modeId: 'auto-edit',
      })) as unknown;
      expect(setModeResult2).toEqual({});

      // Test 6: Set approval mode back to 'default'
      const setModeResult3 = (await sendRequest('session/set_mode', {
        sessionId: newSession.sessionId,
        modeId: 'default',
      })) as unknown;
      expect(setModeResult3).toEqual({});
    } catch (e) {
      if (stderr.length) {
        console.error('Agent stderr:', stderr.join(''));
      }
      throw e;
    } finally {
      await cleanup();
    }
  });

  it('returns internal error details when model auth is required', async () => {
    const rig = new TestRig();
    await rig.setup('acp auth methods in error data', {
      settings: {
        modelProviders: {
          openai: [
            {
              id: 'e2e-authenticated-model',
              name: 'E2E Authenticated Model',
              baseUrl: 'http://127.0.0.1:9/v1',
              envKey: 'E2E_OPENAI_API_KEY',
            },
          ],
        },
        env: { E2E_OPENAI_API_KEY: 'test-key' },
        security: { auth: { selectedType: 'openai' } },
        model: {
          name: 'e2e-authenticated-model',
          baseUrl: 'http://127.0.0.1:9/v1',
        },
      },
    });

    const { sendRequest, cleanup, stderr } = setupAcpTest(rig);

    try {
      await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      // Create a new session first
      const newSession = (await sendRequest('session/new', {
        cwd: rig.testDir!,
        mcpServers: [],
      })) as {
        sessionId: string;
      };

      // Request the discontinued route directly: non-OAuth sessions no longer
      // advertise it, but the auth error path must still stay structured.
      await expect(
        sendRequest('session/set_config_option', {
          sessionId: newSession.sessionId,
          configId: 'model',
          value: 'coder-model(qwen-oauth)',
        }),
      ).rejects.toMatchObject({
        response: {
          code: -32603,
          message: 'Internal error',
          data: {
            details: expect.any(String),
          },
        },
      });
    } catch (e) {
      if (stderr.length) {
        console.error('Agent stderr:', stderr.join(''));
      }
      throw e;
    } finally {
      await cleanup();
    }
  });

  it('supports session/set_config_option for mode, model, and reasoning effort', async () => {
    const rig = new TestRig();
    // Inject a deterministic openai provider model so `availableModels` always
    // contains a settable openai entry. The previous version relied on the
    // env-driven OPENAI_MODEL being captured as a runtime-model snapshot and
    // enumerated, which is environment-sensitive and flaked in CI (the openai
    // model could be absent from `availableModels`, failing the assertion
    // below). A registry model configured via `modelProviders` is always
    // enumerated and switchable without inference, making this test
    // deterministic regardless of how the ambient openai credentials resolve.
    await rig.setup('acp set config option', {
      settings: {
        modelProviders: {
          openai: [
            {
              id: 'e2e-set-config-option-model',
              name: 'E2E Set Config Option Model',
              baseUrl: 'https://api.openai.com/v1',
              envKey: 'OPENAI_API_KEY',
            },
          ],
        },
      },
    });

    const { sendRequest, cleanup, stderr } = setupAcpTest(rig, {
      env: { OPENAI_MODEL: 'qwen3-coder-plus' },
    });

    try {
      // Initialize
      await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      await sendRequest('authenticate', { methodId: 'openai' });

      // Create a new session
      const newSession = (await sendRequest('session/new', {
        cwd: rig.testDir!,
        mcpServers: [],
      })) as {
        sessionId: string;
        models: {
          availableModels: Array<{ modelId: string }>;
        };
        configOptions: Array<{
          id: string;
          category?: string;
          currentValue: string;
          options: Array<{ value: string; name: string }>;
        }>;
      };
      expect(newSession.sessionId).toBeTruthy();

      const initialReasoningOption = newSession.configOptions.find(
        (opt) => opt.id === 'reasoning_effort',
      );
      expect(initialReasoningOption).toBeUndefined();

      // Test: Set mode using set_config_option
      const setModeResult = (await sendRequest('session/set_config_option', {
        sessionId: newSession.sessionId,
        configId: 'mode',
        value: 'yolo',
      })) as {
        configOptions: Array<{
          id: string;
          currentValue: string;
          options: Array<{ value: string; name: string; description: string }>;
        }>;
      };

      expect(setModeResult).toBeDefined();
      expect(Array.isArray(setModeResult.configOptions)).toBe(true);
      expect(setModeResult.configOptions.length).toBeGreaterThanOrEqual(2);

      // Find mode option
      const modeOption = setModeResult.configOptions.find(
        (opt) => opt.id === 'mode',
      );
      expect(modeOption).toBeDefined();
      expect(modeOption!.currentValue).toBe('yolo');
      expect(Array.isArray(modeOption!.options)).toBe(true);
      expect(modeOption!.options.some((o) => o.value === 'yolo')).toBe(true);

      // Find model option
      const modelOption = setModeResult.configOptions.find(
        (opt) => opt.id === 'model',
      );
      expect(modelOption).toBeDefined();
      expect(modelOption!.currentValue).toBeTruthy();

      // Test: Set model using set_config_option
      // Target the deterministic openai provider model injected via settings
      // above (avoids auth issues and is always present in `availableModels`).
      const openaiModel = newSession.models.availableModels.find((model) =>
        model.modelId.includes('e2e-set-config-option-model'),
      );
      expect(openaiModel).toBeDefined();

      const setModelResult = (await sendRequest('session/set_config_option', {
        sessionId: newSession.sessionId,
        configId: 'model',
        value: openaiModel!.modelId,
      })) as {
        configOptions: Array<{
          id: string;
          currentValue: string;
          options: Array<{ value: string; name: string; description: string }>;
        }>;
      };

      expect(setModelResult).toBeDefined();
      expect(Array.isArray(setModelResult.configOptions)).toBe(true);

      // Verify model was updated
      const updatedModelOption = setModelResult.configOptions.find(
        (opt) => opt.id === 'model',
      );
      expect(updatedModelOption).toBeDefined();
      expect(updatedModelOption!.currentValue).toBe(openaiModel!.modelId);
      const reasoningOption = setModelResult.configOptions.find(
        (opt) => opt.id === 'reasoning_effort',
      );
      expect(reasoningOption).toMatchObject({
        category: 'thought_level',
        currentValue: 'default',
      });
      expect(reasoningOption?.options.map((option) => option.value)).toEqual([
        'none',
        'default',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);

      const setReasoningResult = (await sendRequest(
        'session/set_config_option',
        {
          sessionId: newSession.sessionId,
          configId: 'reasoning_effort',
          value: 'xhigh',
        },
      )) as {
        configOptions: Array<{ id: string; currentValue: string }>;
      };
      expect(
        setReasoningResult.configOptions.find(
          (opt) => opt.id === 'reasoning_effort',
        )?.currentValue,
      ).toBe('xhigh');

      const resetReasoningResult = (await sendRequest(
        'session/set_config_option',
        {
          sessionId: newSession.sessionId,
          configId: 'reasoning_effort',
          value: 'default',
        },
      )) as {
        configOptions: Array<{ id: string; currentValue: string }>;
      };
      expect(
        resetReasoningResult.configOptions.find(
          (opt) => opt.id === 'reasoning_effort',
        )?.currentValue,
      ).toBe('default');

      await expect(
        sendRequest('session/set_config_option', {
          sessionId: newSession.sessionId,
          configId: 'reasoning_effort',
          value: 'ultra',
        }),
      ).rejects.toMatchObject({
        response: {
          code: -32602,
          message:
            'Invalid params: Unknown reasoning effort: ultra. Choose one of: default, none, low, medium, high, xhigh, max',
        },
      });
    } catch (e) {
      if (stderr.length) {
        console.error('Agent stderr:', stderr.join(''));
      }
      throw e;
    } finally {
      await cleanup();
    }
  });

  it('returns error for invalid configId in set_config_option', async () => {
    const rig = new TestRig();
    await rig.setup('acp set config option error');

    const { sendRequest, cleanup, stderr } = setupAcpTest(rig);

    try {
      // Initialize
      await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      await sendRequest('authenticate', { methodId: 'openai' });

      // Create a new session
      const newSession = (await sendRequest('session/new', {
        cwd: rig.testDir!,
        mcpServers: [],
      })) as { sessionId: string };
      expect(newSession.sessionId).toBeTruthy();

      // Test: Invalid configId should return error
      await expect(
        sendRequest('session/set_config_option', {
          sessionId: newSession.sessionId,
          configId: 'invalid_config',
          value: 'some_value',
        }),
      ).rejects.toMatchObject({
        response: {
          code: -32602,
          message: 'Invalid params: Unsupported configId: invalid_config',
        },
      });
    } catch (e) {
      if (stderr.length) {
        console.error('Agent stderr:', stderr.join(''));
      }
      throw e;
    } finally {
      await cleanup();
    }
  });

  it('receives available_commands_update with slash commands after session creation', async () => {
    const rig = new TestRig();
    await rig.setup('acp slash commands');

    const { sendRequest, cleanup, stderr, sessionUpdates } = setupAcpTest(rig);

    try {
      // Initialize
      await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      await sendRequest('authenticate', { methodId: 'openai' });

      // Create a new session
      const newSession = (await sendRequest('session/new', {
        cwd: rig.testDir!,
        mcpServers: [],
      })) as { sessionId: string };
      expect(newSession.sessionId).toBeTruthy();

      await rig.poll(
        () =>
          sessionUpdates.some(
            (update) =>
              update.update?.sessionUpdate === 'available_commands_update',
          ),
        5000,
        100,
      );

      // Verify available_commands_update is received
      const commandsUpdate = sessionUpdates.find(
        (update) =>
          update.update?.sessionUpdate === 'available_commands_update',
      );

      expect(commandsUpdate).toBeDefined();
      expect(commandsUpdate?.update?.availableCommands).toBeDefined();
      expect(Array.isArray(commandsUpdate?.update?.availableCommands)).toBe(
        true,
      );

      // Verify that the 'init' command is present (the only allowed built-in command for ACP)
      const initCommand = commandsUpdate?.update?.availableCommands?.find(
        (cmd) => cmd.name === 'init',
      );
      expect(initCommand).toBeDefined();
      expect(initCommand?.description).toBeTruthy();

      // Note: We don't test /init execution here because it triggers a complex
      // multi-step process (listing files, reading up to 10 files, generating QWEN.md)
      // that can take 30-60+ seconds, exceeding the request timeout.
      // The slash command execution path is tested via simpler prompts in other tests.
    } catch (e) {
      if (stderr.length) {
        console.error('Agent stderr:', stderr.join(''));
      }
      throw e;
    } finally {
      await cleanup();
    }
  });

  it('handles exit plan mode with permission request and mode update notification', async () => {
    const rig = new TestRig();
    await rig.setup('acp exit plan mode');

    // Track which permission requests we've seen
    const planModeRequests: PermissionRequest[] = [];

    const {
      sendRequest,
      cleanup,
      stderr,
      sessionUpdates,
      permissionRequests,
      agent,
    } = setupAcpTest(rig, {
      permissionHandler: (request) => {
        // Track all permission requests for later verification
        // Auto-approve exit plan mode requests with "proceed_always" to trigger auto-edit mode
        if (request.toolCall?.kind === 'switch_mode') {
          planModeRequests.push(request);
          // Return proceed_always to switch to auto-edit mode
          return { optionId: 'proceed_always' };
        }
        // Auto-approve all other requests
        return { optionId: 'proceed_once' };
      },
    });

    try {
      // Initialize
      await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      await sendRequest('authenticate', { methodId: 'openai' });

      // Create a new session
      const newSession = (await sendRequest('session/new', {
        cwd: rig.testDir!,
        mcpServers: [],
      })) as { sessionId: string };
      expect(newSession.sessionId).toBeTruthy();

      // Set mode to 'plan' to enable plan mode
      const setModeResult = (await sendRequest('session/set_mode', {
        sessionId: newSession.sessionId,
        modeId: 'plan',
      })) as unknown;
      expect(setModeResult).toEqual({});

      // Send a prompt that should trigger the LLM to call exit_plan_mode.
      // The prompt is designed to trigger planning behavior, but LLM
      // behavior is non-deterministic — it may take too long or never call
      // exit_plan_mode. Catch timeouts so the test can still verify any
      // notifications that were received.
      try {
        const promptResult = await sendRequest('session/prompt', {
          sessionId: newSession.sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Create a simple hello world function in Python. Make a brief plan and when ready, use the exit_plan_mode tool to present it for approval.',
            },
          ],
        });
        expect(promptResult).toBeDefined();
      } catch (e) {
        // Only the harness's own 60s request timeout is acceptable — LLM
        // behavior is non-deterministic. JSON-RPC errors (errors with a
        // `response` property) indicate a real problem and must be surfaced.
        if (
          !(e instanceof Error) ||
          'response' in e ||
          !/^Request \d+ \(session\/prompt\) timed out$/.test(e.message)
        ) {
          throw e;
        }
        // A dead agent also manifests as a timeout. Surface the crash instead
        // of swallowing it as an acceptable slow-LLM path.
        if (agent.exitCode !== null || agent.signalCode !== null) {
          throw e;
        }
        console.error(
          'session/prompt did not complete (continuing with partial verification):',
          e,
        );
      }

      // Poll for mode_update notification after switch_mode, bounded at 5 s.
      // A fixed delay races the slow-LLM path: switch_mode can arrive just
      // after the timeout, and mode_update may land after the wait window.
      await rig.poll(
        () => {
          const hasSwitchMode = permissionRequests.some(
            (req) => req.toolCall?.kind === 'switch_mode',
          );
          if (!hasSwitchMode) return false;
          return sessionUpdates.some(
            (update) => update.update?.sessionUpdate === 'current_mode_update',
          );
        },
        5000,
        250,
      );

      // Verify: If exit_plan_mode was called, we should have received:
      // 1. A permission request with kind: "switch_mode"
      // 2. A current_mode_update notification after approval

      // Check for switch_mode permission requests
      const switchModeRequests = permissionRequests.filter(
        (req) => req.toolCall?.kind === 'switch_mode',
      );

      // Check for current_mode_update notifications
      const modeUpdateNotifications = sessionUpdates.filter(
        (update) => update.update?.sessionUpdate === 'current_mode_update',
      );

      // If the LLM called exit_plan_mode, verify the flow
      if (switchModeRequests.length > 0) {
        // Verify permission request structure
        const permReq = switchModeRequests[0];
        expect(permReq.toolCall).toBeDefined();
        expect(permReq.toolCall?.kind).toBe('switch_mode');
        expect(permReq.toolCall?.status).toBe('pending');
        expect(permReq.options).toBeDefined();
        expect(Array.isArray(permReq.options)).toBe(true);

        // Verify options include appropriate choices
        const optionKinds = permReq.options?.map((opt) => opt.kind) ?? [];
        expect(optionKinds).toContain('allow_once');
        expect(optionKinds).toContain('allow_always');

        // After approval, should have received current_mode_update
        expect(modeUpdateNotifications.length).toBeGreaterThan(0);

        // Verify mode update structure
        const modeUpdate = modeUpdateNotifications[0];
        expect(modeUpdate.sessionId).toBe(newSession.sessionId);
        expect(modeUpdate.update?.currentModeId).toBeDefined();
        // Mode should be auto-edit since we approved with proceed_always
        expect(modeUpdate.update?.currentModeId).toBe('auto-edit');
      }

      // Note: If the LLM didn't call exit_plan_mode, that's acceptable
      // since LLM behavior is non-deterministic. The test setup and structure
      // is verified regardless.
    } catch (e) {
      if (stderr.length) {
        console.error('Agent stderr:', stderr.join(''));
      }
      throw e;
    } finally {
      await cleanup();
    }
  });

  it('blocks write tools in plan mode (issue #1806)', async () => {
    const rig = new TestRig();
    await rig.setup('acp plan mode enforcement');

    const toolCallEvents: Array<{
      toolName: string;
      status: string;
      error?: string;
    }> = [];

    const { sendRequest, cleanup, stderr, sessionUpdates } = setupAcpTest(rig, {
      permissionHandler: (request) => {
        // Cancel exit_plan_mode to keep plan mode active
        if (request.toolCall?.kind === 'switch_mode') {
          return { outcome: 'cancelled' };
        }
        return { optionId: 'proceed_once' };
      },
    });

    try {
      await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      await sendRequest('authenticate', { methodId: 'openai' });

      const newSession = (await sendRequest('session/new', {
        cwd: rig.testDir!,
        mcpServers: [],
      })) as { sessionId: string };

      // Set mode to 'plan'
      const setModeResult = (await sendRequest('session/set_mode', {
        sessionId: newSession.sessionId,
        modeId: 'plan',
      })) as unknown;
      expect(setModeResult).toEqual({});

      // Try to create a file - this should be blocked by plan mode
      const promptResult = await sendRequest('session/prompt', {
        sessionId: newSession.sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Create a file called test.txt with content "Hello World"',
          },
        ],
      });
      expect(promptResult).toBeDefined();

      // Give time for tool calls to be processed
      await delay(2000);

      // Collect tool call events from session updates
      sessionUpdates.forEach((update) => {
        if (update.update?.sessionUpdate === 'tool_call_update') {
          const toolUpdate = update.update as {
            sessionUpdate: string;
            toolName?: string;
            status?: string;
            error?: { message?: string };
          };
          if (toolUpdate.toolName) {
            toolCallEvents.push({
              toolName: toolUpdate.toolName,
              status: toolUpdate.status ?? 'unknown',
              error: toolUpdate.error?.message,
            });
          }
        }
      });

      // Verify that if write_file was attempted, it was blocked
      const writeFileEvents = toolCallEvents.filter(
        (e) => e.toolName === 'write_file',
      );

      // If the LLM tried to call write_file in plan mode, it should have been blocked
      if (writeFileEvents.length > 0) {
        const blockedEvent = writeFileEvents.find(
          (e) => e.status === 'error' && e.error?.includes('Plan mode'),
        );
        expect(blockedEvent).toBeDefined();
        expect(blockedEvent?.error).toContain('Plan mode is active');
      }

      // Verify the file was NOT created
      const fs = await import('fs');
      const path = await import('path');
      const testFilePath = path.join(rig.testDir!, 'test.txt');
      const fileExists = fs.existsSync(testFilePath);
      expect(fileExists).toBe(false);
    } catch (e) {
      if (stderr.length) console.error('Agent stderr:', stderr.join(''));
      throw e;
    } finally {
      await cleanup();
    }
  });

  it('receives private usage metadata and standard ACP usage updates', async () => {
    const fakeServer = await startFakeOpenAIServer(() => ({
      content: 'hello',
      usage: {
        prompt_tokens: 321,
        completion_tokens: 1,
        total_tokens: 322,
      },
    }));
    const rig = new TestRig();
    await rig.setup('acp usage metadata', {
      settings: {
        model: {
          generationConfig: { contextWindowSize: 128_000 },
        },
      },
    });

    const { sendRequest, cleanup, stderr, sessionUpdates } = setupAcpTest(rig, {
      env: {
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: fakeServer.baseUrl,
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
    });

    try {
      await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      await sendRequest('authenticate', { methodId: 'openai' });

      const newSession = (await sendRequest('session/new', {
        cwd: rig.testDir!,
        mcpServers: [],
      })) as { sessionId: string };

      await sendRequest('session/prompt', {
        sessionId: newSession.sessionId,
        prompt: [{ type: 'text', text: 'Say "hello".' }],
      });

      await delay(500);

      // Find updates with usage metadata
      const updatesWithUsage = sessionUpdates.filter(
        (u) =>
          u.update?.sessionUpdate === 'agent_message_chunk' &&
          u.update?._meta?.usage,
      );

      expect(updatesWithUsage.length).toBeGreaterThan(0);

      const usage = updatesWithUsage[0].update?._meta?.usage;
      expect(usage).toBeDefined();
      expect(
        typeof usage?.inputTokens === 'number' ||
          typeof usage?.promptTokens === 'number' ||
          typeof usage?.totalTokens === 'number',
      ).toBe(true);

      const standardUsageUpdates = sessionUpdates.filter(
        (u) => u.update?.sessionUpdate === 'usage_update',
      );
      expect(standardUsageUpdates.length).toBeGreaterThan(0);

      const standardUsage = standardUsageUpdates.at(-1)?.update;
      expect(standardUsage).toMatchObject({ used: 321, size: 128_000 });

      const privateInputTokens = usage?.inputTokens ?? usage?.promptTokens;
      if (typeof privateInputTokens === 'number') {
        expect(standardUsage?.used).toBe(privateInputTokens);
      }
    } catch (e) {
      if (stderr.length) console.error('Agent stderr:', stderr.join(''));
      throw e;
    } finally {
      await cleanup();
      await fakeServer.close();
    }
  });
});

(IS_SANDBOX ? describe.skip : describe)(
  'acp flag backward compatibility',
  () => {
    it('should work with deprecated --experimental-acp flag and show warning', async () => {
      const rig = new TestRig();
      await rig.setup('acp backward compatibility');

      const { sendRequest, cleanup, stderr } = setupAcpTest(rig, {
        useNewFlag: false,
      });

      try {
        const initResult = await sendRequest('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        });
        expect(initResult).toBeDefined();

        // Verify deprecation warning is shown
        const stderrOutput = stderr.join('');
        expect(stderrOutput).toContain('--experimental-acp is deprecated');
        expect(stderrOutput).toContain('Please use --acp instead');

        await sendRequest('authenticate', { methodId: 'openai' });

        const newSession = (await sendRequest('session/new', {
          cwd: rig.testDir!,
          mcpServers: [],
        })) as { sessionId: string };
        expect(newSession.sessionId).toBeTruthy();

        // Verify functionality still works
        const promptResult = await sendRequest('session/prompt', {
          sessionId: newSession.sessionId,
          prompt: [{ type: 'text', text: 'Say hello.' }],
        });
        expect(promptResult).toBeDefined();
      } catch (e) {
        if (stderr.length) {
          console.error('Agent stderr:', stderr.join(''));
        }
        throw e;
      } finally {
        await cleanup();
      }
    });

    it('should work with new --acp flag without warnings', async () => {
      const rig = new TestRig();
      await rig.setup('acp new flag');

      const { sendRequest, cleanup, stderr } = setupAcpTest(rig, {
        useNewFlag: true,
      });

      try {
        const initResult = await sendRequest('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        });
        expect(initResult).toBeDefined();

        // Verify no deprecation warning is shown
        const stderrOutput = stderr.join('');
        expect(stderrOutput).not.toContain('--experimental-acp is deprecated');

        await sendRequest('authenticate', { methodId: 'openai' });

        const newSession = (await sendRequest('session/new', {
          cwd: rig.testDir!,
          mcpServers: [],
        })) as { sessionId: string };
        expect(newSession.sessionId).toBeTruthy();

        // Verify functionality works
        const promptResult = await sendRequest('session/prompt', {
          sessionId: newSession.sessionId,
          prompt: [{ type: 'text', text: 'Say hello.' }],
        });
        expect(promptResult).toBeDefined();
      } catch (e) {
        if (stderr.length) {
          console.error('Agent stderr:', stderr.join(''));
        }
        throw e;
      } finally {
        await cleanup();
      }
    });
  },
);
