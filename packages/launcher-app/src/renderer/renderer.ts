/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import * as QRCode from 'qrcode';

// NOTE (secret hygiene): this module must never assign the pairing code or
// OPENAI_API_KEY to a module-level variable, `localStorage`, or anything
// that outlives the DOM node it's rendered into. Read them straight from
// `window.launcher` responses / form inputs into the DOM and nothing else.

type TabName = 'control' | 'logs' | 'config';

const tabButtons = document.querySelectorAll<HTMLButtonElement>('.tab-button');
const panels = document.querySelectorAll<HTMLElement>('.panel');

let activeTab: TabName = 'control';
let isRunning = false;
let lastUrl: string | undefined;

function showBanner(el: HTMLElement, message: string | undefined): void {
  if (!message) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

function setActiveTab(tab: TabName): void {
  const leaving = activeTab;
  activeTab = tab;

  for (const btn of tabButtons) {
    const isActive = btn.dataset['tab'] === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  }
  for (const panel of panels) {
    panel.classList.toggle('active', panel.dataset['panel'] === tab);
  }

  if (leaving === 'logs' && tab !== 'logs') {
    void window.launcher.stopLogs();
  }
  if (tab === 'logs' && leaving !== 'logs') {
    logOutput.textContent = '';
    void window.launcher.startLogs();
  }
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => {
    const tab = btn.dataset['tab'] as TabName | undefined;
    if (tab) setActiveTab(tab);
  });
}

// ---- Control tab ----

const controlBanner = document.getElementById('control-banner') as HTMLElement;
const statusDot = document.getElementById('status-dot') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const toggleButton = document.getElementById(
  'toggle-button',
) as HTMLButtonElement;
const connectInfo = document.getElementById('connect-info') as HTMLElement;
const connectUrlEl = document.getElementById('connect-url') as HTMLElement;
const pairingCodeEl = document.getElementById('pairing-code') as HTMLElement;
const qrImage = document.getElementById('qr-image') as HTMLImageElement;
const distroSelect = document.getElementById(
  'distro-select',
) as HTMLSelectElement;

function setRunningUi(running: boolean): void {
  isRunning = running;
  statusDot.classList.toggle('running', running);
  statusDot.classList.toggle('stopped', !running);
  statusText.textContent = running ? 'Running' : 'Stopped';
  toggleButton.textContent = running ? 'Stop' : 'Start';
  toggleButton.disabled = false;
}

async function refreshConnectInfo(url: string): Promise<void> {
  connectUrlEl.textContent = url;
  const code = await window.launcher.pairingCode();
  pairingCodeEl.textContent = code ?? '(none)';
  try {
    // Embed the pairing code in the URL *fragment* so a scanned QR auto-fills
    // and pairs the phone (the /ui/ page reads `#code=`, then scrubs it). The
    // fragment never reaches server logs/Referer. Code stays in-image only —
    // never logged or persisted (secret hygiene).
    const qrTarget = code ? `${url}#code=${encodeURIComponent(code)}` : url;
    qrImage.src = await QRCode.toDataURL(qrTarget);
  } catch {
    qrImage.removeAttribute('src');
  }
  connectInfo.classList.remove('hidden');
}

window.launcher.onStatus((state) => {
  setRunningUi(state.running);
  if (state.running && state.url) {
    if (state.url !== lastUrl) {
      lastUrl = state.url;
      void refreshConnectInfo(state.url);
    }
  } else {
    lastUrl = undefined;
    connectInfo.classList.add('hidden');
    connectUrlEl.textContent = '';
    pairingCodeEl.textContent = '';
    qrImage.removeAttribute('src');
  }
});

toggleButton.addEventListener('click', () => {
  toggleButton.disabled = true;
  showBanner(controlBanner, undefined);
  if (isRunning) {
    void window.launcher.down().then((result) => {
      toggleButton.disabled = false;
      if (!result.ok) showBanner(controlBanner, result.hint ?? 'Stop failed');
    });
  } else {
    void window.launcher.up().then((result) => {
      toggleButton.disabled = false;
      if (!result.ok) {
        showBanner(controlBanner, result.hint ?? 'Start failed');
        return;
      }
      // Don't wait for the next status poll to pick up the URL: `up()`
      // only resolves once the gateway (and its pairing code) are ready,
      // so refresh immediately rather than gating on a poll-driven diff.
      if (result.url) {
        lastUrl = result.url;
        void refreshConnectInfo(result.url);
      }
    });
  }
});

async function initDistroPicker(): Promise<void> {
  const [distros, config] = await Promise.all([
    window.launcher.listDistros(),
    window.launcher.getConfig(),
  ]);
  distroSelect.innerHTML = '';
  for (const d of distros) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    distroSelect.appendChild(opt);
  }
  if (config.distro) distroSelect.value = config.distro;
}

distroSelect.addEventListener('change', () => {
  void window.launcher.setDistro(distroSelect.value);
});

void initDistroPicker();

// ---- Logs tab ----

const logOutput = document.getElementById('log-output') as HTMLElement;

window.launcher.onLog((line) => {
  logOutput.textContent += line.endsWith('\n') ? line : `${line}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
});

// ---- Config tab ----

const configForm = document.getElementById('config-form') as HTMLFormElement;
const configStatus = document.getElementById('config-status') as HTMLElement;
const baseUrlInput = document.getElementById(
  'cfg-base-url',
) as HTMLInputElement;
const apiKeyInput = document.getElementById('cfg-api-key') as HTMLInputElement;
const modelInput = document.getElementById('cfg-model') as HTMLInputElement;

async function loadConfigForm(): Promise<void> {
  const config = await window.launcher.getConfig();
  baseUrlInput.value = config.OPENAI_BASE_URL ?? '';
  apiKeyInput.value = config.OPENAI_API_KEY ?? '';
  modelInput.value = config.OPENAI_MODEL ?? '';
}

void loadConfigForm();

configForm.addEventListener('submit', (event) => {
  event.preventDefault();
  showBanner(configStatus, undefined);

  // Read straight from the form inputs at save time; nothing is cached in a
  // module-level variable beyond this call.
  void window.launcher
    .saveConfig({
      OPENAI_BASE_URL: baseUrlInput.value || undefined,
      OPENAI_API_KEY: apiKeyInput.value || undefined,
      OPENAI_MODEL: modelInput.value || undefined,
    })
    .then(async (result) => {
      if (!result.ok) {
        showBanner(configStatus, 'Save failed');
        return;
      }
      showBanner(configStatus, 'Saved.');
      const shouldRestart = window.confirm(
        'Configuration saved. Restart the remote-control service to apply it now?',
      );
      if (shouldRestart) {
        await window.launcher.down();
        await window.launcher.up();
      }
    });
});
