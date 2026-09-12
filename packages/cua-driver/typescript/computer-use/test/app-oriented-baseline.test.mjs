import assert from "node:assert/strict";
import { test } from "node:test";

const { ComputerUse } = await import(
  process.env.CUA_BASELINE_MODULE ?? "../index.js"
);

const token = "rv1:l_baseline_observation:71";
const nativeText = `Window: "Disposable fixture"\n0 AXWindow enabled=true frame=(0,0,640,480)\n  Static text: Keep \"value=7\" verbatim\n  71 AXTextField element_token=${token} value="draft" enabled=true frame=(10,20,100,24)`;

function result(structured, extra = {}) {
  return {
    text: "",
    images: [],
    structuredJson: JSON.stringify(structured),
    rawJson: "{}",
    isError: false,
    ...extra,
  };
}

function fixture(action) {
  const calls = [];
  const driver = {
    async listToolsJson() {
      return JSON.stringify({ tools: [] });
    },
    async getWindowState(input) {
      calls.push({ method: "getWindowState", input });
      return result({
        tree_markdown: nativeText,
        elements: [{ element_index: 71, element_token: token, role: "AXTextField" }],
      });
    },
    async windowClick(input) {
      calls.push({ method: "windowClick", input });
      return action ? action(input) : result({ status: "ok" });
    },
  };
  const computer = new ComputerUse(driver, {
    sdk: {
      ClickButton: { Left: "left", Right: "right", Middle: "middle" },
      DeliveryMode: { Background: "background", Foreground: "foreground" },
    },
  });
  return { computer, calls };
}

test("requested model API exposes an application handle entry point", () => {
  const { computer } = fixture();
  assert.equal(typeof computer.getApp, "function");
});

test("legacy observation requires an explicit native process/window target", async () => {
  const { computer, calls } = fixture();
  await assert.rejects(computer.observeWindow({}), /pid/i);
  assert.equal(calls.length, 0);
  await computer.observeWindow({ pid: 42, windowId: 7 });
  assert.deepEqual(
    { pid: calls[0].input.pid, windowId: calls[0].input.windowId },
    { pid: 42, windowId: 7n },
  );
});

test("legacy observation passes native AX text and opaque tokens through", async () => {
  const { computer } = fixture();
  const observed = await computer.observeWindow({ pid: 42, windowId: 7 });
  assert.equal(observed.text, nativeText);
  assert.equal(observed.elements[0].element_token, token);
});

test("legacy actions expose token identity and explicit delivery selection", async () => {
  const { computer, calls } = fixture();
  await computer.click({ pid: 42, elementToken: token, deliveryMode: "foreground" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.pid, 42);
  assert.equal(calls[0].input.elementToken, token);
  assert.equal(calls[0].input.deliveryMode, "foreground");
});

for (const effect of ["partial", "unverifiable"]) {
  test(`legacy action never replays a ${effect} terminal outcome`, async () => {
    const { computer, calls } = fixture(() => result({}, { action: { effect } }));
    await computer.click({ pid: 42, elementToken: token });
    assert.equal(calls.filter((call) => call.method === "windowClick").length, 1);
  });
}

test("legacy action waits for its terminal result after cancellation and does not replay", async () => {
  let finish;
  let started;
  const dispatched = new Promise((resolve) => { started = resolve; });
  const terminal = new Promise((resolve) => { finish = resolve; });
  const { computer, calls } = fixture(() => { started(); return terminal; });
  const controller = new AbortController();
  const pending = computer.click({ pid: 42, elementToken: token, signal: controller.signal });
  await dispatched;
  controller.abort();
  finish(result({}, { action: { effect: "unverifiable" } }));
  await pending;
  assert.equal(calls.filter((call) => call.method === "windowClick").length, 1);
});
