/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { TestRig } from './test-helper.js';

const REQUEST_TIMEOUT_MS = 20_000;
const INITIAL_PROMPT = 'Create a quick note (smoke test).';
const RESUME_PROMPT = 'Continue the note after reload.';
const LIST_SIZE = 5;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

describe('acp load session', () => {
  it('creates, lists, loads, and resumes a session', async () => {
    const rig = new TestRig();
    rig.setup('acp load session');

    const pending = new Map<number, PendingRequest>();
    let nextRequestId = 1;
    const sessionUpdates: Array<{ sessionId?: string }> = [];
    const stderr: string[] = [];

    const agent = spawn('node', [rig.bundlePath, '--experimental-acp'], {
      cwd: rig.testDir!,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

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
      params?: { sessionId?: string; path?: string; content?: string };
      result?: unknown;
      error?: { message?: string };
    }) => {
      if (
        typeof msg.id !== 'undefined' &&
        ('result' in msg || 'error' in msg)
      ) {
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
        sessionUpdates.push({ sessionId: msg.params?.sessionId });
        return;
      }

      if (
        msg.method === 'session/request_permission' &&
        typeof msg.id === 'number'
      ) {
        sendResponse(msg.id, { outcome: { optionId: 'proceed_once' } });
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

    try {
      const initResult = await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });
      expect(initResult).toBeDefined();

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

      await delay(500);

      const listResult = (await sendRequest('session/list', {
        cwd: rig.testDir!,
        size: LIST_SIZE,
      })) as { items?: Array<{ sessionId: string }> };

      expect(Array.isArray(listResult.items)).toBe(true);
      expect(listResult.items?.length ?? 0).toBeGreaterThan(0);

      const sessionToLoad = listResult.items![0].sessionId;
      await sendRequest('session/load', {
        cwd: rig.testDir!,
        sessionId: sessionToLoad,
        mcpServers: [],
      });

      const resumeResult = await sendRequest('session/prompt', {
        sessionId: sessionToLoad,
        prompt: [{ type: 'text', text: RESUME_PROMPT }],
      });
      expect(resumeResult).toBeDefined();

      const sessionsWithUpdates = sessionUpdates
        .map((update) => update.sessionId)
        .filter(Boolean);
      expect(sessionsWithUpdates).toContain(sessionToLoad);
    } catch (e) {
      if (stderr.length) {
        console.error('Agent stderr:', stderr.join(''));
      }
      throw e;
    } finally {
      await cleanup();
    }
  });
});
