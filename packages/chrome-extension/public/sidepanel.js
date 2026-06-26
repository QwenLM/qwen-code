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
  copy: document.getElementById('copy'),
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
  els.iframe.style.display = 'none';
  els.welcome.style.display = 'block';
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
  els.welcome.style.display = 'none';
  if (framedUrl !== baseUrl) {
    framedUrl = baseUrl;
    els.iframe.src = baseUrl;
  }
  els.iframe.style.display = 'block';
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

els.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.cmd.textContent || '');
    els.copy.textContent = 'Copied';
    setTimeout(() => {
      els.copy.textContent = 'Copy';
    }, 1500);
  } catch {
    // Clipboard write can be blocked; the command stays selectable as fallback.
    els.copy.textContent = 'Copy failed';
  }
});

tick();
pollTimer = setInterval(tick, POLL_MS);
