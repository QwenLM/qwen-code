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
const notice = doc.getElementById('notice')!;
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
  (state) => {
    const { phase } = state;
    const messages = {
      waiting: 'Waiting for the completed view…',
      starting: 'Starting the interactive view…',
      running: 'Updating the view…',
      ready: 'Latest update applied',
      dirty: 'Parameters changed. Use the view’s update action to apply them.',
      stopped: 'Stopped. Reopen the card to start a new view.',
      error: state.error ?? 'The view runtime failed. Use the summary.',
    };
    if (status.textContent !== messages[phase])
      status.textContent = messages[phase];
    status.dataset['state'] = phase;
    const terminal = phase === 'stopped' || phase === 'error';
    stop.disabled = terminal;
    frame.hidden = !state.viewAvailable;
    frame.setAttribute(
      'aria-busy',
      String(phase === 'starting' || phase === 'running'),
    );
    const notices: string[] = [];
    if (!terminal) {
      if (state.lastUpdate === 'superseded')
        notices.push(
          'An older update was skipped. Your newer inputs were kept.',
        );
      else if (state.lastUpdate === 'outdated')
        notices.push('The displayed update may still use earlier parameters.');
      if (state.rejectedEvents)
        notices.push(
          'Some interactions were not processed because the queue was full. Wait for the update, then repeat the intended action.',
        );
    }
    const message = notices.join(' ');
    if (notice.textContent !== message) notice.textContent = message;
    notice.hidden = !message;
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
