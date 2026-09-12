import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUse, ComputerUseError } from "../index.js";

function fixture(listToolsJson) {
  const owner = { listToolsJson };
  const session = {
    getWindowState() { throw new Error("platform lookup must not observe the desktop"); },
    listToolsJson() { throw new Error("platform lookup must use the owner"); },
  };
  return { computer: new ComputerUse(session, { owner }), owner };
}

for (const platform of ["macos", "windows", "linux"]) {
  test(`platform comes from the connected owner: ${platform}`, async () => {
    let calls = 0;
    const { computer, owner } = fixture(function () {
      assert.equal(this, owner);
      calls += 1;
      return JSON.stringify({ platform, tools: [{ name: "not-model-output" }] });
    });
    assert.equal(await computer.getPlatform(), platform);
    assert.equal(calls, 1);
  });
}

test("platform metadata is refreshed instead of cached across owner changes", async () => {
  let platform = "windows";
  const { computer } = fixture(() => JSON.stringify({ platform }));
  assert.equal(await computer.getPlatform(), "windows");
  platform = "linux";
  assert.equal(await computer.getPlatform(), "linux");
});

for (const raw of ["{}", "null", "{", '{"platform":"darwin"}', '{"platform":42}']) {
  test(`missing or invalid metadata refuses without a host fallback: ${raw}`, async () => {
    const { computer } = fixture(() => raw);
    await assert.rejects(computer.getPlatform(), {
      name: "ComputerUseError",
      code: "driver_platform_unavailable",
    });
  });
}

test("an older owner without platform inventory fails explicitly", async () => {
  const { computer } = fixture(undefined);
  await assert.rejects(computer.getPlatform(), {
    name: "ComputerUseError",
    code: "driver_platform_unavailable",
  });
});

test("backend failure propagates without changing the selected desktop", async () => {
  const error = new ComputerUseError("daemon unavailable", { code: "transport_failed" });
  const { computer } = fixture(() => { throw error; });
  await assert.rejects(computer.getPlatform(), (actual) => actual === error);
});

test("closed and pre-cancelled calls do not query the driver", async () => {
  let calls = 0;
  const { computer } = fixture(() => {
    calls += 1;
    return '{"platform":"macos"}';
  });
  await assert.rejects(computer.getPlatform({ signal: AbortSignal.abort() }), {
    code: "call_cancelled",
  });
  await assert.rejects(computer.getPlatform({ signal: {} }), /AbortSignal/);
  await computer.close();
  await assert.rejects(computer.getPlatform(), /closed/);
  assert.equal(calls, 0);
});

test("dispatched metadata registers the native terminal promise with cancellation", async () => {
  let finish;
  let waited;
  const controller = new AbortController();
  controller.signal.waitUntil = (promise) => {
    waited = promise;
    return promise;
  };
  const native = new Promise((resolve) => { finish = resolve; });
  const { computer } = fixture(() => native);
  const result = computer.getPlatform({ signal: controller.signal });
  assert.equal(waited, native);
  controller.abort();
  finish('{"platform":"linux"}');
  assert.equal(await result, "linux");
});
