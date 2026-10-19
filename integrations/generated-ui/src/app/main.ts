/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import { ViewController } from './controller.js';
import { ViewSurface } from './surface.js';
import './styles.css';

declare const __WORKER_GZIP_BASE64__: string;

const app = new App(
  { name: 'generated-ui', version: '1.0.0' },
  {},
  { strict: true, autoResize: true },
);
const doc = globalThis.document;
const title = doc.getElementById('title')!;
const summary = doc.getElementById('summary')!;
const status = doc.getElementById('status')!;
const stop = doc.getElementById('stop') as HTMLButtonElement;
const frame = doc.getElementById('view') as HTMLIFrameElement;
const surface = new ViewSurface(
  frame,
  (event) => controller.event(event),
  (error) => controller.fail(error),
);
const controller = new ViewController(
  surface,
  async () => {
    if (
      typeof Worker === 'undefined' ||
      typeof WebAssembly === 'undefined' ||
      typeof DecompressionStream === 'undefined'
    ) {
      throw new Error('This browser cannot run the view. Use the summary.');
    }
    // Only the fixed, build-time runtime is decompressed, never model content.
    const compressed = Uint8Array.from(atob(__WORKER_GZIP_BASE64__), (char) =>
      char.charCodeAt(0),
    );
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const source = await new Response(stream).text();
    const url = URL.createObjectURL(
      new Blob([source], { type: 'text/javascript' }),
    );
    try {
      return new Worker(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  (document) => {
    title.textContent = document.title;
    summary.textContent = document.summary;
  },
  (phase, message) => {
    status.textContent = message;
    status.dataset['state'] = phase;
    stop.disabled = phase === 'stopped' || phase === 'error';
    if (phase === 'ready') frame.hidden = false;
  },
);

app.addEventListener('toolresult', (result) => {
  void controller.receive(result);
});
app.addEventListener('toolcancelled', () => controller.stop());
app.addEventListener('hostcontextchanged', () => {
  const theme = app.getHostContext()?.theme;
  if (theme) applyDocumentTheme(theme);
});
app.onteardown = async () => {
  controller.stop();
  return {};
};
stop.addEventListener('click', () => controller.stop());
globalThis.addEventListener('pagehide', () => controller.stop(), {
  once: true,
});
app.connect().then(
  () => {
    const theme = app.getHostContext()?.theme;
    if (theme) applyDocumentTheme(theme);
  },
  () =>
    controller.fail('The interactive host is unavailable. Use the summary.'),
);
