import { ComputerUse } from './index.js';
import { documentation } from './documentation.js';
import { createBrowserFacade } from './browser.js';

export function createCua(runtime, { computer, browserModule } = {}) {
  const browser = createBrowserFacade(runtime, browserModule && (() => Promise.resolve(browserModule)));
  let closed = false;
  let connection = computer ? Promise.resolve(computer) : undefined;
  const handles = new WeakMap();
  const options = (value = {}) => ({ signal: runtime.signal, ...value });
  const parameters = (input = {}) => Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== 'signal' && key !== 'emit')
      .map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]),
  );
  const point = (value) => typeof value === 'number' ? { element: value } : value;
  async function connected() {
    if (closed) throw new Error('Computer Use session is closed.');
    if (!connection) {
      connection = ComputerUse.create(options()).catch((error) => {
        connection = undefined;
        throw error;
      });
    }
    return connection;
  }
  async function display(result, emit = true) {
    if (emit) {
      if (result.text) runtime.write(result.text);
      for (const image of result.images) {
        await runtime.emitImage(`data:${image.mimeType};base64,${image.dataBase64}`);
      }
    }
    return result.text;
  }
  function handle(app) {
    if (handles.has(app)) return handles.get(app);
    async function observe(name, input = {}) {
      const result = await app.call(name, parameters(input), { ...options(input), readOnly: true });
      return display(result, input.emit !== false);
    }
    async function act(name, args, input = {}) {
      await display(await app.call(name, { ...parameters(input), ...args }, options(input)));
    }
    const wrapped = Object.freeze({
      name: app.name,
      getAXState: (input) => observe('get_ax_state', input),
      getScreenshot: (input) => observe('get_screenshot', input),
      getAXStateAndScreenshot: (input) => observe('get_ax_state_and_screenshot', input),
      click: (target, input) => act('click', point(target), input),
      doubleClick: (target, input) => act('double_click', point(target), input),
      rightClick: (target, input) => act('right_click', point(target), input),
      scroll: (target, input) => act('scroll', point(target), input),
      drag: (input) => act('drag', {}, input),
      performSecondaryAction: (element, action, input) => act('perform_secondary_action', { element, action }, input),
      setValue: (element, value, input) => act('set_value', { element, value }, input),
      typeText: (text, input) => act('type_text', { text }, input),
      paste: (text, input) => act('paste', { text }, input),
      selectText: (element, text, input) => act('select_text', { element, text }, input),
      pressKey: (key, input) => act('press_key', { key }, input),
      hotkey: (keys, input) => act('hotkey', { keys }, input),
    });
    handles.set(app, wrapped);
    return wrapped;
  }
  let desktopTail = Promise.resolve();
  function desktopCall(name, args, input = {}) {
    const next = desktopTail.catch(() => {}).then(async () => {
      const result = await (await connected()).appCall(name, { ...parameters(input), ...args, scope: 'desktop' }, options(input));
      const text = await display(result, input.emit !== false);
      return name === 'get_screenshot' ? text : undefined;
    });
    desktopTail = next;
    return next;
  }
  const desktop = Object.freeze({
    getScreenshot: (input) => desktopCall('get_screenshot', {}, input),
    click: (target, input) => desktopCall('click', target, input),
    doubleClick: (target, input) => desktopCall('double_click', target, input),
    rightClick: (target, input) => desktopCall('right_click', target, input),
    scroll: (target, input) => desktopCall('scroll', target, input),
    drag: (input) => desktopCall('drag', {}, input),
    typeText: (text, input) => desktopCall('type_text', { text }, input),
    pressKey: (key, input) => desktopCall('press_key', { key }, input),
    hotkey: (keys, input) => desktopCall('hotkey', { keys }, input),
    keyDown: (key, input) => desktopCall('key_down', { key }, input),
    keyUp: (key, input) => desktopCall('key_up', { key }, input),
  });
  return Object.freeze({
    desktop,
    getBrowser: browser.getBrowser,
    getTab: browser.getTab,
    createBrowserTab: browser.createBrowserTab,
    async [Symbol.asyncDispose]() {
      if (closed) return;
      closed = true;
      try {
        await desktopTail.catch(() => {});
        if (connection) await (await connection.catch(() => undefined))?.close();
      } finally {
        await browser.close();
      }
    },
    rewriteDocumentation() {
      const text = documentation();
      runtime.write(text);
      return text;
    },
    async getState({ emit = true, ...input } = {}) {
      return display(await (await connected()).getState(options(input)), emit);
    },
    async getApp(selector) {
      const { app, initial } = await (await connected()).getApp(selector, options());
      await display(initial);
      return handle(app);
    },
  });
}
