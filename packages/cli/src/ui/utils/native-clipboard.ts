/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';

const debugLogger = createDebugLogger('NATIVE_CLIPBOARD');

const ADDON_NAME = '@teddyzhu/clipboard';
const HELPER_TIMEOUT_MS = 5000;
const MAX_HELPER_STDOUT_BYTES = 16 * 1024 * 1024;

/** clipboard-rs's error when another client owns the selection. It is
 *  transient, so reads retry and never surface it as clipboard content. */
export const CLIPBOARD_BUSY_MESSAGE = 'Somebody else owns the clipboard now';

/** Marks the start of the read helper's payload so addon diagnostics printed
 *  to stdout are discarded instead of pasted as clipboard text. */
export const CLIPBOARD_READ_MARKER = '\u001eQWEN_CLIPBOARD_READ\u001e';

interface NativeClipboardModule {
  setClipboardText?: (text: string) => void;
  getClipboardText?: () => string;
}

export interface HelperResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The child produced more stdout than the cap; the payload is incomplete. */
  overflow?: boolean;
}

let modulePromise: Promise<NativeClipboardModule | null> | undefined;
let addonEntry: string | null | undefined;

const COPY_HELPER_SCRIPT = `
const mod = require(process.env.QWEN_CLIPBOARD_ADDON);
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  try {
    mod.setClipboardText(Buffer.concat(chunks).toString('utf8'));
    // Exiting immediately can hand the selection to the OS clipboard manager
    // before it has copied the contents, so the next read sees an empty
    // clipboard. Staying alive briefly lets the handoff finish.
    setTimeout(() => process.exit(0), 150);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message);
    process.exit(1);
  }
});
`;

const READ_HELPER_SCRIPT = `
const mod = require(process.env.QWEN_CLIPBOARD_ADDON);
const BUSY = ${JSON.stringify(CLIPBOARD_BUSY_MESSAGE)};
const MARKER = ${JSON.stringify(CLIPBOARD_READ_MARKER)};
let attempt = 0;
function read() {
  try {
    const text = mod.getClipboardText() || '';
    if (text.trim() === BUSY) throw new Error(BUSY);
    process.stdout.write(MARKER + text, (error) => process.exit(error ? 1 : 0));
  } catch (error) {
    if (++attempt < 5) {
      setTimeout(read, 60);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message);
    process.exit(1);
  }
}
read();
`;

async function loadNativeClipboardModule(): Promise<NativeClipboardModule | null> {
  modulePromise ??= import(ADDON_NAME)
    .then((module) => {
      const candidate = (module.default ?? module) as NativeClipboardModule;
      return typeof candidate.setClipboardText === 'function' ||
        typeof candidate.getClipboardText === 'function'
        ? candidate
        : null;
    })
    .catch((error: unknown) => {
      debugLogger.debug(
        'Native clipboard addon is unavailable in this runtime:',
        error,
      );
      return null;
    });
  return modulePromise;
}

/** Resolve the addon entry so a Node child can load the same installation. */
function resolveAddonEntry(): string | null {
  if (addonEntry !== undefined) return addonEntry;
  try {
    addonEntry = createRequire(import.meta.url).resolve(ADDON_NAME);
  } catch (error) {
    debugLogger.debug('Could not resolve native clipboard addon:', error);
    addonEntry = null;
  }
  return addonEntry;
}

/**
 * Resolve a Node executable for the helper. Bun's snap/managed runtime often
 * has a sanitized PATH, so prefer the launcher-provided path or the active
 * nvm bin before falling back to PATH lookup.
 */
function resolveNodeBinary(): string {
  const explicit = process.env['QWEN_NODE_BINARY'];
  if (explicit) return explicit;
  if (!process.versions['bun']) return process.execPath;

  const nvmBin = process.env['NVM_BIN'];
  if (nvmBin) {
    const candidate = join(nvmBin, 'node');
    if (existsSync(candidate)) return candidate;
  }
  return 'node';
}

function runNodeHelper(
  script: string,
  input: string | null,
): Promise<HelperResult | null> {
  const entry = resolveAddonEntry();
  if (!entry) return Promise.resolve(null);

  return new Promise((resolve) => {
    const child = spawn(resolveNodeBinary(), ['-e', script], {
      env: { ...process.env, QWEN_CLIPBOARD_ADDON: entry },
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    let overflow = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr,
        overflow,
      });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      finish(null);
    }, HELPER_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return;
      const remaining = MAX_HELPER_STDOUT_BYTES - stdoutBytes;
      if (chunk.length > remaining) {
        if (remaining > 0) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes += remaining;
        }
        overflow = true;
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      debugLogger.debug('Native clipboard helper failed to spawn:', error);
      finish(null);
    });
    child.on('close', (code) => finish(code));

    if (input !== null) {
      child.stdin?.on('error', (error) => {
        debugLogger.debug('Native clipboard helper stdin failed:', error);
        child.kill('SIGKILL');
        finish(null);
      });
      child.stdin?.end(input);
    }
  });
}

function normalizeClipboardText(text: string): string | null {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // The addon can return its ownership error as text in some races; it is not
  // clipboard content, so never hand it to the composer as a paste.
  if (normalized.trim() === CLIPBOARD_BUSY_MESSAGE) return null;
  return normalized || null;
}

/** Keep only what the helper wrote after its marker, discarding native noise. */
function extractReadPayload(stdout: string): string {
  const markerIndex = stdout.lastIndexOf(CLIPBOARD_READ_MARKER);
  return markerIndex >= 0
    ? stdout.slice(markerIndex + CLIPBOARD_READ_MARKER.length)
    : stdout;
}

export interface NativeClipboardBridgeDeps {
  loadModule: () => Promise<NativeClipboardModule | null>;
  runHelper: (
    script: string,
    input: string | null,
  ) => Promise<HelperResult | null>;
}

export interface NativeClipboardBridge {
  copyText: (text: string) => Promise<boolean>;
  readText: () => Promise<string | null>;
}

/**
 * Strategy for native clipboard I/O. Writes always run in a Node child so the
 * addon's stdout cannot reach the renderer; reads use the addon in process
 * when it loads and fall back to the child. Tests inject fakes so no real
 * clipboard is touched.
 */
export function createNativeClipboardBridge(
  deps: NativeClipboardBridgeDeps,
): NativeClipboardBridge {
  return {
    async copyText(text: string): Promise<boolean> {
      // Always write from a child: clipboard-rs prints ownership diagnostics
      // (e.g. "Somebody else owns the clipboard now") to stdout while it
      // replaces an X11 owner. In-process that stdout is the TUI's alternate
      // screen, so the message lands on the composer row. The helper's stdout
      // is a pipe, which keeps the native output out of the renderer.
      const result = await deps.runHelper(COPY_HELPER_SCRIPT, text);
      if (result?.code === 0) return true;
      if (result) {
        debugLogger.debug(
          `Native clipboard helper exited ${result.code}: ${result.stderr}`,
        );
      }
      return false;
    },

    async readText(): Promise<string | null> {
      const module = await deps.loadModule();
      if (module?.getClipboardText) {
        try {
          const text = module.getClipboardText();
          if (text.trim() !== CLIPBOARD_BUSY_MESSAGE) {
            return normalizeClipboardText(text);
          }
        } catch (error) {
          debugLogger.debug('Native clipboard read failed in-process:', error);
        }
      }

      const result = await deps.runHelper(READ_HELPER_SCRIPT, null);
      if (result?.code !== 0) {
        if (result) {
          debugLogger.debug(
            `Native clipboard helper exited ${result.code}: ${result.stderr}`,
          );
        }
        return null;
      }
      if (result?.overflow) {
        debugLogger.warn(
          'Native clipboard read exceeded the helper output cap; dropping it',
        );
        return null;
      }
      return normalizeClipboardText(extractReadPayload(result.stdout));
    },
  };
}

const defaultBridge = createNativeClipboardBridge({
  loadModule: loadNativeClipboardModule,
  runHelper: runNodeHelper,
});

/**
 * Write text through the native clipboard addon. Writes always run in a Node
 * child so the addon's stdout stays out of the renderer; the child lingers
 * briefly for the OS clipboard handoff.
 *
 * Returns false when the child route is unavailable, leaving the caller free
 * to fall back to OSC 52.
 */
export function copyTextViaNativeClipboard(text: string): Promise<boolean> {
  return defaultBridge.copyText(text);
}

/**
 * Read text through the native clipboard addon, in process when it loads and
 * through the Node child otherwise. Returns null when the addon is unavailable
 * or the clipboard holds no text.
 */
export function readTextViaNativeClipboard(): Promise<string | null> {
  return defaultBridge.readText();
}
