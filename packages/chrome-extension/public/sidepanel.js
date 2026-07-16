/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Side panel host. Probes the local `qwen serve` daemon and either frames its
 * Web Shell (chat + tools) or shows a welcome screen with the exact command to
 * run. Native browser tools run in the extension service worker; the panel
 * handles daemon discovery and first-use pairing before framing the Web Shell.
 *
 * Static asset (no bundler). Constants intentionally duplicate daemon/config.ts
 * (which the bundled service worker uses) to stay standalone.
 */
/* global chrome, document, fetch, AbortController, navigator, setTimeout, clearTimeout, setInterval, URL, crypto, TextEncoder, btoa */

const DEFAULT_BASE_URL = 'http://127.0.0.1:4170';
const STORAGE_KEY = 'qwen.daemon';
const POLL_MS = 2000;
const PROBE_TIMEOUT_MS = 2000;
const FRAMED_MISS_LIMIT = 2;
const SHELL_AUTH_MESSAGE_TYPE = 'qwen-daemon-auth';
const DAEMON_READY_MESSAGE_TYPE = 'qwen-daemon-ready';
const OFFICIAL_EXTENSION_ID = 'idkijaaipeeinemigojbjkmfmabokbdk';
const PAIRING_DOMAIN = 'qwen-extension-pairing';
const VERIFICATION_DOMAIN = 'qwen-extension-daemon';
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Official builds are allowlisted by qwen serve; custom builds stay explicit. */
const allowOriginCommand = (extensionId) =>
  extensionId === OFFICIAL_EXTENSION_ID
    ? 'qwen serve'
    : `qwen serve --allow-origin chrome-extension://${extensionId}`;

const els = {
  iframe: document.getElementById('ui'),
  welcome: document.getElementById('welcome'),
  title: document.getElementById('welcome-title'),
  desc: document.getElementById('welcome-desc'),
  cmd: document.getElementById('cmd'),
  cmdRow: document.getElementById('cmd-row'),
  copy: document.getElementById('copy'),
  copyLabel: document.getElementById('copy-label'),
  pairForm: document.getElementById('pair-form'),
  pairCode: document.getElementById('pair-code'),
  pairSubmit: document.getElementById('pair-submit'),
  pairMessage: document.getElementById('pair-message'),
  statusText: document.querySelector('.status__text'),
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
      extensionPairingCredential:
        (typeof cfg.extensionPairingCredential === 'string' &&
          cfg.extensionPairingCredential.trim()) ||
        undefined,
    };
  } catch {
    return { baseUrl: DEFAULT_BASE_URL, token: undefined };
  }
}

/** GET a daemon endpoint with a short timeout; returns parsed JSON or null. */
async function probeJson(url, token, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
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

async function verifyPairing(baseUrl, credential) {
  if (!credential) return false;
  const separator = credential.indexOf('.');
  if (separator <= 0 || separator === credential.length - 1) return false;
  const credentialId = credential.slice(0, separator);
  const secret = credential.slice(separator + 1);
  const challengeBytes = new Uint8Array(32);
  crypto.getRandomValues(challengeBytes);
  const challenge = base64Url(challengeBytes.buffer);
  const body = await probeJson(
    `${baseUrl}/extension/pairing/verify`,
    undefined,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentialId, challenge }),
    },
  );
  if (typeof body?.proof !== 'string') return false;
  return proofsEqual(body.proof, await pairingProof(secret, challenge));
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function hmacProof(secret, message) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  const key = await crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(
    await crypto.subtle.sign('HMAC', key, encoder.encode(message)),
  );
}

function pairingProof(secret, challenge) {
  return hmacProof(secret, `${VERIFICATION_DOMAIN}:${challenge}`);
}

function exchangeProof(code, direction, pairingNonce, challenge, suffix = '') {
  return hmacProof(
    code,
    `${PAIRING_DOMAIN}:${direction}:${pairingNonce}:${challenge}${suffix}`,
  );
}

function proofsEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function notifyDaemonReady() {
  void chrome.runtime
    .sendMessage({ type: DAEMON_READY_MESSAGE_TYPE })
    .catch(() => undefined);
}

let pendingPairingNonce = null;

/** Probe the daemon and reduce it to one onboarding state. */
async function probeState(baseUrl, token, extensionPairingCredential) {
  if (await verifyPairing(baseUrl, extensionPairingCredential)) {
    pendingPairingNonce = null;
  } else {
    // Pairing endpoints intentionally precede bearer auth. The terminal code
    // stays in the extension and authenticates this first-use exchange before
    // any stored daemon token is exposed.
    const status = await probeJson(`${baseUrl}/extension/pairing`, undefined);
    if (status?.paired === true) {
      pendingPairingNonce = null;
      return 'needs-restart';
    }
    if (
      status?.paired === false &&
      typeof status.pairingNonce === 'string' &&
      /^[A-Za-z0-9_-]{22}$/.test(status.pairingNonce)
    ) {
      pendingPairingNonce = status.pairingNonce;
      return 'needs-pairing';
    }
    pendingPairingNonce = null;
    // This carries no credential. A successful health probe with no pairing
    // route identifies an older daemon, so the panel can show the right fix.
    const legacyHealth = await probeJson(`${baseUrl}/health`, undefined);
    return legacyHealth ? 'needs-upgrade' : 'down';
  }

  const health = await probeJson(`${baseUrl}/health`, token);
  if (!health) {
    return 'down';
  }
  const caps = await probeJson(`${baseUrl}/capabilities`, token);
  const features = Array.isArray(caps?.features) ? caps.features : [];
  if (!features.includes('allow_origin')) return 'needs-allow-origin';
  return 'ready';
}

/** Render the welcome screen for a non-ready state. */
function showWelcome(state, command) {
  framedUrl = null;
  els.iframe.removeAttribute('src');
  els.iframe.classList.add('hidden');
  els.welcome.classList.remove('hidden');
  els.pairForm.classList.toggle('hidden', state !== 'needs-pairing');
  els.cmd.textContent = command;
  if (state === 'down') {
    els.title.textContent = 'Start qwen serve';
    els.desc.textContent =
      'No local qwen serve daemon is reachable. Run this in a terminal and ' +
      'leave it running, then this panel connects automatically.';
    els.statusText.textContent = 'Listening for the daemon...';
  } else if (state === 'needs-allow-origin') {
    els.title.textContent = 'Allow this extension';
    els.desc.textContent =
      'qwen serve is running but is not allowed to load its UI here. Restart ' +
      'it with the flag below (it names this extension), then this panel ' +
      'connects automatically.';
    els.statusText.textContent = 'Waiting for an allowed daemon...';
  } else if (state === 'needs-upgrade') {
    els.title.textContent = 'Update Qwen Code';
    els.desc.textContent =
      'The local daemon is running but does not support secure Chrome ' +
      'extension pairing. Update Qwen Code, then restart qwen serve.';
    els.statusText.textContent = 'Waiting for an updated daemon...';
  } else if (state === 'needs-restart') {
    els.title.textContent = 'Restart qwen serve';
    els.desc.textContent =
      'Chrome pairing data is missing or no longer matches this daemon. Stop ' +
      'the running daemon, start it again, then enter the new pairing code.';
    els.statusText.textContent = 'Waiting for a fresh daemon...';
  } else {
    els.title.textContent = 'Pair Qwen Code';
    els.desc.textContent =
      'qwen serve is running. Enter the Chrome extension pairing code shown ' +
      'in that terminal, then this panel connects automatically.';
    els.statusText.textContent = 'Waiting for pairing...';
  }
}

let framedUrl = null;
let framedMisses = 0;
function postShellAuth(baseUrl, token, extensionPairingCredential) {
  const win = els.iframe.contentWindow;
  if (!win) return;
  win.postMessage(
    {
      type: SHELL_AUTH_MESSAGE_TYPE,
      token: token || null,
      extensionPairingCredential: extensionPairingCredential || null,
    },
    new URL(baseUrl).origin,
  );
}

/** Swap to the Web Shell iframe; only (re)assigns src when the URL changes. */
function showShell(baseUrl, token, extensionPairingCredential) {
  framedMisses = 0;
  els.welcome.classList.add('hidden');
  els.pairForm.classList.add('hidden');
  els.iframe.onload = () =>
    postShellAuth(baseUrl, token, extensionPairingCredential);
  if (framedUrl !== baseUrl) {
    framedUrl = baseUrl;
    els.iframe.src = baseUrl;
    notifyDaemonReady();
  } else {
    postShellAuth(baseUrl, token, extensionPairingCredential);
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
    const { baseUrl, token, extensionPairingCredential } = await readConfig();
    const state = await probeState(baseUrl, token, extensionPairingCredential);
    if (state === 'ready') {
      showShell(baseUrl, token, extensionPairingCredential);
    } else {
      if (framedUrl && framedMisses < FRAMED_MISS_LIMIT) {
        framedMisses += 1;
        return;
      }
      framedMisses = 0;
      showWelcome(
        state,
        state === 'needs-upgrade'
          ? 'npm install -g @qwen-code/qwen-code@latest'
          : allowOriginCommand(chrome.runtime.id),
      );
    }
  } finally {
    ticking = false;
  }
}

async function savePairingCredential(baseUrl, credential) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const current = (stored && stored[STORAGE_KEY]) || {};
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      ...current,
      baseUrl,
      extensionPairingCredential: credential,
    },
  });
}

async function submitPairing(event) {
  event.preventDefault();
  const code = (els.pairCode.value || '').trim().toLowerCase();
  const pairingNonce = pendingPairingNonce;
  if (!code || !pairingNonce) {
    els.pairMessage.textContent = 'Enter the code from your terminal.';
    return;
  }
  const { baseUrl } = await readConfig();
  els.pairMessage.textContent = 'Pairing...';
  els.pairSubmit.disabled = true;
  try {
    const challengeBytes = new Uint8Array(32);
    crypto.getRandomValues(challengeBytes);
    const challenge = base64Url(challengeBytes.buffer);
    const clientProof = await exchangeProof(
      code,
      'client',
      pairingNonce,
      challenge,
    );
    const body = await probeJson(
      `${baseUrl}/extension/pairing/confirm`,
      undefined,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingNonce, challenge, clientProof }),
      },
    );
    const credentialId = body?.credentialId;
    if (
      typeof credentialId !== 'string' ||
      !/^[A-Za-z0-9_-]{11}$/.test(credentialId) ||
      typeof body?.proof !== 'string' ||
      !BASE64URL_256_PATTERN.test(body.proof)
    ) {
      els.pairMessage.textContent =
        'Pairing failed. Check the latest code in the terminal and try again.';
      return;
    }
    const expectedProof = await exchangeProof(
      code,
      'server',
      pairingNonce,
      challenge,
      `:${credentialId}`,
    );
    if (!proofsEqual(body.proof, expectedProof)) {
      els.pairMessage.textContent =
        'Pairing failed because the daemon could not prove its identity.';
      return;
    }
    const credentialSecret = await exchangeProof(
      code,
      'credential',
      pairingNonce,
      challenge,
      `:${credentialId}`,
    );
    await savePairingCredential(baseUrl, `${credentialId}.${credentialSecret}`);
    pendingPairingNonce = null;
    els.pairMessage.textContent = 'Paired.';
    els.pairCode.value = '';
    notifyDaemonReady();
    await tick();
  } finally {
    els.pairSubmit.disabled = false;
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
els.pairForm.addEventListener('submit', (event) => {
  void submitPairing(event);
});
els.pairCode.addEventListener('input', () => {
  const hex = els.pairCode.value
    .replace(/[^0-9a-f]/gi, '')
    .slice(0, 32)
    .toLowerCase();
  els.pairCode.value = (hex.match(/.{1,4}/g) || []).join('-');
});

// Fill the command synchronously so first paint isn't an empty prompt — the id
// is available immediately; tick() then keeps title/desc/command per probe.
els.cmd.textContent = allowOriginCommand(chrome.runtime.id);

tick();
setInterval(tick, POLL_MS);
