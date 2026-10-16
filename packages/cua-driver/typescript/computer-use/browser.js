export function createBrowserFacade(runtime, load = () => import('@qwen-code/browser-use')) {
  let module;
  let agent;
  let closed = false;
  const browsers = new Map();
  async function connected() {
    if (closed) throw new Error('Computer Use browser session is closed.');
    const loaded = module ?? await load();
    if (closed) throw new Error('Computer Use browser session is closed.');
    module = loaded;
    return (agent ??= await module.setupBrowserRuntime());
  }
  async function getBrowser(selector) {
    const current = await connected();
    const inventory = await current.browsers.list();
    const id = typeof selector === 'string' ? selector : selector?.id;
    const matches = inventory.filter((browser) => id === undefined || browser.id === id || browser.name === id);
    if (matches.length !== 1) {
      throw new Error(`Select one exact browser ID or name. Available browsers: ${JSON.stringify(inventory)}`);
    }
    const info = matches[0];
    if (!browsers.has(info.id)) {
      const browser = await current.browsers.get(info.id);
      runtime.write(await browser.documentation());
      runtime.write(await browser.tabs.list());
      browsers.set(info.id, browser);
    }
    return browsers.get(info.id);
  }
  async function show(tab) {
    runtime.write(await tab.playwright.domSnapshot());
    return tab;
  }
  return {
    getBrowser,
    async getTab(reference, { browser: selector } = {}) {
      const browser = await getBrowser(selector);
      if (typeof reference === 'string') return show(await browser.tabs.get(reference));
      if (typeof reference?.url !== 'string') throw new TypeError('getTab expects a tab ID or {url}.');
      const matches = (await browser.tabs.list()).filter((tab) => tab.url === reference.url);
      if (matches.length !== 1) throw new Error(`Expected one tab with URL ${reference.url}; found ${matches.length}. Select its tab ID.`);
      return show(await browser.tabs.get(matches[0].id));
    },
    async createBrowserTab(selector, url) {
      const browser = await getBrowser(selector);
      const tab = await browser.tabs.new();
      if (url !== undefined) await tab.goto(url);
      return show(tab);
    },
    async close() {
      closed = true;
      browsers.clear();
      if (module) await module.closeBrowserRuntime();
    },
  };
}
