/**
 * Standalone Node.js integration test: drives a REAL cua-driver daemon
 * through this wrapper — no Qwen Code, no Node REPL, no Skill.
 *
 * Gated behind two environment variables so unit CI stays hermetic:
 *
 *   COMPUTER_USE_SOCKET  absolute path of the daemon socket to connect to
 *                        (e.g. the local dev install's qwen-cua-driver-local
 *                        socket).
 *   COMPUTER_USE_PID     pid of an already-running observable app.
 *   COMPUTER_USE_WINDOW  window_id of that app's window.
 *
 * The test proves the wrapper against the versioned revision protocol:
 * full → (no_change | diff) with a caller-owned base, plus the typed
 * `getWindowState` SDK method as a cross-check of the generated bindings.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ComputerUse } from "../index.js";

const socketPath = process.env.COMPUTER_USE_SOCKET;
const pid = Number(process.env.COMPUTER_USE_PID ?? "");
const windowId = Number(process.env.COMPUTER_USE_WINDOW ?? "");
const configured =
  Boolean(socketPath) && Number.isInteger(pid) && pid > 0 && Number.isInteger(windowId);

test(
  "wrapper drives revision v1 against a live daemon",
  { skip: !configured && "set COMPUTER_USE_SOCKET/PID/WINDOW to run" },
  async () => {
    const computer = await ComputerUse.connect({
      socketPath,
      session: "computer-use-integration",
    });
    try {
      assert.equal(await computer.supportsObservationRevision(), true);

      const first = await computer.observeWindow({ pid, windowId });
      assert.equal(first.revisionSupported, true);
      assert.equal(first.mode, "full");
      assert.ok(first.revisionId, "first observation must name a revision");
      assert.ok(first.text.length > 0);

      const second = await computer.observeWindow({
        pid,
        windowId,
        baseRevisionId: first.revisionId,
      });
      assert.equal(second.revisionSupported, true);
      assert.ok(
        ["no_change", "diff", "full"].includes(second.mode),
        `unexpected mode ${second.mode}`,
      );
      if (second.mode !== "full") {
        assert.equal(second.baseRevisionId, first.revisionId);
        assert.ok(
          second.text.length < first.text.length,
          "a validated diff/no_change response must be smaller than the full tree",
        );
      }

      const forced = await computer.observeWindow({
        pid,
        windowId,
        baseRevisionId: second.revisionId ?? first.revisionId,
        forceFull: true,
      });
      assert.equal(forced.mode, "full");
      assert.equal(forced.resyncReason, "requested");
    } finally {
      await computer.close();
    }
  },
);

test(
  "typed getWindowState SDK method carries the revision request end to end",
  { skip: !configured && "set COMPUTER_USE_SOCKET/PID/WINDOW to run" },
  async () => {
    const { CuaDriver } = await import("@trycua/cua-driver");
    const driver = CuaDriver.connect(socketPath);
    const result = await driver.getWindowState({
      pid,
      windowId: BigInt(windowId),
      includeScreenshot: false,
      observationRevision: { version: 1 },
    });
    assert.equal(result.isError, false);
    const structured = JSON.parse(result.structuredJson ?? "{}");
    const envelope = structured.observation_revision;
    assert.ok(envelope, "typed opt-in must return the revision envelope");
    assert.equal(envelope.capability, "accessibility.observation_revision.v1");
    assert.equal(envelope.version, 1);
    assert.equal(envelope.mode, "full");
    await driver.shutdown();
  },
);
