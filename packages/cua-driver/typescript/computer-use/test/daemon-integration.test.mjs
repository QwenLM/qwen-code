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
 * full → (no_change | diff) with a caller-owned base. Every request goes
 * through the wrapper's named typed methods.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ComputerUse } from "../index.js";

const socketPath = process.env.COMPUTER_USE_SOCKET;
const pid = Number(process.env.COMPUTER_USE_PID ?? "");
const windowId = Number(process.env.COMPUTER_USE_WINDOW ?? "");
const configured =
  Number.isInteger(pid) && pid > 0 && Number.isInteger(windowId) && windowId > 0;

test(
  "wrapper drives revision v1 against a live native target",
  { skip: !configured && "set COMPUTER_USE_PID/WINDOW to run" },
  async () => {
    const options = { session: "computer-use-integration" };
    const computer = socketPath
      ? await ComputerUse.connect({ ...options, socketPath })
      : await ComputerUse.create(options);
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
          second.selectedBytes < second.fullBytes,
          "a validated diff/no_change payload must be smaller than the current full tree",
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
