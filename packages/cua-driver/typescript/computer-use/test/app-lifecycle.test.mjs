import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUse } from "../index.js";

function result(structured, extra = {}) {
  return { text: "", images: [], structuredJson: JSON.stringify(structured), isError: false, ...extra };
}

const appRecord = { name: "Fixture", bundle_id: "org.example.fixture", launch_path: "/Owned/A/Fixture.app", pid: 42, running: true };

function session(name, { apps = [{ ...appRecord }], expireWindows = () => false, click, launch } = {}) {
  const mutations = [];
  const observations = [];
  const launches = [];
  return {
    mutations,
    observations,
    launches,
    async listToolsJson() { return JSON.stringify({ tools: [] }); },
    async listApps() {
      return result({ apps });
    },
    async launchApp(input) {
      launches.push(input);
      return launch ? launch(input) : result({});
    },
    async listWindows(input) {
      observations.push({ method: "listWindows", input });
      if (expireWindows()) {
        return result({ code: "authorization_context_expired" }, { isError: true });
      }
      return result({ windows: [{ window_id: input.pid + 100, title: `Document ${input.pid}`, z_index: 3, is_on_screen: true, is_app_target: true }] });
    },
    async getWindowState(input) {
      observations.push({ method: "getWindowState", input });
      return result({
        tree_markdown: '[37] Button "Save"',
        elements: [{ element_index: 2, element_id: 37, element_token: `rv1:${name}:91`, role: "AXButton" }],
      });
    },
    async windowClick(input) {
      mutations.push(input);
      return click ? click(input) : result({ effect: "confirmed" });
    },
  };
}

test("an explicit session replacement invalidates app element bindings", async () => {
  const first = session("first");
  const second = session("second");
  const computer = new ComputerUse(first, { ownsSession: true, sessionFactory: async () => second });
  const app = await computer.getApp("Fixture");
  await app.getState();
  await computer.reconnect();
  await assert.rejects(app.click(37), { code: "app_observation_required" });
  assert.equal(second.mutations.length, 0);
  await app.getState();
  await app.click(37);
  assert.equal(second.mutations[0].elementToken, "rv1:second:91");
});

test("distinct paths sharing a bundle ID retain distinct app handles and targets", async () => {
  const other = { ...appRecord, launch_path: "/Owned/B/Fixture.app", pid: 84 };
  const driver = session("first", { apps: [appRecord, other] });
  const computer = new ComputerUse(driver);
  const first = await computer.getApp(appRecord.launch_path);
  const second = await computer.getApp(other.launch_path);
  assert.notStrictEqual(first, second);
  assert.equal(first, await computer.getApp("/Owned/A/../A/Fixture.app/"));
  assert.equal((await first.getState()).window, "Document 42");
  assert.equal((await second.getState()).window, "Document 84");
  assert.deepEqual(driver.observations.filter((call) => call.method === "getWindowState").map((call) => call.input.pid), [42, 84]);
  assert.ok(driver.observations.every((call) => call.input.appContext === true));
});

test("a path-bound app cannot migrate to another installation after its process exits", async () => {
  const apps = [{ ...appRecord }, { ...appRecord, launch_path: "/Owned/B/Fixture.app", pid: 84 }];
  const driver = session("first", { apps });
  const computer = new ComputerUse(driver);
  const app = await computer.getApp(appRecord.launch_path);
  apps.splice(0, 1);
  await assert.rejects(app.getState(), { code: "app_not_running" });
  assert.equal(driver.observations.length, 0);
  assert.equal(driver.mutations.length, 0);
});

test("a restarted process at the same app path invalidates old element bindings", async () => {
  const apps = [{ ...appRecord }];
  const driver = session("first", { apps });
  const computer = new ComputerUse(driver);
  const app = await computer.getApp(appRecord.launch_path);
  await app.getState();
  apps[0].pid = 84;
  await assert.rejects(app.click(37), { code: "app_observation_required" });
  assert.equal(driver.mutations.length, 0);
  await app.getState();
  await app.click(37);
  assert.equal(driver.mutations[0].pid, 84);
  assert.equal(driver.mutations[0].windowId, 184n);
});

test("getApp only binds a stopped app; getState launches its canonical path and refreshes the PID", async () => {
  const apps = [{ ...appRecord, running: false, pid: null }];
  const driver = session("first", { apps, launch: () => {
    apps[0] = { ...appRecord, pid: 84 };
    return result({ pid: 999 });
  } });
  const computer = new ComputerUse(driver);
  const app = await computer.getApp("/Owned/A/../A/Fixture.app/");
  assert.equal(driver.launches.length, 0);
  assert.equal(driver.observations.length, 0);
  const state = await app.getState();
  assert.deepEqual(driver.launches, [{ name: appRecord.launch_path }]);
  assert.equal(state.window, "Document 84");
  assert.ok(driver.observations.every((call) => call.input.pid === 84));
  await app.getState();
  assert.equal(driver.launches.length, 1);
});

test("app actions never launch an app that exited after observation", async () => {
  const apps = [{ ...appRecord }];
  const driver = session("first", { apps });
  const computer = new ComputerUse(driver);
  const app = await computer.getApp(appRecord.launch_path);
  await app.getState();
  apps[0] = { ...appRecord, running: false, pid: null };
  for (const act of [() => app.click(37), () => app.pressKey("Return")]) {
    await assert.rejects(act(), { code: "app_not_running" });
  }
  assert.equal(driver.launches.length, 0);
  assert.equal(driver.mutations.length, 0);
  assert.equal(driver.observations.length, 2);
});

test("running and stopped installations with the same name remain ambiguous", async () => {
  const apps = [appRecord, { ...appRecord, launch_path: "/Owned/B/Fixture.app", running: false, pid: null }];
  const driver = session("first", { apps });
  const computer = new ComputerUse(driver);
  for (const selector of [appRecord.name, appRecord.bundle_id]) {
    await assert.rejects(computer.getApp(selector), { code: "app_ambiguous" });
  }
  assert.equal(driver.launches.length, 0);
  assert.equal(driver.observations.length, 0);
});

test("a session replacement during window revalidation must not dispatch an old element token", async () => {
  let expire = false;
  const first = session("first", { expireWindows: () => expire });
  const second = session("second");
  const computer = new ComputerUse(first, { ownsSession: true, sessionFactory: async () => second });
  const app = await computer.getApp("Fixture");
  await app.getState();
  expire = true;
  await assert.rejects(app.click(37), { code: "app_observation_required" });
  assert.equal(second.mutations.length, 0);
});

test("cancelling a dispatched app mutation waits for the native result and never replays", async () => {
  let begin;
  let finish;
  const started = new Promise((resolve) => { begin = resolve; });
  const terminal = new Promise((resolve) => { finish = resolve; });
  const driver = session("first", { click: () => { begin(); return terminal; } });
  const computer = new ComputerUse(driver);
  const app = await computer.getApp("Fixture");
  await app.getState();
  const controller = new AbortController();
  const pending = app.click(37, { signal: controller.signal });
  await started;
  controller.abort();
  finish(result({ effect: "partial" }));
  assert.deepEqual(await pending, { effect: "partial" });
  assert.equal(driver.mutations.length, 1);
});
