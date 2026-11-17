import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const require = createRequire(import.meta.url);

async function fixture(t) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'cua-paste-host-bridge-'),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'native'));
  writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  // Exercise the shipped wrappers unchanged, replacing only native dependencies.
  for (const name of ['index.js', 'native/node-runtime.js']) {
    copyFileSync(path.join(dist, name), path.join(directory, name));
  }
  writeFileSync(
    path.join(directory, 'native-assets.js'),
    `
    import { fileURLToPath } from 'node:url';
    export const resolveCuaSdkRuntimePath = () => fileURLToPath(new URL('./runtime.cjs', import.meta.url));
    export const resolveCuaSdkLibraryPath = () => 'unused-native-library';
  `,
  );
  writeFileSync(
    path.join(directory, 'runtime.cjs'),
    `
    const { isMainThread } = require('node:worker_threads');
    exports.state = { pumps: 0 };
    exports.UniffiNativeModule = {};
    exports.pumpMainRunLoop = () => {
      if (!isMainThread) throw new Error('macOS paste requires the Node main thread');
      exports.state.pumps++;
    };
  `,
  );
  writeFileSync(
    path.join(directory, 'native/cua_driver_sdk.js'),
    `
    export const state = {
      calls: [],
      nativeUsers: 0,
      hostAvailable: false,
      operation: () => Promise.resolve('completed'),
      construct: () => { state.nativeUsers++; return new CuaDriver(); },
      setHost: (available) => {
        const previous = state.hostAvailable;
        state.hostAvailable = available;
        return previous;
      },
    };
    export const nativeUiNeedsPump = () => state.nativeUsers > 0;
    export const setNativeUiHostAvailable = (available) => state.setHost(available);
    function construct(method, args) {
      state.calls.push({ method, args, hostAvailable: state.hostAvailable });
      return state.construct();
    }
    function dispatch(receiver, method, args) {
      state.calls.push({ receiver, method, args });
      return state.operation();
    }
    export class CuaDriver {
      static createWithClientKind(...args) { return construct('create', args); }
      static createConfiguredWithClientKind(...args) { return construct('configured', args); }
      static createConfiguredWithAuthorizationHostAndClientKind(...args) { return construct('authorization', args); }
      static createConfiguredWithActivityObserverAndClientKind(...args) { return construct('observer', args); }
      static createConfiguredWithHostIntegrationsAndClientKind(...args) { return construct('integrations', args); }
      paste(...args) { return dispatch(this, 'paste', args); }
      callTool(...args) { return dispatch(this, 'callTool', args); }
    }
    export class CuaDriverSession {
      paste(...args) { return dispatch(this, 'paste', args); }
      callTool(...args) { return dispatch(this, 'callTool', args); }
    }
    export const SdkClientKind = { Typescript: 1 };
  `,
  );
  writeFileSync(
    path.join(directory, 'native/index.js'),
    `
    export * from './cua_driver_sdk.js';
    import * as cua_driver_sdk from './cua_driver_sdk.js';
    export default { cua_driver_sdk };
  `,
  );
  const sdk = await import(pathToFileURL(path.join(directory, 'index.js')));
  return {
    directory,
    sdk,
    native: require(path.join(directory, 'runtime.cjs')),
  };
}

function trackTimers(t) {
  const setInterval = globalThis.setInterval;
  const clearInterval = globalThis.clearInterval;
  const timers = new Map();
  globalThis.setInterval = (callback, delay) => {
    const entry = { callback, delay, unrefs: 0 };
    const handle = {
      unref() {
        entry.unrefs++;
        return handle;
      },
    };
    timers.set(handle, entry);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    assert.equal(timers.delete(handle), true);
  };
  t.after(() => {
    globalThis.setInterval = setInterval;
    globalThis.clearInterval = clearInterval;
  });
  return timers;
}

for (const className of ['CuaDriver', 'CuaDriverSession']) {
  for (const method of ['paste', 'callTool']) {
    const input = { pid: 123, windowId: 456, text: 'test', format: 1 };
    const nativeArgs = method === 'paste' ? [input] : ['paste', '{}'];
    const invoke = (receiver, options) =>
      receiver[method](...nativeArgs, options);

    test(`${className}.${method} rejects preabort before native dispatch or pumping`, async (t) => {
      const { sdk, native } = await fixture(t);
      const reason = new Error('already aborted');
      await assert.rejects(
        invoke(new sdk[className](), { signal: AbortSignal.abort(reason) }),
        (error) => error === reason,
      );
      assert.equal(sdk.state.calls.length, 0);
      assert.equal(native.state.pumps, 0);
    });

    test(`${className}.${method} keeps pumping until cleanup after cancellation`, async (t) => {
      const { sdk, native } = await fixture(t);
      const timers = trackTimers(t);
      let finish;
      sdk.state.operation = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      const receiver = new sdk[className]();
      const controller = new AbortController();
      let settled = false;
      const completion = invoke(receiver, { signal: controller.signal }).then(
        (result) => {
          settled = true;
          return result;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      assert.equal(sdk.state.calls.length, 1);
      assert.equal(sdk.state.calls[0].receiver, receiver);
      assert.deepEqual(sdk.state.calls[0].args, nativeArgs);
      assert.equal(native.state.pumps, 1);
      assert.equal(timers.size, 1);
      const timer = [...timers.values()][0];
      assert.equal(timer.delay, 10);
      const reason = new Error('cancelled during cleanup');
      controller.abort(reason);
      await Promise.resolve();
      assert.equal(settled, false);
      timer.callback();
      assert.equal(native.state.pumps, 2);
      assert.equal(timers.size, 1);
      finish('clipboard cleanup completed');
      assert.equal(await completion, reason);
      assert.equal(timers.size, 0);
      assert.equal(sdk.state.calls.length, 1);
    });

    test(`${className}.${method} clears the pump after success or native failure`, async (t) => {
      const { sdk } = await fixture(t);
      const timers = trackTimers(t);
      const receiver = new sdk[className]();
      for (const mode of ['success', 'throw', 'reject']) {
        const failure = new Error(mode);
        sdk.state.operation = () => {
          if (mode === 'throw') throw failure;
          return mode === 'reject'
            ? Promise.reject(failure)
            : Promise.resolve('done');
        };
        if (mode === 'success') assert.equal(await invoke(receiver), 'done');
        else
          await assert.rejects(invoke(receiver), (error) => error === failure);
        assert.equal(timers.size, 0);
      }
      assert.equal(sdk.state.calls.length, 3);
    });
  }

  test(`${className}.callTool preserves other tools' cancellation and skips pumping`, async (t) => {
    const { sdk, native } = await fixture(t);
    const options = { signal: new AbortController().signal };
    assert.equal(
      await new sdk[className]().callTool('health_report', '{}', options),
      'completed',
    );
    assert.deepEqual(sdk.state.calls[0].args, ['health_report', '{}', options]);
    assert.equal(native.state.pumps, 0);
  });
}

test('root default exports use the same wrapped driver and session', async (t) => {
  const { sdk } = await fixture(t);
  assert.equal(sdk.default.cua_driver_sdk.CuaDriver, sdk.CuaDriver);
  assert.equal(
    sdk.default.cua_driver_sdk.CuaDriverSession,
    sdk.CuaDriverSession,
  );
});

for (const [factory, method, args] of [
  ['create', 'create', [{}]],
  ['createConfigured', 'configured', [{}]],
  [
    'createConfiguredWithAuthorizationHost',
    'authorization',
    [{}, { host: true }],
  ],
  [
    'createConfiguredWithActivityObserver',
    'observer',
    [{}, { observer: true }],
  ],
  [
    'createConfiguredWithHostIntegrations',
    'integrations',
    [{}, { host: true }, { observer: true }],
  ],
]) {
  test(`${factory} keeps one unref pump until the native UI lease ends`, async (t) => {
    const { sdk } = await fixture(t);
    const timers = trackTimers(t);
    sdk.CuaDriver[factory](...args);
    assert.deepEqual(sdk.state.calls, [
      {
        method,
        args: [...args, sdk.SdkClientKind.Typescript],
        hostAvailable: true,
      },
    ]);
    assert.equal(sdk.state.hostAvailable, false);
    assert.equal(timers.size, 1);
    const timer = [...timers.values()][0];
    assert.equal(timer.unrefs, 1);
    timer.callback();
    assert.equal(timers.size, 1);
    sdk.state.nativeUsers = 0;
    timer.callback();
    assert.equal(timers.size, 0);
  });
}

test('multiple native owners share the pump and can recreate it after teardown', async (t) => {
  const { sdk } = await fixture(t);
  const timers = trackTimers(t);
  sdk.CuaDriver.createConfigured({});
  sdk.CuaDriver.createConfigured({});
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0];
  sdk.state.nativeUsers--;
  timer.callback();
  assert.equal(timers.size, 1);
  sdk.state.nativeUsers--;
  timer.callback();
  assert.equal(timers.size, 0);
  sdk.CuaDriver.createConfigured({});
  assert.equal(timers.size, 1);
  sdk.state.nativeUsers = 0;
  [...timers.values()][0].callback();
  assert.equal(timers.size, 0);
});

test('constructor failure releases its temporary lease without stopping another owner', async (t) => {
  const { sdk } = await fixture(t);
  const timers = trackTimers(t);
  const failure = new Error('constructor failed');
  sdk.state.construct = () => {
    throw failure;
  };
  assert.throws(
    () => sdk.CuaDriver.createConfigured({}),
    (error) => error === failure,
  );
  assert.equal(timers.size, 0);
  assert.equal(sdk.state.hostAvailable, false);
  sdk.state.nativeUsers = 1;
  assert.throws(
    () => sdk.CuaDriver.createConfigured({}),
    (error) => error === failure,
  );
  assert.equal(timers.size, 1);
  assert.equal(sdk.state.hostAvailable, false);
  sdk.state.nativeUsers = 0;
  [...timers.values()][0].callback();
  assert.equal(timers.size, 0);
});

test('nested constructors restore their enclosing trusted UI host scope', async (t) => {
  const { sdk } = await fixture(t);
  const timers = trackTimers(t);
  let depth = 0;
  sdk.state.construct = () => {
    assert.equal(sdk.state.hostAvailable, true);
    if (depth++ === 0) {
      sdk.CuaDriver.createConfigured({ nested: true });
      assert.equal(sdk.state.hostAvailable, true);
    }
    sdk.state.nativeUsers++;
    return new sdk.CuaDriver();
  };
  sdk.CuaDriver.createConfigured({});
  assert.equal(sdk.state.hostAvailable, false);
  assert.equal(timers.size, 1);
  sdk.state.nativeUsers = 0;
  [...timers.values()][0].callback();
  assert.equal(timers.size, 0);
});

test('host setter failures still release the temporary pump', async (t) => {
  const { sdk } = await fixture(t);
  const timers = trackTimers(t);
  const failure = new Error('host setter failed');
  sdk.state.setHost = () => {
    throw failure;
  };
  assert.throws(
    () => sdk.CuaDriver.createConfigured({}),
    (error) => error === failure,
  );
  assert.equal(sdk.state.calls.length, 0);
  assert.equal(timers.size, 0);
  sdk.state.setHost = (available) => {
    const previous = sdk.state.hostAvailable;
    sdk.state.hostAvailable = available;
    if (!available) throw failure;
    return previous;
  };
  assert.throws(
    () => sdk.CuaDriver.createConfigured({}),
    (error) => error === failure,
  );
  assert.equal(sdk.state.hostAvailable, false);
  sdk.state.nativeUsers = 0;
  [...timers.values()][0].callback();
  assert.equal(timers.size, 0);
});

test('concurrent paste cleanup shares a temporary pump with the native owner', async (t) => {
  const { sdk } = await fixture(t);
  const timers = trackTimers(t);
  sdk.CuaDriver.createConfigured({});
  const pending = [];
  sdk.state.operation = () => new Promise((resolve) => pending.push(resolve));
  const first = new sdk.CuaDriver().paste({});
  const second = new sdk.CuaDriverSession().paste({});
  assert.equal(timers.size, 1);
  sdk.state.nativeUsers = 0;
  pending[0]('first');
  assert.equal(await first, 'first');
  assert.equal(timers.size, 1);
  pending[1]('second');
  assert.equal(await second, 'second');
  assert.equal(timers.size, 0);
});

test(
  'a native main-thread refusal prevents Worker paste dispatch and timer creation',
  { timeout: 10_000 },
  async (t) => {
    const { directory } = await fixture(t);
    const workerPath = path.join(directory, 'worker.mjs');
    writeFileSync(
      workerPath,
      `
    import assert from 'node:assert/strict';
    import { parentPort } from 'node:worker_threads';
    import * as sdk from './index.js';
    let timers = 0;
    globalThis.setInterval = () => { timers++; };
    for (const Class of [sdk.CuaDriver, sdk.CuaDriverSession]) {
      const receiver = new Class();
      await assert.rejects(receiver.paste({}), /requires the Node main thread/);
      await assert.rejects(receiver.callTool('paste', '{}'), /requires the Node main thread/);
    }
    assert.throws(() => sdk.CuaDriver.createConfigured({}), /requires the Node main thread/);
    assert.equal(sdk.state.calls.length, 0);
    assert.equal(timers, 0);
    parentPort.postMessage('refused before dispatch');
  `,
    );
    const worker = new Worker(pathToFileURL(workerPath));
    t.after(() => worker.terminate());
    assert.equal(
      await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once(
          'exit',
          (code) => code && reject(new Error(`worker exited ${code}`)),
        );
      }),
      'refused before dispatch',
    );
  },
);
