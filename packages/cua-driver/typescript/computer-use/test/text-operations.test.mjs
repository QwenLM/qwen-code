import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUse } from "../index.js";

const target = { pid: 42, windowId: 7 };
const elementTarget = { ...target, elementToken: "rv1:window7:retained", text: " target_😀 " };
const numericSdk = {
  PasteFormat: { Text: 0, Md: 1, Html: 2 },
  TextSelection: { Text: 0, CursorBefore: 1, CursorAfter: 2 },
};

function result(structured, extra = {}) {
  return { text: "", structuredJson: JSON.stringify(structured), images: [], isError: false, ...extra };
}

function fixture({ sdk = {}, platform = "macos", action, reconnectable = false } = {}) {
  const calls = [];
  const apps = [{ name: "Text Fixture", bundle_id: "org.example.text-fixture", launch_path: "/Applications/TextFixture.app", pid: 42, running: true }];
  const windows = [{ window_id: 7, title: "Owned document", is_app_target: true }];
  let revision = 0;
  let reconnects = 0;
  const owner = {
    async listToolsJson() {
      calls.push({ method: "listToolsJson" });
      return JSON.stringify({ platform, tools: [{ name: "get_window_state", capabilities: ["accessibility.observation_revision.v1"] }] });
    },
  };
  const driver = {
    async listApps(input) { calls.push({ method: "listApps", input }); return result({ apps }); },
    async listWindows(input) { calls.push({ method: "listWindows", input }); return result({ windows }); },
    async getWindowState(input) {
      calls.push({ method: "getWindowState", input });
      revision += 1;
      return result({
        tree_markdown: '[37] TextArea " target_😀 "',
        elements: [{ element_id: 37, element_index: 4, element_token: `rv1:window${input.windowId}:retained`, role: "AXTextArea" }],
        observation_revision: { mode: "full", lineage_id: `window${input.windowId}`, revision_id: `r${revision}`, stable_element_ids: true, capture_complete: true },
      });
    },
  };
  for (const method of ["paste", "selectText"]) {
    driver[method] = async (input) => {
      calls.push({ method, input });
      return action ? action(method, input) : result({ effect: "confirmed" });
    };
  }
  const computer = new ComputerUse(driver, {
    owner,
    sdk,
    ...(reconnectable ? { ownsSession: true, sessionFactory: () => { reconnects += 1; return driver; } } : {}),
  });
  return {
    computer, calls, windows, apps,
    mutations: () => calls.filter(({ method }) => ["paste", "selectText"].includes(method)),
    reconnects: () => reconnects,
  };
}

for (const sdk of [{}, numericSdk]) {
  test(`exact-window text methods preserve content and serialize ${sdk === numericSdk ? "numeric" : "fallback"} enums`, async () => {
    const { computer, mutations } = fixture({ sdk });
    for (const [index, format] of ["text", "md", "html"].entries()) {
      const output = await computer.paste({ ...target, text: " 前_😀\n后 ", format });
      assert.equal(output.effect, "confirmed");
      assert.deepEqual(mutations().at(-1).input, {
        pid: 42, windowId: 7n, text: " 前_😀\n后 ", format: sdk === numericSdk ? index : format,
      });
    }
    for (const [index, selection] of ["text", "cursor_before", "cursor_after"].entries()) {
      await computer.selectText({ ...elementTarget, prefix: "前 ", suffix: " 后", selection });
      assert.deepEqual(mutations().at(-1).input, {
        pid: 42, windowId: 7n, elementToken: elementTarget.elementToken,
        text: elementTarget.text, prefix: "前 ", suffix: " 后",
        selection: sdk === numericSdk ? index : selection,
      });
    }
    await computer.paste({ ...target, text: "" });
    assert.equal(mutations().at(-1).input.format, sdk === numericSdk ? 0 : "text");
    await computer.selectText({ ...elementTarget, prefix: "", suffix: "" });
    assert.equal(mutations().at(-1).input.selection, sdk === numericSdk ? 0 : "text");
    assert.equal(mutations().at(-1).input.prefix, "");
    assert.equal(mutations().at(-1).input.suffix, "");
  });
}

test("app text methods bind observed IDs and route paste through app context", async () => {
  const { computer, mutations } = fixture({ sdk: numericSdk });
  const app = await computer.getApp("Text Fixture");
  await app.getState();
  assert.deepEqual(await app.selectText(37, " target_😀 ", { prefix: "前", suffix: "后", selection: "cursor_after" }), { effect: "confirmed" });
  await app.paste("<b>new</b>", { format: "html" });
  assert.deepEqual(mutations().map(({ input }) => input), [
    { pid: 42, windowId: 7n, elementToken: "rv1:window7:retained", text: " target_😀 ", prefix: "前", suffix: "后", selection: 2 },
    { pid: 42, windowId: 7n, text: "<b>new</b>", format: 2, appContext: true },
  ]);
});

test("selectText refuses a stale app window before dispatch and accepts the refreshed token", async () => {
  const { computer, windows, mutations } = fixture();
  const app = await computer.getApp("Text Fixture");
  await app.getState();
  windows[0] = { window_id: 9, title: "New dialog", is_app_target: true };
  await assert.rejects(app.selectText(37, "target"), { code: "app_observation_required" });
  assert.equal(mutations().length, 0);
  await app.getState();
  await app.selectText(37, "target");
  assert.equal(mutations()[0].input.windowId, 9n);
  assert.equal(mutations()[0].input.elementToken, "rv1:window9:retained");
});

test("selectText invalidates observed IDs after the owning process changes", async () => {
  const { computer, apps, mutations } = fixture();
  const app = await computer.getApp("Text Fixture");
  await app.getState();
  apps[0].pid = 84;
  await assert.rejects(app.selectText(37, "target"), { code: "app_observation_required" });
  assert.equal(mutations().length, 0);
});

test("app queue finishes selection before dispatching a concurrent paste", async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { computer, mutations } = fixture({
    action: async (method) => {
      if (method === "selectText") {
        started.resolve();
        await release.promise;
      }
      return result({ effect: "confirmed" });
    },
  });
  const app = await computer.getApp("Text Fixture");
  await app.getState();
  const selection = app.selectText(37, "target");
  const paste = app.paste("replacement");
  await started.promise;
  assert.deepEqual(mutations().map(({ method }) => method), ["selectText"]);
  release.resolve();
  await Promise.all([selection, paste]);
  assert.deepEqual(mutations().map(({ method }) => method), ["selectText", "paste"]);
});

test("invalid exact-window text inputs cannot dispatch or inspect platform metadata", async () => {
  const { computer, calls } = fixture();
  const invalid = [
    () => computer.paste({ text: "x" }),
    () => computer.paste({ ...target, text: 1 }),
    () => computer.paste({ ...target, text: "x", format: "rtf" }),
    () => computer.paste({ ...target, text: "x", format: ["text"] }),
    () => computer.selectText({ ...target, text: "x" }),
    () => computer.selectText({ ...elementTarget, windowId: undefined }),
    () => computer.selectText({ ...elementTarget, text: "" }),
    () => computer.selectText({ ...elementTarget, text: 1 }),
    () => computer.selectText({ ...elementTarget, prefix: 1 }),
    () => computer.selectText({ ...elementTarget, suffix: [] }),
    () => computer.selectText({ ...elementTarget, selection: "all" }),
    () => computer.selectText({ ...elementTarget, selection: ["text"] }),
    () => computer.selectText({ ...elementTarget, x: 2, y: 3 }),
  ];
  for (const operation of invalid) {
    await assert.rejects(operation);
  }
  assert.deepEqual(calls, []);
});

test("app text methods reject managed targeting/routing options and unavailable IDs", async () => {
  const { computer, mutations } = fixture();
  const app = await computer.getApp("Text Fixture");
  await assert.rejects(app.selectText(37, "target"), { code: "app_observation_required" });
  await app.getState();
  for (const key of ["pid", "windowId", "elementToken", "deliveryMode", "delivery_mode", "foreground", "background", "appContext"]) {
    assert.throws(() => app.paste("x", { [key]: "not accepted" }), { code: "app_option_managed" });
    assert.throws(() => app.selectText(37, "target", { [key]: "not accepted" }), { code: "app_option_managed" });
  }
  await assert.rejects(app.selectText(999, "target"), { code: "app_element_unavailable" });
  await assert.rejects(app.selectText({ x: 1, y: 2 }, "target"), { code: "app_element_required" });
  assert.equal(mutations().length, 0);
});

for (const platform of ["windows", "linux"]) {
  test(`text methods refuse a ${platform} driver without native mutation`, async () => {
    const { computer, mutations, calls } = fixture({ platform });
    await assert.rejects(computer.paste({ ...target, text: "x" }), { code: "unsupported_platform" });
    await assert.rejects(computer.selectText(elementTarget), { code: "unsupported_platform" });
    assert.equal(mutations().length, 0);
    assert.equal(calls.filter(({ method }) => method === "getWindowState").length, 0);
  });
}

for (const method of ["paste", "selectText"]) {
  test(`failed ${method} mutations never reconnect or replay`, async () => {
    const { computer, mutations, reconnects } = fixture({
      reconnectable: true,
      action: () => result({}, { isError: true, errorCode: "session_unavailable", text: "could not confirm the text operation" }),
    });
    const app = await computer.getApp("Text Fixture");
    await app.getState();
    const operation = method === "paste" ? app.paste("new") : app.selectText(37, "target");
    await assert.rejects(operation, { code: "session_unavailable" });
    assert.equal(mutations().length, 1);
    assert.equal(reconnects(), 0);
    await app.getState();
    assert.equal(mutations().length, 1);
  });
}

test("unconfirmed text effects stay visible without retrying the mutation", async () => {
  const { computer, mutations } = fixture({
    action: () => result({}, { action: { effect: 2 } }),
  });
  const app = await computer.getApp("Text Fixture");
  await app.getState();
  assert.deepEqual(await app.selectText(37, "target"), { effect: "unverifiable" });
  assert.deepEqual(await app.paste("new"), { effect: "unverifiable" });
  assert.equal(mutations().length, 2);
});

test("pre-cancelled text operations dispatch no platform query or mutation", async () => {
  const { computer, calls } = fixture();
  const signal = AbortSignal.abort();
  await assert.rejects(computer.paste({ ...target, text: "new", signal }), { code: "call_cancelled" });
  await assert.rejects(computer.selectText({ ...elementTarget, signal }), { code: "call_cancelled" });
  assert.deepEqual(calls, []);
});
