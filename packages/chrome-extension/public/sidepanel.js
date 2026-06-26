/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Side panel host. Probes the local `qwen serve` daemon and either frames its
 * Web Shell (chat + tools) or shows a welcome screen with the exact command to
 * run. The extension has no UI of its own — it's a CDP-tunnel pipe — so the
 * panel just frames the daemon once one is reachable and permits framing.
 *
 * Static asset (no bundler); loaded as an ES module so it can import the pure
 * helpers in onboarding-logic.js. Constants intentionally duplicate
 * daemon/config.ts (which the bundled service worker uses) to stay standalone.
 */
/* global chrome, document, fetch, AbortController, navigator, setTimeout, clearTimeout, setInterval, clearInterval */

import {
  DEFAULT_BASE_URL,
  resolveBaseUrl,
  allowOriginCommand,
  decideState,
} from './onboarding-logic.js';

const STORAGE_KEY = 'qwen.daemon';
const POLL_MS = 2000;
const PROBE_TIMEOUT_MS = 2000;

const els = {
  iframe: document.getElementById('ui'),
  welcome: document.getElementById('welcome'),
  title: document.getElementById('welcome-title'),
  desc: document.getElementById('welcome-desc'),
  cmd: document.getElementById('cmd'),
  cmdRow: document.getElementById('cmd-row'),
  copy: document.getElementById('copy'),
  copyLabel: document.getElementById('copy-label'),
};

/** Read daemon base URL + optional bearer token from chrome.storage. */
async function readConfig() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const cfg = (stored && stored[STORAGE_KEY]) || {};
    return {
      baseUrl: resolveBaseUrl(cfg.baseUrl),
      token: (typeof cfg.token === 'string' && cfg.token.trim()) || undefined,
    };
  } catch {
    return { baseUrl: DEFAULT_BASE_URL, token: undefined };
  }
}

/** GET a daemon endpoint with a short timeout; returns parsed JSON or null. */
async function probeJson(url, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe `/health` then `/capabilities` and reduce to an onboarding state. */
async function probeState(baseUrl, token) {
  const health = await probeJson(`${baseUrl}/health`, token);
  if (!health) return 'down';
  const caps = await probeJson(`${baseUrl}/capabilities`, token);
  const features = caps && Array.isArray(caps.features) ? caps.features : [];
  return decideState({
    healthOk: true,
    allowOriginActive: features.includes('allow_origin'),
  });
}

/** Render the welcome screen for a non-ready state. */
function showWelcome(state, command) {
  els.iframe.classList.add('hidden');
  els.welcome.classList.remove('hidden');
  els.cmd.textContent = command;
  if (state === 'down') {
    els.title.textContent = 'Start qwen serve';
    els.desc.textContent =
      'No local qwen serve daemon is reachable. Run this in a terminal and ' +
      'leave it running, then this panel connects automatically:';
  } else {
    els.title.textContent = 'Allow this extension';
    els.desc.textContent =
      'qwen serve is running but is not allowed to load its UI here. Restart ' +
      'it with the flag below (it names this extension), then this panel ' +
      'connects automatically:';
  }
}

let framedUrl = null;
/** Swap to the Web Shell iframe; only (re)assigns src when the URL changes. */
function showShell(baseUrl) {
  els.welcome.classList.add('hidden');
  if (framedUrl !== baseUrl) {
    framedUrl = baseUrl;
    els.iframe.src = baseUrl;
  }
  els.iframe.classList.remove('hidden');
}

let pollTimer = null;
/**
 * One probe → render. Once framed we stop polling: the Web Shell owns its own
 * reconnect/SSE, so re-probing would only risk nuking a live chat on a blip.
 */
async function tick() {
  const { baseUrl, token } = await readConfig();
  const state = await probeState(baseUrl, token);
  if (state === 'ready') {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    showShell(baseUrl);
  } else {
    showWelcome(state, allowOriginCommand(chrome.runtime.id));
  }
}

let copyResetTimer = null;
/** Copy the command and flash a check-mark confirmation on the footer button. */
async function copyCommand() {
  try {
    await navigator.clipboard.writeText(els.cmd.textContent || '');
    els.copy.classList.add('copied');
    els.copyLabel.textContent = 'Copied';
  } catch {
    // Clipboard write can be blocked; the command stays selectable as fallback.
    els.copyLabel.textContent = 'Copy failed';
  }
  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => {
    els.copy.classList.remove('copied');
    els.copyLabel.textContent = 'Copy command';
  }, 1600);
}

// Both the footer button and the command row itself copy; the row is a
// keyboard-reachable button (Enter/Space) for parity with a mouse click.
els.copy.addEventListener('click', copyCommand);
els.cmdRow.addEventListener('click', copyCommand);
els.cmdRow.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    copyCommand();
  }
});

// Fill the command synchronously so first paint isn't an empty prompt — the id
// is available immediately; tick() then keeps title/desc/command per probe.
els.cmd.textContent = allowOriginCommand(chrome.runtime.id);

tick();
pollTimer = setInterval(tick, POLL_MS);
