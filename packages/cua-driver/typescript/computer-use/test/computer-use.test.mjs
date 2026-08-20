import assert from "node:assert/strict";
import { test } from "node:test";

import { ComputerUse, ComputerUseError } from "../index.js";

const REVISION_CAPABILITY = "accessibility.observation_revision.v1";

function toolResult({ text = "", structured, isError = false, errorCode } = {}) {
  return {
    text,
    images: [],
    structuredJson: structured === undefined ? undefined : JSON.stringify(structured),
    isError,
    errorCode,
    degraded: false,
    rawJson: "{}",
  };
}

function fakeDriver({ revisionCapability = true, results = {} } = {}) {
  const calls = [];
  return {
    calls,
    async callTool(name, argumentsJson) {
      const args = JSON.parse(argumentsJson);
      calls.push({ name, args });
      const handler = results[name];
      if (typeof handler === "function") return handler(args);
      if (handler) return handler;
      return toolResult({ structured: {} });
    },
    async listToolsJson() {
      return JSON.stringify({
        tools: [
          {
            name: "get_window_state",
            capabilities: revisionCapability
              ? ["accessibility.tree", REVISION_CAPABILITY]
              : ["accessibility.tree"],
          },
        ],
      });
    },
    shutdownCalls: 0,
    async shutdown() {
      this.shutdownCalls += 1;
    },
  };
}

test("observeWindow opts in to revision v1 and returns the envelope", async () => {
  const driver = fakeDriver({
    results: {
      get_window_state: toolResult({
        text: "content text",
        structured: {
          tree_markdown: "TREE",
          elements: [{ element_index: 0, element_token: "rv1:l_a:1" }],
          observation_revision: {
            capability: REVISION_CAPABILITY,
            version: 1,
            mode: "diff",
            lineage_id: "l_a",
            revision_id: "l_a:r2",
            base_revision_id: "l_a:r1",
            stable_element_ids: true,
          },
        },
      }),
    },
  });
  const computer = new ComputerUse(driver, { session: "s1" });
  const observation = await computer.observeWindow({
    pid: 42,
    windowId: 7,
    baseRevisionId: "l_a:r1",
  });

  assert.equal(driver.calls.length, 1);
  assert.deepEqual(driver.calls[0].args, {
    pid: 42,
    window_id: 7,
    include_screenshot: false,
    session: "s1",
    observation_revision: { version: 1, base_revision_id: "l_a:r1" },
  });
  assert.equal(observation.mode, "diff");
  assert.equal(observation.revisionId, "l_a:r2");
  assert.equal(observation.baseRevisionId, "l_a:r1");
  assert.equal(observation.stableElementIds, true);
  assert.equal(observation.revisionSupported, true);
  assert.equal(observation.text, "TREE");
  assert.equal(observation.elements.length, 1);
});

test("observeWindow forwards force_full and never invents a base", async () => {
  const driver = fakeDriver({
    results: {
      get_window_state: toolResult({
        structured: {
          tree_markdown: "TREE",
          observation_revision: {
            capability: REVISION_CAPABILITY,
            version: 1,
            mode: "full",
            lineage_id: "l_a",
            revision_id: "l_a:r1",
            resync_reason: "requested",
            stable_element_ids: true,
          },
        },
      }),
    },
  });
  const computer = new ComputerUse(driver);
  const observation = await computer.observeWindow({
    pid: 42,
    windowId: 7,
    forceFull: true,
  });
  assert.deepEqual(driver.calls[0].args.observation_revision, {
    version: 1,
    force_full: true,
  });
  assert.equal(observation.mode, "full");
  assert.equal(observation.resyncReason, "requested");
  assert.equal(observation.baseRevisionId, undefined);
});

test("drivers without the capability keep the legacy full snapshot", async () => {
  const driver = fakeDriver({
    revisionCapability: false,
    results: {
      get_window_state: toolResult({
        text: "legacy text",
        structured: { tree_markdown: "LEGACY", elements: [] },
      }),
    },
  });
  const computer = new ComputerUse(driver);
  assert.equal(await computer.supportsObservationRevision(), false);
  const observation = await computer.observeWindow({
    pid: 42,
    windowId: 7,
    baseRevisionId: "stale",
  });
  assert.equal("observation_revision" in driver.calls[0].args, false);
  assert.equal(observation.revisionSupported, false);
  assert.equal(observation.mode, "full");
  assert.equal(observation.revisionId, undefined);
  assert.equal(observation.text, "LEGACY");
});

test("failed observations throw with the driver's closed error code", async () => {
  const driver = fakeDriver({
    results: {
      get_window_state: toolResult({
        text: "unsupported observation_revision version 2; expected 1",
        structured: { code: "invalid_observation_revision" },
        isError: true,
      }),
    },
  });
  const computer = new ComputerUse(driver);
  await assert.rejects(
    computer.observeWindow({ pid: 42, windowId: 7 }),
    (error) =>
      error instanceof ComputerUseError &&
      error.code === "invalid_observation_revision",
  );
});

test("element actions dispatch opaque tokens without renaming them", async () => {
  const driver = fakeDriver({
    results: {
      click: toolResult({ structured: { clicked: true } }),
      set_value: toolResult({ structured: { ok: true } }),
      type_text: toolResult({ structured: { ok: true } }),
    },
  });
  const computer = new ComputerUse(driver);

  await computer.click({ pid: 42, elementToken: "rv1:l_a:5", count: 2 });
  assert.deepEqual(driver.calls[0], {
    name: "click",
    args: { pid: 42, element_token: "rv1:l_a:5", count: 2 },
  });

  await computer.setValue({ pid: 42, elementToken: "rv1:l_a:6", value: "hi" });
  assert.deepEqual(driver.calls[1], {
    name: "set_value",
    args: { pid: 42, element_token: "rv1:l_a:6", value: "hi" },
  });

  await computer.typeText({ pid: 42, windowId: 7, text: "abc" });
  assert.deepEqual(driver.calls[2], {
    name: "type_text",
    args: { pid: 42, window_id: 7, text: "abc" },
  });
});

test("stale token refusals surface as errors before any retry logic", async () => {
  const driver = fakeDriver({
    results: {
      click: toolResult({
        text: "element_token is stale",
        structured: { code: "stale_element_token" },
        isError: true,
      }),
    },
  });
  const computer = new ComputerUse(driver);
  await assert.rejects(
    computer.click({ pid: 42, elementToken: "rv1:l_old:1" }),
    (error) => error.code === "stale_element_token",
  );
});

test("input validation rejects malformed targets locally", async () => {
  const driver = fakeDriver();
  const computer = new ComputerUse(driver);
  await assert.rejects(computer.observeWindow({ pid: 0, windowId: 7 }));
  await assert.rejects(computer.click({ pid: 42, elementToken: "" }));
  await assert.rejects(computer.scroll({ pid: 42 }));
  await assert.rejects(computer.hotkey({ pid: 42, keys: ["cmd"] }));
  assert.equal(driver.calls.length, 0);
});

test("close is idempotent and blocks further calls", async () => {
  const driver = fakeDriver();
  const computer = new ComputerUse(driver);
  await computer.close();
  await computer.close();
  assert.equal(driver.shutdownCalls, 1);
  await assert.rejects(computer.listApps(), (error) =>
    /closed/.test(error.message),
  );
});
