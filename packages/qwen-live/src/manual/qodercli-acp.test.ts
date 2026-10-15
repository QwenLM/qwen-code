/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MANUAL smoke test: drives the real qodercli binary (`qodercli --acp`,
 * hidden flag) through the AcpAdaptor. NOT part of CI — qodercli must be
 * installed and logged in on the machine, and it talks to Qoder's real
 * model backend. Run explicitly:
 *
 *   npx vitest run src/manual/qodercli-acp.test.ts
 *
 * Mirrors the README's manual ACP-agent checklist.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { AcpAdaptor } from '../adaptor/acp-adaptor.js';
import type { BackendEvent } from '../adaptor/types.js';
import type { LiveLogger } from '../logger.js';

const QODERCLI = process.env['QODERCLI_BIN'] ?? 'qodercli';

const available = spawnSync(QODERCLI, ['--version'], { encoding: 'utf8' });
const skip = available.status !== 0;
const describeManual = skip ? describe.skip : describe;

const logger: LiveLogger = {
  info: () => {},
  warn: () => {},
  error: (msg: string) => console.error('[qodercli-acp]', msg),
} as unknown as LiveLogger;

describeManual('AcpAdaptor against real qodercli --acp', () => {
  let adaptor: AcpAdaptor;
  const adaptors: AcpAdaptor[] = [];

  beforeAll(() => {
    adaptor = new AcpAdaptor({
      name: 'qodercli',
      command: QODERCLI,
      args: ['--acp'],
      defaultCwd: '/tmp',
      logger,
    });
    adaptors.push(adaptor);
  });

  afterAll(async () => {
    for (const a of adaptors.splice(0)) await a.close();
  });

  function collector(sessionId: string) {
    const events: BackendEvent[] = [];
    void (async () => {
      for await (const event of adaptor.events({
        id: sessionId,
        adaptor: 'qodercli',
      })) {
        events.push(event);
      }
    })();
    const waitFor = async (
      predicate: (events: readonly BackendEvent[]) => boolean,
      timeoutMs = 60_000,
    ) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(events)) return events;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `timeout; events so far: ${JSON.stringify(events.slice(-5))}`,
      );
    };
    return { events, waitFor };
  }

  it('initializes, creates a session, and completes a round-trip', async () => {
    await adaptor.preflight();
    // qodercli advertises image support.
    expect(adaptor.capabilities().imageInput).toBe(true);
    // qodercli never drains (no craft/drainMidTurnQueue): steering must
    // honestly report 'queued'.
    expect(adaptor.capabilities().steering).toBe('queued');

    const handle = await adaptor.createSession({ cwd: '/tmp' });
    expect(handle.adaptor).toBe('qodercli');

    const collect = collector(handle.id);
    const receipt = await adaptor.prompt(handle, [
      { type: 'text', text: 'Reply with exactly: PONG' },
    ]);
    expect(receipt.status).toBe('accepted');

    const events = await collect.waitFor(
      (collected) => collected.some((event) => event.type === 'turn_complete'),
      90_000,
    );
    const complete = events.find(
      (event) => event.type === 'turn_complete',
    ) as Extract<BackendEvent, { type: 'turn_complete' }>;
    expect(complete.detail ?? complete.summary).toContain('PONG');
  }, 120_000);

  it('tracks the session in listSessions with its label', async () => {
    const handle = await adaptor.createSession({
      cwd: '/tmp',
      label: 'manual smoke',
    });
    const sessions = await adaptor.listSessions();
    const row = sessions.find((s) => s.handle.id === handle.id);
    expect(row).toBeDefined();
    expect(row?.label).toBe('manual smoke');
  });
});
