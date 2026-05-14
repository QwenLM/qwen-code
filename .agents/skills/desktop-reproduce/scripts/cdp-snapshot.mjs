#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

const args = parseArgs(process.argv.slice(2));
const endpoint = String(args.endpoint ?? 'http://127.0.0.1:9222').replace(
  /\/$/,
  '',
);
const captureMs = Number(args['capture-ms'] ?? 3000);
const targetPattern = args.target ? new RegExp(String(args.target), 'i') : null;
const screenshotPath = args.screenshot ? String(args.screenshot) : null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const version = await getJson(`${endpoint}/json/version`);
  const targets = await getJson(`${endpoint}/json/list`);
  const target = selectTarget(targets, targetPattern);

  if (!target?.webSocketDebuggerUrl) {
    const summary = targets.map(({ id, type, title, url }) => ({
      id,
      type,
      title,
      url,
    }));
    throw new Error(
      `No debuggable page target found. Available targets: ${JSON.stringify(
        summary,
      )}`,
    );
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const consoleEvents = [];
  const networkEvents = [];

  cdp.on('Runtime.consoleAPICalled', (event) => {
    consoleEvents.push({
      source: 'console',
      type: event.type,
      args: (event.args ?? []).map(remoteObjectSummary).slice(0, 8),
      stack: stackSummary(event.stackTrace),
    });
  });

  cdp.on('Runtime.exceptionThrown', (event) => {
    consoleEvents.push({
      source: 'exception',
      text: event.exceptionDetails?.text,
      exception: remoteObjectSummary(event.exceptionDetails?.exception),
      stack: stackSummary(event.exceptionDetails?.stackTrace),
    });
  });

  cdp.on('Log.entryAdded', (event) => {
    const entry = event.entry ?? {};
    consoleEvents.push({
      source: 'log',
      level: entry.level,
      text: truncate(entry.text, 500),
      url: entry.url,
      lineNumber: entry.lineNumber,
    });
  });

  cdp.on('Network.loadingFailed', (event) => {
    networkEvents.push({
      type: 'failed',
      requestId: event.requestId,
      errorText: event.errorText,
      canceled: event.canceled,
      blockedReason: event.blockedReason,
    });
  });

  cdp.on('Network.responseReceived', (event) => {
    const response = event.response ?? {};
    if (response.status >= 400) {
      networkEvents.push({
        type: 'http-error',
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        mimeType: response.mimeType,
      });
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable').catch(() => undefined);
  await cdp.send('Network.enable').catch(() => undefined);
  await cdp.send('Accessibility.enable').catch(() => undefined);

  await wait(Number.isFinite(captureMs) ? captureMs : 3000);

  const runtimeSnapshot = await evaluate(cdp, rendererSnapshotExpression());
  const frameTree = await cdp.send('Page.getResourceTree');
  const resources = flattenResources(frameTree.result?.frameTree);
  const sourceMapHints = await collectSourceMapHints(cdp, frameTree, resources);
  const accessibility = await collectAccessibility(cdp);

  let screenshot = null;
  if (screenshotPath) {
    const image = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(screenshotPath, image.result.data, 'base64');
    screenshot = screenshotPath;
  }

  cdp.close();

  const output = {
    capturedAt: new Date().toISOString(),
    endpoint,
    browser: version,
    selectedTarget: target,
    targets: targets.map(({ id, type, title, url }) => ({
      id,
      type,
      title,
      url,
    })),
    runtimeSnapshot,
    accessibility,
    resources,
    sourceMapHints,
    consoleEvents,
    networkEvents,
    screenshot,
  };

  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

function selectTarget(targets, pattern) {
  const pages = targets.filter((target) => target.type === 'page');
  if (pattern) {
    return pages.find((target) => {
      return pattern.test(target.title ?? '') || pattern.test(target.url ?? '');
    });
  }
  return pages[0] ?? targets.find((target) => target.webSocketDebuggerUrl);
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Map();
  let id = 0;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    const callbacks = listeners.get(message.method) ?? [];
    for (const callback of callbacks) callback(message.params ?? {});
  });

  return {
    send(method, params = {}) {
      const messageId = ++id;
      socket.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(messageId);
          reject(new Error(`CDP timeout: ${method}`));
        }, 10000);
        pending.set(messageId, (message) => {
          clearTimeout(timeout);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message);
        });
      });
    },
    on(method, callback) {
      const callbacks = listeners.get(method) ?? [];
      callbacks.push(callback);
      listeners.set(method, callbacks);
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return response.result?.result?.value ?? null;
}

function rendererSnapshotExpression() {
  return String.raw`(() => {
    const truncate = (value, max = 160) => {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim();
      return text.length > max ? text.slice(0, max) + '...' : text;
    };
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0;
    };
    const describeElement = (element) => {
      const rect = element.getBoundingClientRect();
      const valueLength = 'value' in element && typeof element.value === 'string'
        ? element.value.length
        : undefined;
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || undefined,
        type: element.getAttribute('type') || undefined,
        id: element.id || undefined,
        className: truncate(element.className, 120) || undefined,
        ariaLabel: element.getAttribute('aria-label') || undefined,
        title: element.getAttribute('title') || undefined,
        placeholder: element.getAttribute('placeholder') || undefined,
        text: ['input', 'textarea'].includes(element.tagName.toLowerCase())
          ? undefined
          : truncate(element.innerText || element.textContent, 180) || undefined,
        valueLength,
        checked: 'checked' in element ? Boolean(element.checked) : undefined,
        disabled: 'disabled' in element ? Boolean(element.disabled) : undefined,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    };
    const controls = Array.from(document.querySelectorAll(
      'button,input,textarea,select,a[href],[role],[contenteditable="true"]'
    )).filter(isVisible).slice(0, 120).map(describeElement);
    const activeElement = document.activeElement
      ? describeElement(document.activeElement)
      : null;
    const storageSummary = (storage) => {
      try {
        return Array.from({ length: storage.length }, (_, index) => {
          const key = storage.key(index);
          const value = key ? storage.getItem(key) : '';
          return { key, valueLength: value?.length ?? 0 };
        });
      } catch (error) {
        return [{ error: String(error?.message ?? error) }];
      }
    };
    return {
      title: document.title,
      href: location.href,
      readyState: document.readyState,
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      rootExists: Boolean(document.querySelector('#root')),
      elementCount: document.querySelectorAll('*').length,
      activeElement,
      visibleControls: controls,
      localStorage: storageSummary(localStorage),
      sessionStorage: storageSummary(sessionStorage),
    };
  })()`;
}

function flattenResources(frameTree, resources = []) {
  if (!frameTree) return resources;
  for (const resource of frameTree.resources ?? []) {
    resources.push({
      url: resource.url,
      type: resource.type,
      mimeType: resource.mimeType,
    });
  }
  for (const child of frameTree.childFrames ?? []) {
    flattenResources(child, resources);
  }
  return resources;
}

async function collectSourceMapHints(cdp, frameTree, resources) {
  const frameId = frameTree.result?.frameTree?.frame?.id;
  if (!frameId) return [];

  const scripts = resources
    .filter((resource) => resource.type === 'Script' && resource.url)
    .slice(0, 50);
  const hints = [];

  for (const script of scripts) {
    try {
      const response = await cdp.send('Page.getResourceContent', {
        frameId,
        url: script.url,
      });
      const content = response.result?.content ?? '';
      const match = content.match(/sourceMappingURL=([^\n\r]+)/);
      hints.push({
        url: script.url,
        bytes: Buffer.byteLength(content, 'utf8'),
        sourceMappingURL: match?.[1] ?? null,
      });
    } catch (error) {
      hints.push({
        url: script.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return hints;
}

async function collectAccessibility(cdp) {
  try {
    const response = await cdp.send('Accessibility.getFullAXTree');
    const interestingRoles = new Set([
      'button',
      'checkbox',
      'combobox',
      'dialog',
      'link',
      'menu',
      'menuitem',
      'radio',
      'searchbox',
      'tab',
      'textbox',
    ]);
    return (response.result?.nodes ?? [])
      .filter((node) => interestingRoles.has(node.role?.value))
      .slice(0, 200)
      .map((node) => ({
        role: node.role?.value,
        name: truncate(node.name?.value, 180),
        value: node.value?.type === 'string' ? '[redacted string]' : undefined,
        disabled: node.disabled,
        focused: node.focused,
      }));
  } catch (error) {
    return [
      {
        error: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

function remoteObjectSummary(object) {
  if (!object) return null;
  if ('value' in object) return truncate(object.value, 500);
  if (object.description) return truncate(object.description, 500);
  return object.type ?? null;
}

function stackSummary(stackTrace) {
  return (stackTrace?.callFrames ?? []).slice(0, 8).map((frame) => ({
    functionName: frame.functionName,
    url: frame.url,
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
  }));
}

function truncate(value, max = 240) {
  if (value === undefined || value === null) return value;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
