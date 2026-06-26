/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Side panel host: loads the daemon Web Shell (chat + tools UI) into an iframe.
 * The extension has no UI of its own — it's a CDP-tunnel pipe — so the panel
 * just frames the daemon. The daemon allows this only for extension origins
 * passed via `--allow-origin` (see serve/web-shell-static.ts frame-ancestors).
 *
 * baseUrl mirrors the rest of the extension's daemon config (chrome.storage
 * override, default :4170). Kept as a plain script (no bundler) so it stays a
 * static asset; the constants intentionally duplicate daemon/config.ts.
 */
/* global chrome, document */

const STORAGE_KEY = 'qwen.daemon';
const DEFAULT_BASE_URL = 'http://127.0.0.1:4170';

(async () => {
  let baseUrl = DEFAULT_BASE_URL;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const cfg = (stored && stored[STORAGE_KEY]) || {};
    if (cfg.baseUrl) baseUrl = String(cfg.baseUrl).trim() || DEFAULT_BASE_URL;
  } catch {
    baseUrl = DEFAULT_BASE_URL;
  }

  const iframe = document.getElementById('ui');
  const status = document.getElementById('status');
  iframe.addEventListener('load', () => {
    status.style.display = 'none';
    iframe.style.display = 'block';
  });
  iframe.src = baseUrl;
})();
