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
 * Static asset (no bundler). Constants intentionally duplicate daemon/config.ts
 * (which the bundled service worker uses) to stay standalone.
 */
/* global chrome, document, fetch, AbortController, navigator, setTimeout, clearTimeout, setInterval, URL */

const DEFAULT_BASE_URL = 'http://127.0.0.1:4170';
const STORAGE_KEY = 'qwen.daemon';
const POLL_MS = 2000;
const PROBE_TIMEOUT_MS = 2000;
const FRAMED_MISS_LIMIT = 2;
const SHELL_AUTH_MESSAGE_TYPE = 'qwen-daemon-auth';

/** The command to start a daemon that allows this extension's own origin. */
const allowOriginCommand = (extensionId) =>
  `qwen serve --allow-origin chrome-extension://${extensionId}`;

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

/** Whether a URL points at the local loopback interface. */
function isLoopback(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/** Read daemon base URL + optional bearer token from chrome.storage. */
async function readConfig() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const cfg = (stored && stored[STORAGE_KEY]) || {};
    const baseUrl =
      (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim()) ||
      DEFAULT_BASE_URL;
    // Fail closed: never send the bearer token off-loopback. A tampered stored
    // baseUrl pointing at a remote host would otherwise exfiltrate it on every
    // probe (fetch from this panel isn't constrained by host_permissions).
    if (!isLoopback(baseUrl)) {
      return { baseUrl: DEFAULT_BASE_URL, token: undefined };
    }
    return {
      baseUrl,
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
  const features = Array.isArray(caps?.features) ? caps.features : [];
  return features.includes('allow_origin') ? 'ready' : 'needs-allow-origin';
}

/** Render the welcome screen for a non-ready state. */
function showWelcome(state, command) {
  framedUrl = null;
  els.iframe.removeAttribute('src');
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
let framedMisses = 0;
function postShellAuth(baseUrl, token) {
  const win = els.iframe.contentWindow;
  if (!win) return;
  win.postMessage(
    { type: SHELL_AUTH_MESSAGE_TYPE, token: token || null },
    new URL(baseUrl).origin,
  );
}

/** Swap to the Web Shell iframe; only (re)assigns src when the URL changes. */
function showShell(baseUrl, token) {
  framedMisses = 0;
  els.welcome.classList.add('hidden');
  els.iframe.onload = () => postShellAuth(baseUrl, token);
  if (framedUrl !== baseUrl) {
    framedUrl = baseUrl;
    els.iframe.src = baseUrl;
  } else {
    postShellAuth(baseUrl, token);
  }
  els.iframe.classList.remove('hidden');
}

/**
 * One probe → render. Keep probing after framing so a stopped daemon falls
 * back to the welcome screen instead of exposing Chrome's localhost error page.
 */
let ticking = false;
async function tick() {
  // Reentrancy guard: probeState runs two sequential fetches (up to ~4s) but
  // setInterval fires every 2s. Overlapping ticks would each bump framedMisses,
  // burning the FRAMED_MISS_LIMIT tolerance at ~2× and flashing the welcome
  // screen (clearing the user's in-flight chat) while the daemon is just slow.
  if (ticking) return;
  ticking = true;
  try {
    const { baseUrl, token } = await readConfig();
    const state = await probeState(baseUrl, token);
    if (state === 'ready') {
      showShell(baseUrl, token);
    } else {
      if (framedUrl && framedMisses < FRAMED_MISS_LIMIT) {
        framedMisses += 1;
        return;
      }
      framedMisses = 0;
      showWelcome(state, allowOriginCommand(chrome.runtime.id));
    }
  } finally {
    ticking = false;
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
setInterval(tick, POLL_MS);
