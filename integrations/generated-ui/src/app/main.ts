/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import { ViewController } from './controller.js';
import type { CaptureResult, ViewState } from './controller.js';
import { buildContinuationText } from './continuation.js';
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
const continueAnalysis = doc.getElementById(
  'continue-analysis',
) as HTMLButtonElement;
const continuationStatus = doc.getElementById('continuation-status')!;
const continuationHelp = doc.getElementById('continuation-help')!;
let documentTitle = '';
let phase: ViewState['phase'] = 'waiting';
let canReview = false;
let continuationState:
  | 'idle'
  | 'pending'
  | 'accepted'
  | 'unconfirmed'
  | 'terminal' = 'idle';
let continuationMessage = '';
interface ContinuationAttempt {
  abort: AbortController;
  capture?: Extract<CaptureResult, { ok: true }>;
  text?: string;
}
let pendingAttempt: ContinuationAttempt | undefined;

function renderContinuation(): void {
  continueAnalysis.disabled =
    !canReview ||
    phase !== 'ready' ||
    continuationState === 'pending' ||
    continuationState === 'terminal';
  const label =
    continuationState === 'unconfirmed'
      ? 'Review again after checking the session'
      : 'Continue analysis with current parameters';
  if (continueAnalysis.textContent !== label)
    continueAnalysis.textContent = label;
  const help = canReview
    ? 'Apply your changes, then review the complete captured parameters before sending to this session. Later edits are not included.'
    : 'Continuing analysis requires a connected Qwen Code host with message review. Local interactions remain available.';
  if (continuationHelp.textContent !== help)
    continuationHelp.textContent = help;
  if (continuationStatus.textContent !== continuationMessage)
    continuationStatus.textContent = continuationMessage;
  continuationStatus.hidden = !continuationMessage;
  continuationStatus.dataset['state'] = continuationState;
}

function endContinuation(): void {
  const attempt = pendingAttempt;
  pendingAttempt = undefined;
  // Only a built message can have reached the host; a capture failure sent nothing.
  if (continuationState === 'pending' && attempt?.text)
    continuationMessage =
      'Stopped waiting for confirmation. Check the original session; a request already sent may still be accepted. Stopping this card does not withdraw a session request.';
  continuationState = 'terminal';
  attempt?.abort.abort();
}

async function continueWithParameters(): Promise<void> {
  if (continueAnalysis.disabled || pendingAttempt) return;
  // Lock before capture: capture publishes synchronously and re-reads the DOM.
  const attempt: ContinuationAttempt = {
    abort: new AbortController(),
  };
  pendingAttempt = attempt;
  const previousState = continuationState;
  continuationState = 'pending';
  renderContinuation();
  const capture = controller.captureSnapshot();
  if (pendingAttempt !== attempt) return;
  if (!capture.ok) {
    pendingAttempt = undefined;
    continuationState = previousState;
    continuationMessage =
      'Parameters are not ready. Wait for the view’s update, then apply any changed parameters before reviewing.';
    renderContinuation();
    return;
  }
  const message = buildContinuationText(documentTitle, capture);
  if (!message.ok) {
    pendingAttempt = undefined;
    continuationState = previousState;
    continuationMessage =
      'The complete parameter message exceeds 16 KiB. Reduce parameter content and apply the update before reviewing. Nothing was sent for this attempt.';
    renderContinuation();
    return;
  }
  attempt.capture = capture;
  attempt.text = message.text;
  continuationMessage =
    'Waiting for session confirmation… Review the captured parameters in the host. Later edits do not change this message.';
  renderContinuation();
  try {
    const result = await app.sendMessage(
      { role: 'user', content: [{ type: 'text', text: attempt.text }] },
      // Cover the host’s 90 s review + 90 s admission windows and transport.
      { signal: attempt.abort.signal, timeout: 210_000 },
    );
    if (pendingAttempt !== attempt) return;
    continuationState = result.isError ? 'unconfirmed' : 'accepted';
  } catch {
    if (pendingAttempt !== attempt) return;
    continuationState = 'unconfirmed';
  }
  pendingAttempt = undefined;
  continuationMessage =
    continuationState === 'accepted'
      ? 'The session accepted the request. Analysis may still be running; follow it in the original session.'
      : 'Acceptance could not be confirmed. The review may have been cancelled or rejected, or the request may still be in flight. Check the original session before reviewing again; another submission could duplicate a request. Nothing is retried automatically.';
  renderContinuation();
}

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
    documentTitle = document.title;
    title.textContent = document.title;
    summary.textContent = document.summary;
  },
  (state) => {
    phase = state.phase;
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
    if (terminal) endContinuation();
    renderContinuation();
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
continueAnalysis.addEventListener('click', () => void continueWithParameters());
globalThis.addEventListener('pagehide', () => controller.stop(), {
  once: true,
});
app.connect().then(
  () => {
    canReview =
      app.getHostVersion()?.name === 'qwen-code-web-shell' &&
      !!app.getHostCapabilities()?.message?.text;
    renderContinuation();
    const theme = app.getHostContext()?.theme;
    if (theme) applyDocumentTheme(theme);
  },
  () =>
    controller.fail('The interactive host is unavailable. Use the summary.'),
);
