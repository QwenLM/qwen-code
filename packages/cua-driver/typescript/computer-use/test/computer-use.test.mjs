import assert from "node:assert/strict";
import { test } from "node:test";

import { ComputerUse, ComputerUseError } from "../index.js";

const REVISION_CAPABILITY = "accessibility.observation_revision.v1";
const METHOD_NAMES = [
  "listApps",
  "listWindows",
  "getSession",
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

function toolResult({
  text = "",
  structured,
  isError = false,
  errorCode,
  action,
  verification,
  degraded = false,
} = {}) {
  return {
    text,
    images: [],
    structuredJson: structured === undefined ? undefined : JSON.stringify(structured),
    isError,
    errorCode,
    action,
    verification,
    degraded,
    rawJson: "{}",
  };
}

function fakeDriver({ revisionCapability = true, results = {} } = {}) {
  const calls = [];
  const asyncOptions = [];
  const driver = {
    calls,
    asyncOptions,
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
    driver[method] = async (input, options) => {
      calls.push({ method, input });
      asyncOptions.push({ method, options });
      const handler = results[method];
      if (typeof handler === "function") return handler(input, options);
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
  await computer.click({
    pid: 42,
    elementToken: "rv1:l_a:1",
    count: 2,
    deliveryMode: "foreground",
  });
  await computer.doubleClick({
    pid: 42,
    windowId: 7,
    x: 10,
    y: 20,
    deliveryMode: "foreground",
  });
  await computer.rightClick({
    pid: 42,
    elementToken: "rv1:l_a:2",
    modifier: ["shift"],
    deliveryMode: "foreground",
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
    deliveryMode: "foreground",
  });
  await computer.setValue({ pid: 42, elementToken: "rv1:l_a:4", value: "hi" });
  await computer.typeText({
    pid: 42,
    elementToken: "rv1:l_a:5",
    text: "abc",
    delayMs: 5,
    deliveryMode: "foreground",
  });
  await computer.pressKey({
    pid: 42,
    windowId: 7,
    key: "Enter",
    modifiers: ["shift"],
    deliveryMode: "foreground",
  });
  await computer.hotkey({
    pid: 42,
    windowId: 7,
    keys: ["cmd", "a"],
    deliveryMode: "foreground",
  });

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
    deliveryMode: "foreground",
  });
  assert.equal(driver.calls[1].input.deliveryMode, "foreground");
  assert.equal(driver.calls[2].input.deliveryMode, "foreground");
  assert.equal(driver.calls[3].input.pid, 42);
  assert.equal(driver.calls[3].input.windowId, 7n);
  assert.equal(driver.calls[3].input.durationMs, 0n);
  assert.equal(driver.calls[3].input.steps, 10n);
  assert.equal(driver.calls[3].input.deliveryMode, "foreground");
  assert.deepEqual(driver.calls[3].input.modifier, ["shift"]);
  assert.equal(driver.calls[4].input.amount, 2n);
  assert.equal(driver.calls[4].input.deliveryMode, "foreground");
  assert.equal(driver.calls[6].input.delayMs, 5n);
  assert.equal(driver.calls[6].input.deliveryMode, "foreground");
  assert.equal(driver.calls[7].input.deliveryMode, "foreground");
  assert.equal(driver.calls[8].input.deliveryMode, "foreground");
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

test("native calls receive an AbortSignal and fail before the outer REPL timeout", async () => {
  const driver = fakeDriver({
    results: {
      listApps: (_input, options) => {
        if (!options?.signal) return new Promise(() => {});
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      },
    },
  });
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  const watchdog = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("facade did not cancel the native call")), 500);
  });

  await assert.rejects(
    Promise.race([computer.listApps({ callTimeoutMs: 20 }), watchdog]),
    (error) => error instanceof ComputerUseError && error.code === "call_timeout",
  );
  assert.equal(driver.asyncOptions[0].options.signal instanceof AbortSignal, true);
});

test("observation capability discovery shares the native call deadline", async () => {
  const driver = fakeDriver();
  let listingSignal;
  driver.listToolsJson = (options) => {
    listingSignal = options?.signal;
    return new Promise((_resolve, reject) => {
      listingSignal?.addEventListener(
        "abort",
        () => reject(listingSignal.reason),
        { once: true },
      );
    });
  };
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  const watchdog = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("capability discovery was not cancelled")), 500);
  });

  await assert.rejects(
    Promise.race([
      computer.observeWindow({ pid: 42, windowId: 7, callTimeoutMs: 20 }),
      watchdog,
    ]),
    (error) => error instanceof ComputerUseError && error.code === "call_timeout",
  );
  assert.equal(listingSignal instanceof AbortSignal, true);
});

test("observation capability discovery respects caller cancellation", async () => {
  const driver = fakeDriver();
  driver.listToolsJson = (options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      );
    });
  const computer = new ComputerUse(driver, { sdk: fakeSdk });
  const controller = new AbortController();
  const observation = computer.observeWindow({
    pid: 42,
    windowId: 7,
    signal: controller.signal,
  });

  controller.abort();
  await assert.rejects(
    observation,
    (error) => error instanceof ComputerUseError && error.code === "call_cancelled",
  );
});

test("typed action and verification records survive the facade and fail closed", async () => {
  const nativeAction = { effect: 0, route: 0 };
  const nativeVerification = {
    status: 0,
    stable: true,
    elapsedMs: 1n,
    samples: 2n,
    predicates: [],
  };
  const driver = fakeDriver({
    results: {
      windowClick: toolResult({
        structured: { effect: "confirmed", route: "accessibility" },
        action: nativeAction,
      }),
      verifyState: toolResult({
        structured: {
          status: "satisfied",
          stable: true,
          elapsed_ms: 1,
          samples: 2,
          predicates: [],
        },
        verification: nativeVerification,
      }),
    },
  });
  const computer = new ComputerUse(driver, { sdk: fakeSdk });

  const action = await computer.click({ pid: 42, windowId: 7, x: 1, y: 2 });
  const verification = await computer.verifyState({
    pid: 42,
    windowId: 7,
    expect: [{ element: { token: "rv1:l_a:1", selected: true } }],
  });
  assert.equal(action.action, nativeAction);
  assert.equal(verification.verification, nativeVerification);

  const succeeded = await computer.actAndVerify({
    action: () => computer.click({ pid: 42, windowId: 7, x: 1, y: 2 }),
    verify: () =>
      computer.verifyState({
        pid: 42,
        windowId: 7,
        expect: [{ element: { token: "rv1:l_a:1", selected: true } }],
      }),
  });
  assert.equal(succeeded.action.effect, "confirmed");
  assert.equal(succeeded.verification.status, "satisfied");

  driver.windowClick = async () =>
    toolResult({
      structured: { effect: "suspected_noop", route: "accessibility" },
      action: { effect: 3, route: 0 },
    });
  driver.verifyState = async () =>
    toolResult({
      structured: {
        status: "unknown",
        stable: false,
        elapsed_ms: 1,
        samples: 1,
        predicates: [],
      },
      verification: { ...nativeVerification, status: 2, stable: false },
    });
  await assert.rejects(
    computer.actAndVerify({
      action: () => computer.click({ pid: 42, windowId: 7, x: 1, y: 2 }),
      verify: () =>
        computer.verifyState({
          pid: 42,
          windowId: 7,
          expect: [{ element: { token: "rv1:l_a:1", selected: true } }],
        }),
    }),
    (error) =>
      error instanceof ComputerUseError && error.code === "postcondition_not_satisfied",
  );
});

test("unavailable read calls reconnect once and force the next observation full", async () => {
  const expired = fakeDriver({
    results: {
      listApps: toolResult({
        text: "session is not available to this transport",
        structured: {
          code: "session_unavailable",
        },
        isError: true,
      }),
    },
  });
  expired.closeCalls = 0;
  expired.close = function () {
    this.closeCalls += 1;
  };
  const sessionOutput = {
    session: "persistent-session",
    implicit: false,
    state: 0,
    clientKind: 1,
    transport: 0,
    cursorVisible: false,
    recordingActive: false,
    idleSeconds: 0n,
    expiresInSeconds: 3600n,
  };
  const replacement = fakeDriver({
    results: {
      listApps: toolResult({ structured: { apps: [{ pid: 42, name: "Harness" }] } }),
      getSession: sessionOutput,
      getWindowState: toolResult({
        structured: {
          tree_markdown: "FULL",
          observation_revision: {
            mode: "full",
            lineage_id: "l_new",
            revision_id: "l_new:r1",
            stable_element_ids: true,
          },
        },
      }),
    },
  });
  const owner = fakeDriver();
  let factoryCalls = 0;
  let replacementPublicSession;
  const computer = new ComputerUse(expired, {
    owner,
    sdk: fakeSdk,
    ownsSession: true,
    publicSession: "persistent-session",
    sessionFactory: (_signal, publicSession) => {
      factoryCalls += 1;
      replacementPublicSession = publicSession;
      return replacement;
    },
  });

  assert.equal((await computer.listApps())[0].name, "Harness");
  assert.equal(factoryCalls, 1);
  assert.equal(expired.closeCalls, 1);
  assert.equal(expired.destroyCalls, 1);
  assert.equal(computer.connectionGeneration, 2);
  assert.equal(typeof replacementPublicSession, "string");
  assert.notEqual(replacementPublicSession, "persistent-session");
  assert.equal(await computer.sessionInfo(), sessionOutput);

  await computer.observeWindow({
    pid: 42,
    windowId: 7,
    baseRevisionId: "l_old:r9",
  });
  const observeInput = replacement.calls.find(
    (entry) => entry.method === "getWindowState",
  ).input;
  assert.equal(observeInput.observationRevision.baseRevisionId, undefined);
  assert.equal(observeInput.observationRevision.forceFull, true);
});

test("stale observations cannot clear a replacement session's full-observation guard", async () => {
  let resolveStaleObservation;
  const expired = fakeDriver({
    results: {
      listApps: toolResult({
        text: "authorization context expired",
        structured: {
          status: "refused",
          refusal: { code: "authorization_context_expired" },
        },
        isError: true,
      }),
      getWindowState: () =>
        new Promise((resolve) => {
          resolveStaleObservation = resolve;
        }),
    },
  });
  expired.close = () => {};
  const replacement = fakeDriver({
    results: {
      listApps: toolResult({ structured: { apps: [] } }),
      getWindowState: toolResult({
        structured: {
          tree_markdown: "FULL",
          observation_revision: {
            mode: "full",
            lineage_id: "l_new",
            revision_id: "l_new:r1",
            stable_element_ids: true,
          },
        },
      }),
    },
  });
  const computer = new ComputerUse(expired, {
    owner: expired,
    sdk: fakeSdk,
    ownsSession: true,
    sessionFactory: () => replacement,
  });

  const staleObservation = computer.observeWindow({
    pid: 42,
    windowId: 7,
    baseRevisionId: "l_old:r1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await computer.listApps();
  resolveStaleObservation(
    toolResult({
      structured: {
        tree_markdown: "STALE",
        observation_revision: {
          mode: "diff",
          lineage_id: "l_old",
          revision_id: "l_old:r2",
          base_revision_id: "l_old:r1",
          stable_element_ids: true,
        },
      },
    }),
  );
  await staleObservation;

  await computer.observeWindow({
    pid: 42,
    windowId: 7,
    baseRevisionId: "l_old:r2",
  });
  const replacementInput = replacement.calls.find(
    (entry) => entry.method === "getWindowState",
  ).input;
  assert.equal(replacementInput.observationRevision.baseRevisionId, undefined);
  assert.equal(replacementInput.observationRevision.forceFull, true);
});

test("concurrent expired reads share one replacement session", async () => {
  const expiredResult = toolResult({
    text: "authorization context expired",
    structured: {
      status: "refused",
      refusal: { code: "authorization_context_expired" },
    },
    isError: true,
  });
  let releaseLateExpiration;
  const lateExpiration = new Promise((resolve) => {
    releaseLateExpiration = resolve;
  });
  let expiredCalls = 0;
  const expired = fakeDriver({
    results: {
      listApps: () => {
        expiredCalls += 1;
        return expiredCalls === 3 ? lateExpiration : expiredResult;
      },
    },
  });
  expired.closeCalls = 0;
  expired.close = function () {
    this.closeCalls += 1;
  };
  const replacement = fakeDriver({
    results: {
      listApps: toolResult({ structured: { apps: [{ pid: 42, name: "Harness" }] } }),
    },
  });
  let resolveFactory;
  const replacementPromise = new Promise((resolve) => {
    resolveFactory = resolve;
  });
  let factoryCalls = 0;
  const computer = new ComputerUse(expired, {
    sdk: fakeSdk,
    ownsSession: true,
    sessionFactory: () => {
      factoryCalls += 1;
      return replacementPromise;
    },
  });

  const first = computer.listApps();
  const second = computer.listApps();
  const late = computer.listApps();
  await new Promise((resolve) => setImmediate(resolve));
  resolveFactory(replacement);
  const firstResults = await Promise.all([first, second]);
  releaseLateExpiration(expiredResult);
  const lateResult = await late;

  assert.deepEqual(
    [...firstResults, lateResult].map((apps) => apps[0].name),
    ["Harness", "Harness", "Harness"],
  );
  assert.equal(factoryCalls, 1);
  assert.equal(expired.closeCalls, 1);
  assert.equal(expired.destroyCalls, 1);
  assert.equal(computer.connectionGeneration, 2);
});

test("automatic reconnect shares the caller deadline with async teardown and binding", async () => {
  const expired = fakeDriver({
    results: {
      listApps: toolResult({
        text: "authorization context expired",
        structured: {
          status: "refused",
          refusal: { code: "authorization_context_expired" },
        },
        isError: true,
      }),
    },
  });
  let syncCloseCalls = 0;
  let asyncCloseSignal;
  expired.close = () => {
    syncCloseCalls += 1;
    throw new Error("synchronous close must not run during reconnect");
  };
  expired.closeAsync = async (options) => {
    asyncCloseSignal = options?.signal;
  };
  let factorySignal;
  const computer = new ComputerUse(expired, {
    sdk: fakeSdk,
    ownsSession: true,
    sessionFactory: (signal) =>
      new Promise((_resolve, reject) => {
        factorySignal = signal;
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  let watchdogTimer;
  const watchdog = new Promise((_resolve, reject) => {
    watchdogTimer = setTimeout(
      () => reject(new Error("reconnect ignored its deadline")),
      500,
    );
  });

  try {
    await assert.rejects(
      Promise.race([computer.listApps({ callTimeoutMs: 20 }), watchdog]),
      (error) =>
        error instanceof ComputerUseError && error.code === "call_timeout",
    );
  } finally {
    clearTimeout(watchdogTimer);
  }
  assert.equal(syncCloseCalls, 0);
  assert.equal(asyncCloseSignal instanceof AbortSignal, true);
  assert.equal(factorySignal instanceof AbortSignal, true);
});

test("caller cancellation aborts replacement binding", async () => {
  const expired = fakeDriver({
    results: {
      listApps: toolResult({
        text: "authorization context expired",
        structured: {
          status: "refused",
          refusal: { code: "authorization_context_expired" },
        },
        isError: true,
      }),
    },
  });
  expired.close = () => {
    throw new Error("synchronous close must not run during reconnect");
  };
  expired.closeAsync = async () => {};
  let factorySignal;
  const computer = new ComputerUse(expired, {
    sdk: fakeSdk,
    ownsSession: true,
    sessionFactory: (signal) =>
      new Promise((_resolve, reject) => {
        factorySignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  const controller = new AbortController();
  const read = computer.listApps({
    signal: controller.signal,
    callTimeoutMs: 200,
  });
  await new Promise((resolve) => setImmediate(resolve));

  controller.abort(new Error("stop reconnect"));
  await assert.rejects(
    read,
    (error) =>
      error instanceof ComputerUseError && error.code === "call_cancelled",
  );
  assert.equal(factorySignal.aborted, true);
  assert.equal(computer.connectionGeneration, 1);
});

test("a later call retries session creation after automatic reconnect fails", async () => {
  const expired = fakeDriver({
    results: {
      listApps: toolResult({
        text: "authorization context expired",
        structured: {
          status: "refused",
          refusal: { code: "authorization_context_expired" },
        },
        isError: true,
      }),
    },
  });
  expired.close = () => {};
  const replacement = fakeDriver({
    results: {
      listApps: toolResult({
        structured: { apps: [{ pid: 42, name: "Harness" }] },
      }),
    },
  });
  let factoryCalls = 0;
  const computer = new ComputerUse(expired, {
    sdk: fakeSdk,
    ownsSession: true,
    sessionFactory: () => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new Error("transient bind failure");
      return replacement;
    },
  });

  await assert.rejects(
    computer.listApps(),
    (error) =>
      error instanceof ComputerUseError && error.code === "reconnect_failed",
  );
  assert.deepEqual(await computer.listApps(), [{ pid: 42, name: "Harness" }]);
  assert.equal(factoryCalls, 2);
  assert.equal(computer.connectionGeneration, 2);
});

test("close during reconnect destroys the unused replacement", async () => {
  const expired = fakeDriver({
    results: {
      listApps: toolResult({
        text: "authorization context expired",
        structured: {
          status: "refused",
          refusal: { code: "authorization_context_expired" },
        },
        isError: true,
      }),
    },
  });
  expired.closeCalls = 0;
  expired.close = function () {
    this.closeCalls += 1;
  };
  const replacement = fakeDriver();
  replacement.closeCalls = 0;
  replacement.close = function () {
    this.closeCalls += 1;
  };
  let resolveFactory;
  const computer = new ComputerUse(expired, {
    owner: fakeDriver(),
    sdk: fakeSdk,
    ownsSession: true,
    publicSession: "persistent-session",
    sessionFactory: () =>
      new Promise((resolve) => {
        resolveFactory = resolve;
      }),
  });

  const read = computer.listApps();
  await new Promise((resolve) => setImmediate(resolve));
  await computer.close();
  resolveFactory(replacement);

  await assert.rejects(read, /closed/);
  assert.equal(replacement.closeCalls, 1);
  assert.equal(replacement.destroyCalls, 1);
  assert.equal(computer.connectionGeneration, 1);
});

test("an expired state-changing action is never replayed automatically", async () => {
  const driver = fakeDriver({
    results: {
      windowClick: toolResult({
        text: "authorization context expired",
        structured: {
          status: "refused",
          refusal: { code: "authorization_context_expired" },
        },
        isError: true,
      }),
    },
  });
  let factoryCalls = 0;
  const computer = new ComputerUse(driver, {
    sdk: fakeSdk,
    ownsSession: true,
    sessionFactory: () => {
      factoryCalls += 1;
      return fakeDriver();
    },
  });
  await assert.rejects(
    computer.click({ pid: 42, windowId: 7, x: 1, y: 2 }),
    (error) =>
      error instanceof ComputerUseError &&
      error.code === "authorization_context_expired",
  );
  assert.equal(factoryCalls, 0);
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

test("closeAsync receives a usable signal when close has no caller signal", async () => {
  const session = fakeDriver();
  session.closeAsyncCalls = 0;
  session.closeAsync = async function ({ signal }) {
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(signal.aborted, false);
    this.closeAsyncCalls += 1;
  };
  const owner = fakeDriver();
  const computer = new ComputerUse(session, {
    owner,
    sdk: fakeSdk,
    ownsSession: true,
    publicSession: "async-close-session",
  });

  await computer.close();
  assert.equal(session.closeAsyncCalls, 1);
  assert.equal(session.destroyCalls, 1);
  assert.equal(owner.shutdownCalls, 1);
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
