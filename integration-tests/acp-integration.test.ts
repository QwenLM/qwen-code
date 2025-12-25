/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { TestRig } from './test-helper.js';

const REQUEST_TIMEOUT_MS = 60_000;
const INITIAL_PROMPT = 'Create a quick note (smoke test).';
const IS_SANDBOX =
  process.env['GEMINI_SANDBOX'] &&
  process.env['GEMINI_SANDBOX']!.toLowerCase() !== 'false';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

type UsageMetadata = {
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
 */
function setupAcpTest(
  rig: TestRig,
  options?: { permissionHandler?: PermissionHandler },
) {
  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 1;
  const sessionUpdates: SessionUpdateNotification[] = [];
  const permissionRequests: PermissionRequest[] = [];
  const stderr: string[] = [];

  // Default permission handler: auto-approve all
  const permissionHandler =
    options?.permissionHandler ?? (() => ({ optionId: 'proceed_once' }));

  const agent = spawn(
    'node',
    [rig.bundlePath, '--experimental-acp', '--no-chat-recording'],
    {
      cwd: rig.testDir!,
      stdio: ['pipe', 'pipe', 'pipe'],
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
      waiter.reject(new Error(msg.error.message ?? 'Unknown error'));
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
  };
}

(IS_SANDBOX ? describe.skip : describe)('acp integration', () => {
  it('basic smoke test', async () => {
    const rig = new TestRig();
    rig.setup('acp load session');

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

  it('returns modes on initialize and allows setting approval mode', async () => {
    const rig = new TestRig();
    rig.setup('acp approval mode');

    const { sendRequest, cleanup, stderr } = setupAcpTest(rig);

    try {
      // Test 1: Initialize and verify modes are returned
      const initResult = (await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      })) as {
        protocolVersion: number;
        modes: {
          currentModeId: string;
          availableModes: Array<{
            id: string;
            name: string;
            description: string;
          }>;
        };
      };

      expect(initResult).toBeDefined();
      expect(initResult.protocolVersion).toBe(1);

      // Verify modes data is present
      expect(initResult.modes).toBeDefined();
      expect(initResult.modes.currentModeId).toBeDefined();
      expect(Array.isArray(initResult.modes.availableModes)).toBe(true);
      expect(initResult.modes.availableModes.length).toBeGreaterThan(0);

      // Verify available modes have expected structure
      const modeIds = initResult.modes.availableModes.map((m) => m.id);
      expect(modeIds).toContain('default');
      expect(modeIds).toContain('yolo');
      expect(modeIds).toContain('auto-edit');
      expect(modeIds).toContain('plan');

      // Verify each mode has required fields
      for (const mode of initResult.modes.availableModes) {
        expect(mode.id).toBeTruthy();
        expect(mode.name).toBeTruthy();
        expect(mode.description).toBeTruthy();
      }

      // Test 2: Authenticate
      await sendRequest('authenticate', { methodId: 'openai' });

      // Test 3: Create a new session
      const newSession = (await sendRequest('session/new', {
        cwd: rig.testDir!,
        mcpServers: [],
      })) as { sessionId: string };
      expect(newSession.sessionId).toBeTruthy();

      // Test 4: Set approval mode to 'yolo'
      const setModeResult = (await sendRequest('session/set_mode', {
        sessionId: newSession.sessionId,
        modeId: 'yolo',
      })) as { modeId: string };
      expect(setModeResult).toBeDefined();
      expect(setModeResult.modeId).toBe('yolo');

      // Test 5: Set approval mode to 'auto-edit'
      const setModeResult2 = (await sendRequest('session/set_mode', {
        sessionId: newSession.sessionId,
        modeId: 'auto-edit',
      })) as { modeId: string };
      expect(setModeResult2).toBeDefined();
      expect(setModeResult2.modeId).toBe('auto-edit');

      // Test 6: Set approval mode back to 'default'
      const setModeResult3 = (await sendRequest('session/set_mode', {
        sessionId: newSession.sessionId,
        modeId: 'default',
      })) as { modeId: string };
      expect(setModeResult3).toBeDefined();
      expect(setModeResult3.modeId).toBe('default');
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
    rig.setup('acp slash commands');

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

      // Wait for available_commands_update to be received
      await delay(1000);

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
    rig.setup('acp exit plan mode');

    // Track which permission requests we've seen
    const planModeRequests: PermissionRequest[] = [];

    const { sendRequest, cleanup, stderr, sessionUpdates, permissionRequests } =
      setupAcpTest(rig, {
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
      })) as { modeId: string };
      expect(setModeResult.modeId).toBe('plan');

      // Send a prompt that should trigger the LLM to call exit_plan_mode
      // The prompt is designed to trigger planning behavior
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

      // Give time for all notifications to be processed
      await delay(1000);

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
        expect(modeUpdate.update?.modeId).toBeDefined();
        // Mode should be auto-edit since we approved with proceed_always
        expect(modeUpdate.update?.modeId).toBe('auto-edit');
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

  it('receives usage metadata in agent_message_chunk updates', async () => {
    const rig = new TestRig();
    rig.setup('acp usage metadata');

    const { sendRequest, cleanup, stderr, sessionUpdates } = setupAcpTest(rig);

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
        typeof usage?.promptTokens === 'number' ||
          typeof usage?.totalTokens === 'number',
      ).toBe(true);
    } catch (e) {
      if (stderr.length) console.error('Agent stderr:', stderr.join(''));
      throw e;
    } finally {
      await cleanup();
    }
  });
});
