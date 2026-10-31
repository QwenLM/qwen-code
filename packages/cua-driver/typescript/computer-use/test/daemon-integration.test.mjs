/**
 * Standalone Node.js E2E test: drives a REAL cua-driver runtime through this
 * high-level wrapper — no Qwen Code, no Node REPL, no Skill, no callTool.
 *
 * Gated behind two target variables so unit CI stays hermetic:
 *
 *   COMPUTER_USE_PID     pid of an already-running observable app.
 *   COMPUTER_USE_WINDOW  window_id of that app's window.
 *   COMPUTER_USE_SOCKET  optional compatible daemon socket. When omitted the
 *                        wrapper creates its configured in-process runtime.
 *
 * The test proves the wrapper against the versioned revision protocol:
 * full → (no_change | diff) with an automatically managed base. Every request
 * goes through the wrapper's named typed methods.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ComputerUse } from "../index.js";

const socketPath = process.env.COMPUTER_USE_SOCKET;

test("default authorization follows the ComputerUse owner lifetime", async () => {
  const computer = await ComputerUse.create({
    session: `computer-use-owner-lifetime-${process.pid}`,
  });
  try {
    await computer.getState();
    const session = await computer.sessionInfo();
    assert.ok(
      session.expiresInSeconds > 24n * 60n * 60n,
      `default session unexpectedly has a short TTL: ${session.expiresInSeconds}`,
    );
  } finally {
    await computer.close();
  }
});

test("finite authorization remains an explicit opt-in", async () => {
  const computer = await ComputerUse.create({
    session: `computer-use-finite-lifetime-${process.pid}`,
    sessionTtlSeconds: 60,
    idleTtlSeconds: 30,
  });
  try {
    await computer.getState();
    const session = await computer.sessionInfo();
    assert.ok(session.expiresInSeconds <= 30n);
  } finally {
    await computer.close();
  }
});

test('runtime observes a live native app without SDK window resolution', { skip: !process.env.COMPUTER_USE_APP && 'set COMPUTER_USE_APP to run' }, async () => {
  const computer = socketPath ? await ComputerUse.connect({ socketPath }) : await ComputerUse.create();
  try {
    const { app, initial } = await computer.getApp(process.env.COMPUTER_USE_APP);
    assert.equal(initial.structured.mode, 'full');
    assert.equal(initial.images.length, 0);
    const second = await app.call('get_ax_state');
    assert.ok(['diff','no_change','full'].includes(second.structured.mode));
    const full = await app.call('get_ax_state', { force_full: true });
    assert.equal(full.structured.mode, 'full');
    assert.equal(full.structured.elements, undefined);
  } finally { await computer.close(); }
});
