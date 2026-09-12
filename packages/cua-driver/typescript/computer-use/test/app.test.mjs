import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUse } from "../index.js";

function result(structured, extra = {}) {
  return { text: "", structuredJson: JSON.stringify(structured), images: [], isError: false, ...extra };
}

const appRecord = { name: "Fixture", bundle_id: "org.example.fixture", launch_path: "/Applications/Fixture.app", pid: 42, running: true };
const document = { window_id: 7, title: "Document", z_index: 2, is_on_screen: true, is_app_target: true };
const dialog = { window_id: 9, title: "Save", z_index: 10, is_on_screen: true, is_app_target: false };
const compactState = '[37] TextField "Name" value="draft"\n[38] StaticText "Keep frame=1,2 and <AXButton> verbatim"';

function fixture({ apps = [{ ...appRecord }], windows = [{ ...document }], observe, action } = {}) {
  const calls = [];
  let revision = 0;
  const driver = {
    async listToolsJson() {
      return JSON.stringify({ tools: [{ name: "get_window_state", capabilities: ["accessibility.observation_revision.v1"] }] });
    },
    async listApps(input) { calls.push({ method: "listApps", input }); return result({ apps }); },
    async listWindows(input) { calls.push({ method: "listWindows", input }); return result({ windows }); },
    async getWindowState(input) {
      calls.push({ method: "getWindowState", input });
      revision += 1;
      const token = `rv1:window_${input.windowId}:25`;
      const state = {
        tree_markdown: compactState,
        elements: [{ element_index: 3, element_id: 37, element_token: token, role: "AXTextField" }],
        observation_revision: { mode: "full", revision_id: `r${revision}`, stable_element_ids: true, capture_complete: true },
        background_input: { routes: ["accessibility", "pid_keyboard", "window_pointer"].map((route) => ({ route, status: "available" })) },
        ...(input.includeScreenshot ? { screenshot_width: 100, screenshot_height: 80, screenshot_frame_valid: true } : {}),
      };
      return result(observe ? await observe(input, state, revision) : state, {
        images: input.includeScreenshot ? [{ mimeType: "image/png", dataBase64: "fixture" }] : [],
      });
    },
  };
  for (const method of ["windowClick", "doubleClick", "rightClick", "windowPressKey", "windowTypeText", "windowHotkey", "windowDrag", "windowScroll", "setValue", "performSecondaryAction"]) {
    driver[method] = async (input) => {
      calls.push({ method, input });
      return action ? action(method, input) : result({ effect: "confirmed" });
    };
  }
  return { computer: new ComputerUse(driver), calls, windows, apps };
}

test("app aliases bind the same handle and hide OS addressing from state", async () => {
  const { computer, calls } = fixture();
  const app = await computer.getApp("Fixture");
  assert.equal(app, await computer.getApp("org.example.fixture"));
  assert.equal(app, await computer.getApp("/Applications/Fixture.app"));
  const state = await app.getState();
  assert.deepEqual(Object.keys(state).sort(), ["app", "mode", "text", "window"]);
  assert.equal(state.text, compactState);
  assert.doesNotMatch(state.text, /element_token=|enabled=true|frame=1,2,30,40/);
  assert.equal(calls.find((call) => call.method === "listWindows").input.appContext, true);
  const observation = calls.find((call) => call.method === "getWindowState").input;
  assert.equal(observation.appContext, true);
  assert.equal(observation.observationRevision.projectionVersion, "app-tree-v1");
  await app.click(37);
  assert.equal(calls.at(-1).input.elementToken, "rv1:window_7:25");
  assert.equal(calls.at(-1).input.windowId, 7n);
  assert.equal(calls.at(-1).input.elementIndex, undefined);
});

test("app resolution rejects ambiguous names instead of selecting the first process", async () => {
  const { computer } = fixture({ apps: [appRecord, { ...appRecord, pid: 84, bundle_id: "org.other.fixture", launch_path: "/Applications/OtherFixture.app" }] });
  await assert.rejects(computer.getApp("Fixture"), { code: "app_ambiguous" });
  assert.equal((await computer.getApp("org.other.fixture")).name, "Fixture");
});

test("native app target changes invalidate prior element IDs", async () => {
  const { computer, calls, windows } = fixture();
  const app = await computer.getApp("Fixture");
  await app.getState();
  windows[0].is_app_target = false;
  windows.push({ ...dialog, z_index: -1, is_app_target: true });
  await assert.rejects(app.click(37), { code: "app_observation_required" });
  assert.equal(calls.filter((call) => call.method === "windowClick").length, 0);
  assert.equal((await app.getState()).window, "Save");
  await app.click(37);
  assert.equal(calls.at(-1).input.elementToken, "rv1:window_9:25");
  windows.pop();
  windows[0].is_app_target = true;
  assert.equal((await app.getState()).window, "Document");
  assert.equal(calls.at(-1).input.observationRevision.forceFull, true);
});

test("missing or multiple native app targets cannot silently pick a window", async () => {
  for (const is_app_target of [false, true]) {
    const { computer } = fixture({ windows: [{ ...document, is_app_target }, { ...dialog, is_app_target }] });
    const app = await computer.getApp("Fixture");
    await assert.rejects(app.getState(), { code: "app_window_unavailable" });
  }
});

test("native target selection ignores z order and on-screen ordering", async () => {
  const { computer } = fixture({ windows: [dialog, { ...document, z_index: null, is_on_screen: false }] });
  assert.equal((await (await computer.getApp("Fixture")).getState()).window, "Document");
});

test("app input dispatches once and delegates the drag route to native app context", async () => {
  const { computer, calls, windows } = fixture();
  const app = await computer.getApp("Fixture");
  await app.getState();
  await app.pressKey("Return");
  assert.equal(calls.at(-1).input.deliveryMode, "background");
  windows.push(dialog);
  await app.getState({ includeScreenshot: true });
  await app.pressKey("Return");
  assert.equal(calls.at(-1).input.deliveryMode, "background");
  await app.drag({ fromX: 1, fromY: 2, toX: 20, toY: 25 });
  assert.equal(calls.at(-1).input.deliveryMode, "background");
  assert.equal(calls.at(-1).input.appContext, true);
  assert.equal(calls.filter((call) => call.method === "windowPressKey").length, 2);
  assert.equal(calls.filter((call) => call.method === "windowDrag").length, 1);
  assert.equal(calls.filter((call) => call.method === "getWindowState").length, 2);
});

test("coordinates need a screenshot while AX actions do not", async () => {
  const { computer } = fixture();
  const app = await computer.getApp("Fixture");
  await app.getState();
  await app.click(37);
  await assert.rejects(app.click({ x: 1, y: 2 }), { code: "app_screenshot_required" });
  await app.getState({ includeScreenshot: true });
  await app.click({ x: 1, y: 2 });
});

test("missing capability metadata does not make the facade choose another input route", async () => {
  const { computer, calls } = fixture({ observe: (_input, state) => ({ ...state, background_input: undefined }) });
  const app = await computer.getApp("Fixture");
  await app.getState();
  await app.pressKey("Return");
  assert.equal(calls.at(-1).input.deliveryMode, "background");
  assert.equal(calls.filter((call) => call.method === "windowPressKey").length, 1);
});

test("incomplete AX retains static content but does not retain action bindings", async () => {
  const { computer, calls } = fixture({ observe: (_input, state) => ({
    ...state,
    observation_revision: { ...state.observation_revision, capture_complete: false },
  }) });
  const app = await computer.getApp("Fixture");
  const state = await app.getState();
  assert.match(state.text, /incomplete/);
  assert.match(state.text, /StaticText/);
  assert.doesNotMatch(state.text, /element_token=/);
  await assert.rejects(app.click(37), { code: "app_element_unavailable" });
  assert.equal(calls.filter((call) => call.method === "windowClick").length, 0);
});

test("the app advances native revision cursors and refreshes mappings even on no-change", async () => {
  const { computer, calls } = fixture({ observe: (_input, state, count) => ({
    ...state,
    tree_markdown: count === 1 ? state.tree_markdown : "No accessibility changes.",
    observation_revision: { ...state.observation_revision, mode: count === 1 ? "full" : "no_change" },
  }) });
  const app = await computer.getApp("Fixture");
  await app.getState();
  const state = await app.getState();
  assert.equal(state.text, "No accessibility changes.");
  assert.equal(calls.at(-1).input.observationRevision.baseRevisionId, "r1");
  await app.click(37);
});

test("app and exact-window observations serialize one native cache while retaining separate cursors", async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const revisions = new Map();
  let active = 0;
  let maximumActive = 0;
  const { computer, calls } = fixture({ observe: async (input, state) => {
    const appContext = input.appContext === true;
    const projection = appContext ? "app" : "legacy";
    const stream = `${input.windowId}:${projection}`;
    const revision = (revisions.get(stream) ?? 0) + 1;
    revisions.set(stream, revision);
    const sameWindow = input.windowId === 7n;
    if (sameWindow) maximumActive = Math.max(maximumActive, ++active);
    try {
      if (sameWindow && appContext && revision === 1) {
        started.resolve();
        await release.promise;
      }
      return {
        ...state,
        tree_markdown: revision === 1 ? state.tree_markdown : "No accessibility changes.",
        observation_revision: {
          ...state.observation_revision,
          mode: revision === 1 ? "full" : "no_change",
          revision_id: `${projection}-r${revision}`,
        },
      };
    } finally {
      if (sameWindow) active -= 1;
    }
  } });
  const app = await computer.getApp("Fixture");
  const appFull = app.getState();
  await started.promise;
  const legacyFull = computer.observeWindow({ pid: 42, windowId: 7 });
  try {
    // A different window can reach the native driver while this window is held.
    // It also drains earlier unblocked observation work without a timed sleep.
    await computer.observeWindow({ pid: 42, windowId: 8 });
  } finally {
    release.resolve();
  }
  const full = await Promise.all([appFull, legacyFull]);
  assert.deepEqual(full.map((state) => state.mode), ["full", "full"]);
  assert.equal(maximumActive, 1);

  const unchanged = await Promise.all([
    app.getState(),
    computer.observeWindow({ pid: 42, windowId: 7 }),
  ]);
  assert.deepEqual(unchanged.map((state) => state.mode), ["no_change", "no_change"]);
  assert.equal(maximumActive, 1);
  const observations = calls.filter((call) => call.method === "getWindowState" && call.input.windowId === 7n);
  const appInputs = observations.filter((call) => call.input.appContext === true).map((call) => call.input.observationRevision);
  const legacyInputs = observations.filter((call) => call.input.appContext !== true).map((call) => call.input.observationRevision);
  assert.deepEqual(appInputs.map((revision) => revision.baseRevisionId), [undefined, "app-r1"]);
  assert.deepEqual(legacyInputs.map((revision) => revision.baseRevisionId), [undefined, "legacy-r1"]);
  assert.ok(appInputs.every((revision) => revision.projectionVersion === "app-tree-v1"));
  assert.ok(legacyInputs.every((revision) => revision.projectionVersion !== "app-tree-v1"));
});

test("app handle refresh forwards runningOnly to the native app query", async () => {
  const { computer, calls } = fixture();
  const app = await computer.getApp("Fixture");
  await app.getState();
  await app.pressKey("Return");
  await app.getState();
  assert.deepEqual(calls.filter((call) => call.method === "listApps").map((call) => call.input), [
    {},
    { runningOnly: true },
    { runningOnly: true },
    { runningOnly: true },
  ]);
});

test("app API rejects manually supplied targeting and routing options", async () => {
  const { computer, calls } = fixture();
  const app = await computer.getApp("Fixture");
  await app.getState();
  for (const key of ["deliveryMode", "delivery_mode", "foreground", "background", "pid", "windowId", "elementToken", "appContext"]) {
    assert.throws(() => app.click(37, { [key]: "untrusted" }), { code: "app_option_managed" });
  }
  assert.equal(calls.filter((call) => call.method === "windowClick").length, 0);
});

test("a structured pre-actuator refusal is returned without a foreground retry", async () => {
  let attempts = 0;
  const { computer, calls } = fixture({ action: () => {
    attempts += 1;
    return attempts === 1 ? result({ code: "same_pid_keyboard_ambiguity", effect: "refused", escalation: { recommended: "foreground" } }, { isError: true }) : result({ effect: "confirmed" });
  } });
  const app = await computer.getApp("Fixture");
  await app.getState();
  await assert.rejects(app.pressKey("Return"), { code: "same_pid_keyboard_ambiguity" });
  assert.equal(attempts, 1);
  assert.deepEqual(calls.filter((call) => call.method === "windowPressKey").map((call) => call.input.deliveryMode), ["background"]);
});

for (const effect of ["partial", "unverifiable", "suspected_noop"]) {
  test(`a ${effect} action is not replayed`, async () => {
    const { computer, calls } = fixture({ action: () => result({ effect }) });
    const app = await computer.getApp("Fixture");
    await app.getState();
    assert.deepEqual(await app.click(37), { effect });
    assert.equal(calls.filter((call) => call.method === "windowClick").length, 1);
  });
}

test("an action error with no pre-actuator proof is never replayed or exposed as a mode choice", async () => {
  const { computer, calls } = fixture({ action: () => result({ code: "background_unavailable" }, {
    isError: true, text: "Try delivery_mode foreground with pid 42 and window_id 7",
  }) });
  const app = await computer.getApp("Fixture");
  await app.getState();
  await assert.rejects(app.click(37), (error) => {
    assert.doesNotMatch(error.message, /delivery|foreground|pid|window_id/);
    return error.code === "background_unavailable";
  });
  assert.equal(calls.filter((call) => call.method === "windowClick").length, 1);
});

test("native compact diffs pass through without rewriting literal content", async () => {
  const text = '~ [37] TextField "Name" value="frame=1,2 <AXTextField>"\nRemoved IDs: [38]';
  const { computer } = fixture({ observe: (_input, state, count) => ({
    ...state,
    tree_markdown: count === 1 ? state.tree_markdown : text,
    observation_revision: { ...state.observation_revision, mode: count === 1 ? "full" : "diff" },
  }) });
  const app = await computer.getApp("Fixture");
  await app.getState();
  const state = await app.getState();
  assert.equal(state.mode, "diff");
  assert.equal(state.text, text);
});
