import assert from "node:assert/strict";
import { test } from "node:test";

import { ComputerUse, ComputerUseError } from "../index.js";

const REVISION_CAPABILITY = "accessibility.observation_revision.v1";
const METHOD_NAMES = [
  "listApps",
  "listWindows",
  "getWindowState",
  "verifyState",
  "windowClick",
  "doubleClick",
  "rightClick",
  "windowDrag",
  "windowScroll",
  "setValue",
  "windowTypeText",
  "windowPressKey",
  "windowHotkey",
  "performSecondaryAction",
];

const fakeSdk = {
  ClickButton: { Left: "left", Right: "right", Middle: "middle" },
  DeliveryMode: { Background: "background", Foreground: "foreground" },
  ScrollDirection: { Up: "up", Down: "down", Left: "left", Right: "right" },
  ScrollBy: { Line: "line", Page: "page" },
};

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
  const driver = {
    calls,
    callToolCalls: 0,
    async callTool() {
      this.callToolCalls += 1;
      throw new Error("the wrapper must not call callTool");
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
    endSessionCalls: [],
    async endSession(input) {
      this.endSessionCalls.push(input);
      return { active: false };
    },
    shutdownCalls: 0,
    async shutdown() {
      this.shutdownCalls += 1;
    },
    destroyCalls: 0,
    uniffiDestroy() {
      this.destroyCalls += 1;
    },
  };
  for (const method of METHOD_NAMES) {
    driver[method] = async (input) => {
      calls.push({ method, input });
      const handler = results[method];
      if (typeof handler === "function") return handler(input);
      if (handler) return handler;
      return toolResult({ structured: {} });
    };
  }
  return driver;
}

test("observeWindow uses the named typed method and returns revision metadata", async () => {
  const driver = fakeDriver({
    results: {
      getWindowState: toolResult({
        text: "content text",
        structured: {
          tree_markdown: "TREE",
          elements: [{ element_index: 0, element_token: "rv1:l_a:1" }],
          observation_revision: {
            capability: REVISION_CAPABILITY,
            version: 1,
            serializer_version: "accessibility-render-v1",
            projection_version: "full-tree-v1",
            mode: "diff",
            lineage_id: "l_a",
            revision_id: "l_a:r2",
            base_revision_id: "l_a:r1",
            stable_element_ids: true,
            selected_bytes: 321,
            full_bytes: 1234,
            estimated_tokens: 81,
            serializer_duration_us: 47,
            cache_estimate_bytes: 4096,
          },
        },
      }),
    },
  });
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  const observation = await computer.observeWindow({
    pid: 42,
    windowId: 7,
    baseRevisionId: "l_a:r1",
  });

  assert.deepEqual(driver.calls[0], {
    method: "getWindowState",
    input: {
      pid: 42,
      windowId: 7n,
      includeScreenshot: false,
      observationRevision: {
        version: 1,
        serializerVersion: "accessibility-render-v1",
        projectionVersion: "full-tree-v1",
        baseRevisionId: "l_a:r1",
      },
    },
  });
  assert.equal(driver.callToolCalls, 0);
  assert.equal(observation.mode, "diff");
  assert.equal(observation.revisionId, "l_a:r2");
  assert.equal(observation.serializerVersion, "accessibility-render-v1");
  assert.equal(observation.projectionVersion, "full-tree-v1");
  assert.equal(observation.stableElementIds, true);
  assert.equal(observation.selectedBytes, 321);
  assert.equal(observation.fullBytes, 1234);
  assert.equal(observation.estimatedTokens, 81);
  assert.equal(observation.serializerDurationUs, 47);
  assert.equal(observation.cacheEstimateBytes, 4096);
  assert.equal(observation.text, "TREE");
});

test("forceFull is explicit and the wrapper never invents a base", async () => {
  const driver = fakeDriver({
    results: {
      getWindowState: toolResult({
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
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  const observation = await computer.observeWindow({ pid: 42, windowId: 7, forceFull: true });
  assert.deepEqual(driver.calls[0].input.observationRevision, {
    version: 1,
    serializerVersion: "accessibility-render-v1",
    projectionVersion: "full-tree-v1",
    forceFull: true,
  });
  assert.equal(observation.resyncReason, "requested");
  assert.equal(observation.baseRevisionId, undefined);
});

test("drivers without revision capability retain legacy full observations", async () => {
  const driver = fakeDriver({
    revisionCapability: false,
    results: {
      getWindowState: toolResult({
        text: "legacy text",
        structured: { tree_markdown: "LEGACY", elements: [] },
      }),
    },
  });
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  const observation = await computer.observeWindow({
    pid: 42,
    windowId: 7,
    baseRevisionId: "ignored",
  });
  assert.equal("observationRevision" in driver.calls[0].input, false);
  assert.equal(observation.revisionSupported, false);
  assert.equal(observation.mode, "full");
  assert.equal(observation.text, "LEGACY");
});

test("typed discovery methods expose apps, windows, and exact-window lookup", async () => {
  const driver = fakeDriver({
    results: {
      listApps: toolResult({ structured: { apps: [{ pid: 42, name: "Harness" }] } }),
      listWindows: toolResult({
        structured: { windows: [{ pid: 42, window_id: 7, title: "Harness" }] },
      }),
    },
  });
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  assert.equal((await computer.listApps())[0].name, "Harness");
  assert.equal((await computer.listWindows({ pid: 42 }))[0].window_id, 7);
  assert.equal((await computer.getWindow({ pid: 42, windowId: 7 })).title, "Harness");
});

test("all core actions use named typed SDK methods", async () => {
  const driver = fakeDriver();
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  await computer.click({ pid: 42, elementToken: "rv1:l_a:1", count: 2 });
  await computer.doubleClick({ pid: 42, windowId: 7, x: 10, y: 20 });
  await computer.rightClick({
    pid: 42,
    elementToken: "rv1:l_a:2",
    modifier: ["shift"],
  });
  await computer.drag({
    pid: 42,
    windowId: 7,
    fromX: 1,
    fromY: 2,
    toX: 3,
    toY: 4,
    durationMs: 0,
    steps: 10,
    deliveryMode: "foreground",
    modifier: ["shift"],
  });
  await computer.scroll({
    pid: 42,
    elementToken: "rv1:l_a:3",
    direction: "down",
    by: "line",
    amount: 2,
  });
  await computer.setValue({ pid: 42, elementToken: "rv1:l_a:4", value: "hi" });
  await computer.typeText({
    pid: 42,
    elementToken: "rv1:l_a:5",
    text: "abc",
    delayMs: 5,
  });
  await computer.pressKey({
    pid: 42,
    windowId: 7,
    key: "Enter",
    modifiers: ["shift"],
  });
  await computer.hotkey({ pid: 42, windowId: 7, keys: ["cmd", "a"] });

  assert.deepEqual(
    driver.calls.map((call) => call.method),
    [
      "windowClick",
      "doubleClick",
      "rightClick",
      "windowDrag",
      "windowScroll",
      "setValue",
      "windowTypeText",
      "windowPressKey",
      "windowHotkey",
    ],
  );
  assert.deepEqual(driver.calls[0].input, {
    pid: 42,
    windowId: undefined,
    elementToken: "rv1:l_a:1",
    count: 2,
  });
  assert.equal(driver.calls[3].input.pid, 42);
  assert.equal(driver.calls[3].input.windowId, 7n);
  assert.equal(driver.calls[3].input.durationMs, 0n);
  assert.equal(driver.calls[3].input.steps, 10n);
  assert.equal(driver.calls[3].input.deliveryMode, "foreground");
  assert.deepEqual(driver.calls[3].input.modifier, ["shift"]);
  assert.equal(driver.calls[4].input.amount, 2n);
  assert.equal(driver.calls[6].input.delayMs, 5n);
  assert.equal(driver.callToolCalls, 0);
});

test("verifyState converts public numeric options to the generated u64 ABI", async () => {
  const driver = fakeDriver({
    results: { verifyState: toolResult({ structured: { status: "satisfied" } }) },
  });
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  await computer.verifyState({
    pid: 42,
    windowId: 7,
    expect: [{ window: { titleContains: "Harness" } }],
    timeoutMs: 0,
    stableSamples: 1,
  });
  assert.deepEqual(driver.calls[0], {
    method: "verifyState",
    input: {
      pid: 42n,
      windowId: 7n,
      expect: [{ window: { titleContains: "Harness" } }],
      timeoutMs: 0n,
      stableSamples: 1n,
    },
  });
});

test("secondary action is typed and token-only", async () => {
  const driver = fakeDriver();
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  await computer.performSecondaryAction({
    pid: 42,
    elementToken: "rv1:l_a:6",
    action: "Expand",
  });
  assert.deepEqual(driver.calls[0], {
    method: "performSecondaryAction",
    input: {
      pid: 42,
      windowId: undefined,
      elementToken: "rv1:l_a:6",
      action: "Expand",
    },
  });
});

test("driver refusals retain their closed code without wrapper retry", async () => {
  const driver = fakeDriver({
    results: {
      windowClick: toolResult({
        text: "element_token is stale",
        structured: { code: "stale_element_token" },
        isError: true,
      }),
    },
  });
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  await assert.rejects(
    computer.click({ pid: 42, elementToken: "rv1:l_old:1" }),
    (error) => error instanceof ComputerUseError && error.code === "stale_element_token",
  );
  assert.equal(driver.calls.length, 1);
});

test("local validation rejects ambiguous or malformed targets before dispatch", async () => {
  const driver = fakeDriver();
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  await assert.rejects(computer.observeWindow({ pid: 0, windowId: 7 }));
  await assert.rejects(
    computer.click({ pid: 42, windowId: 7, elementToken: "token", x: 1, y: 2 }),
  );
  await assert.rejects(computer.click({ pid: 42, x: 1, y: 2 }));
  await assert.rejects(computer.scroll({ pid: 42, windowId: 7 }));
  await assert.rejects(computer.setValue({ pid: 42, value: "x" }));
  await assert.rejects(computer.typeText({ pid: 42, text: "x" }));
  await assert.rejects(computer.pressKey({ pid: 42, key: "Enter" }));
  await assert.rejects(computer.hotkey({ pid: 42, windowId: 7, keys: ["cmd"] }));
  await assert.rejects(
    computer.drag({
      pid: 42,
      windowId: 7,
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
      deliveryMode: "automatic",
    }),
  );
  assert.equal(driver.calls.length, 0);
});

test("close is idempotent, releases owned handles, and blocks later calls", async () => {
  const session = fakeDriver();
  session.closeCalls = 0;
  session.close = function () {
    this.closeCalls += 1;
  };
  const owner = fakeDriver();
  const computer = new ComputerUse(session, {
    owner,
    sdk: fakeSdk,
    ownsSession: true,
    publicSession: "owned-session",
  });
  await computer.close();
  await computer.close();
  assert.deepEqual(session.endSessionCalls, [{ session: "owned-session" }]);
  assert.equal(session.closeCalls, 1);
  assert.equal(session.destroyCalls, 1);
  assert.equal(owner.shutdownCalls, 1);
  assert.equal(owner.destroyCalls, 1);
  await assert.rejects(computer.listApps(), (error) => /closed/.test(error.message));
});

test("close still tears down every owned handle when endSession fails", async () => {
  const session = fakeDriver();
  session.endSession = async () => {
    throw new Error("end-session-failed");
  };
  session.closeCalls = 0;
  session.close = function () {
    this.closeCalls += 1;
  };
  const owner = fakeDriver();
  const computer = new ComputerUse(session, {
    owner,
    sdk: fakeSdk,
    ownsSession: true,
    publicSession: "owned-session",
  });

  await assert.rejects(computer.close(), /end-session-failed/);
  assert.equal(session.closeCalls, 1);
  assert.equal(session.destroyCalls, 1);
  assert.equal(owner.shutdownCalls, 1);
  assert.equal(owner.destroyCalls, 1);
  await assert.rejects(computer.listApps(), /closed/);
});
