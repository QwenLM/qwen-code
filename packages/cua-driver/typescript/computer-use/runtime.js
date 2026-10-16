import { ComputerUse, ComputerUseError } from './index.js';
import { documentation } from './documentation.js';

export function createCua(runtime, { computer } = {}) {
  let connection = computer ? Promise.resolve(computer) : undefined;
  const handles = new WeakMap();
  const options = (value = {}) => ({ signal: runtime.signal, ...value });
  async function connected() {
    if (!connection) {
      connection = ComputerUse.create(options()).catch((error) => {
        connection = undefined;
        throw error;
      });
    }
    return connection;
  }

  function handle(app) {
    if (handles.has(app)) return handles.get(app);
    async function observe(kind, input = {}) {
      const { emit = true, forceFull, ...rest } = input;
      const state = await app.getState({
        ...options(rest),
        ...(forceFull === undefined ? {} : { disableDiff: forceFull }),
        includeScreenshot: kind !== 'ax',
      });
      const text = kind === 'screenshot'
        ? `${app.name}: screenshot of ${state.window}`
        : `${app.name} — ${state.window} (${state.mode})\n${state.text}`;
      if (kind !== 'ax' && !state.screenshot?.images.length) {
        throw new ComputerUseError('The window screenshot is unavailable. Observe AX state before continuing.', { code: 'screenshot_unavailable' });
      }
      if (emit) {
        runtime.write(text);
        for (const image of state.screenshot?.images ?? []) {
          await runtime.emitImage(`data:${image.mimeType};base64,${image.dataBase64}`);
        }
      }
      return text;
    }
    async function act(method, args) {
      const result = await app[method](...args);
      if (result?.effect === 'refused') {
        throw new ComputerUseError('The driver refused this action. Observe the app before choosing another action.', { code: 'action_refused' });
      }
      if (result?.effect && result.effect !== 'confirmed') {
        runtime.write('Sent but not confirmed. Observe the app state before retrying.');
      }
    }
    const wrapped = Object.freeze({
      name: app.name,
      getAXState: (input) => observe('ax', input),
      getScreenshot: (input) => observe('screenshot', input),
      getAXStateAndScreenshot: (input) => observe('both', input),
      click: (point, input) => act('click', [point, options(input)]),
      doubleClick: (point, input) => act('doubleClick', [point, options(input)]),
      rightClick: (point, input) => act('rightClick', [point, options(input)]),
      scroll: (point, input) => act('scroll', [point, options(input)]),
      drag: (input) => act('drag', [options(input)]),
      performSecondaryAction: (id, action, input) => act('performSecondaryAction', [id, action, options(input)]),
      setValue: (id, value, input) => act('setValue', [id, value, options(input)]),
      typeText: (text, input) => act('typeText', [text, options(input)]),
      paste: (text, input) => act('paste', [text, options(input)]),
      selectText: (id, text, input) => act('selectText', [id, text, options(input)]),
      pressKey: (key, input) => act('pressKey', [key, options(input)]),
      hotkey: (keys, input) => act('hotkey', [keys, options(input)]),
    });
    handles.set(app, wrapped);
    return wrapped;
  }

  return Object.freeze({
    rewriteDocumentation() {
      const text = documentation();
      runtime.write(text);
      return text;
    },
    async getState({ emit = true, ...input } = {}) {
      const api = await connected();
      const apps = await api.listApps(options(input));
      const windows = await api.listWindows(options(input));
      const text = JSON.stringify({ apps, windows });
      if (emit) runtime.write(text);
      return text;
    },
    async getApp(selector) {
      const app = handle(await (await connected()).getApp(selector, options()));
      await app.getAXState({ forceFull: true });
      return app;
    },
  });
}
