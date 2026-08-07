/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import type { RunCommand } from './exec.js';
import { ensureUp, nodeIdentity } from './tailscale.js';
import { ensureCert } from './cert.js';
import { startUnit, stopUnit, isActive } from './process.js';
import {
  readState,
  writeState,
  clearState,
  type LauncherState,
} from './state.js';
import { renderQr } from './qr.js';
import { BOOTSTRAP_CODE_FILENAME } from '../bootstrap.js';

export interface Deps {
  run: RunCommand;
  dir: string; // ~/.qwen/rc
  port: number;
  unit: string; // e.g. qwen-rc-gateway
  serveCmd: string[]; // PATH-independent argv prefix for qwen-rc, e.g. [process.argv[0], process.argv[1]]
  // The gateway unit writes owner-bootstrap.code from inside the unit
  // process, hundreds of ms after `systemd-run` merely accepts the job —
  // `up` polls for it. These are injectable purely so tests don't incur
  // real multi-second waits; production uses the defaults below.
  bootstrapTimeoutMs?: number;
  bootstrapPollMs?: number;
}

/** Production polling defaults — see `Deps.bootstrapTimeoutMs`/`bootstrapPollMs`. */
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 15_000;
const DEFAULT_BOOTSTRAP_POLL_MS = 200;

export interface UpResult {
  ok: boolean;
  url?: string;
  host?: string;
  port?: number;
  unit?: string;
  bootstrapCode?: string;
  certExpiry?: string;
  qr?: string;
  hint?: string;
}

function connectUrl(host: string, port: number): string {
  return `https://${host}:${port}/ui/`;
}

function readBootstrapCode(dir: string): string | undefined {
  const p = join(dir, BOOTSTRAP_CODE_FILENAME);
  if (!existsSync(p)) return undefined;
  const c = readFileSync(p, 'utf8').trim();
  return c.length > 0 ? c : undefined;
}

/**
 * Poll for `<dir>/owner-bootstrap.code` until it exists (with non-empty
 * content) or `timeoutMs` elapses. The gateway unit writes this file from
 * its own process well after `systemd-run` returns, so a same-tick read
 * (the previous behavior) races the gateway's boot and, on a first-ever
 * `up`, reliably loses.
 *
 * The check always runs BEFORE the delay, so a file that is already present
 * (the common case in tests, and on a warm restart if `down` didn't run)
 * returns immediately with no real sleep incurred.
 *
 * Deliberately keyed on `readBootstrapCode`'s non-empty check, not
 * `existsSync`: the gateway creates-then-writes the file, so a bare
 * existence check can observe a truncated/zero-length file mid-write. That
 * would return an incomplete code instead of continuing to poll — so this
 * treats a present-but-empty file the same as absent and keeps polling.
 */
async function waitForBootstrapCode(
  dir: string,
  timeoutMs: number,
  pollMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = readBootstrapCode(dir);
    if (code) return code;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Best-effort read of a cert's `notAfter` as an ISO string. `undefined` on any failure. */
function readCertExpiry(certPath: string): string | undefined {
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    return new Date(cert.validTo).toISOString();
  } catch {
    return undefined;
  }
}

export async function up(deps: Deps): Promise<UpResult> {
  const { run, dir, port, unit, serveCmd } = deps;

  // 1. Tailnet.
  const upOutcome = await ensureUp(run);
  if (upOutcome.kind !== 'running') {
    const hint =
      upOutcome.kind === 'needs-auth'
        ? `Authenticate this device, then re-run \`qwen-rc up\`:\n  ${upOutcome.authUrl}`
        : upOutcome.kind === 'not-installed'
          ? 'Tailscale is not installed in WSL. Install it, then re-run.'
          : upOutcome.kind === 'needs-operator'
            ? 'Run `tailscale set --operator=$USER` once so up can manage Tailscale without sudo.'
            : `tailscale up failed: ${upOutcome.message}`;
    return { ok: false, hint };
  }

  const id = await nodeIdentity(run);
  if (!id)
    return {
      ok: false,
      hint: 'Could not read the Tailscale node identity (status --json).',
    };

  // 2. TLS cert.
  const cert = await ensureCert(run, id.host, join(dir, 'tls'));
  if (cert.kind !== 'ok') {
    const hint =
      cert.kind === 'https-not-enabled'
        ? 'Enable HTTPS/MagicDNS for your tailnet in the Tailscale admin console, then re-run.'
        : `tailscale cert failed: ${cert.message}`;
    return { ok: false, hint };
  }

  const url = connectUrl(id.host, port);
  const certExpiry = readCertExpiry(cert.pair.certPath);

  // 3. Start the gateway unit — unless already active (idempotent).
  if (!(await isActive(run, unit))) {
    const serveArgv = [
      ...serveCmd, // PATH-independent (systemd --user has systemd's env, not the shell's)
      'serve',
      '--host',
      id.ip,
      '--tls',
      cert.pair.certPath,
      '--tls-key',
      cert.pair.keyPath,
      '--port',
      String(port),
    ];
    const started = await startUnit(run, unit, serveArgv);
    if (started.code !== 0) {
      const err = started.stderr || started.stdout;
      // The Electron path (`wsl.exe -- qwen-rc up`) may have no user-session
      // D-Bus, so systemd --user fails; give the specific remedy, not a raw error.
      const busDown =
        /failed to connect to bus|XDG_RUNTIME_DIR|no medium found/i.test(err);
      const hint = busDown
        ? 'systemd --user is unavailable in this shell (no session D-Bus). Set `XDG_RUNTIME_DIR=/run/user/$(id -u)` and run `loginctl enable-linger $USER` once — this is the usual cause when launched via wsl.exe.'
        : `Failed to start the gateway unit: ${err.trim().slice(0, 500)}`;
      return { ok: false, hint };
    }
  }

  const state: LauncherState = {
    unit,
    url,
    host: id.host,
    port,
    certExpiry,
  };
  writeState(dir, state);

  // 4. Connect info. The gateway (whether just started, or already active
  // from a prior `up`) writes owner-bootstrap.code from inside the unit
  // process — poll for it rather than reading synchronously, which would
  // race the gateway's boot.
  const bootstrapCode = await waitForBootstrapCode(
    dir,
    deps.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    deps.bootstrapPollMs ?? DEFAULT_BOOTSTRAP_POLL_MS,
  );
  // Embed the pairing code in the URL fragment so a scanned QR auto-fills and
  // pairs (the /ui/ page reads `#code=`, then scrubs it). Human terminal output
  // only — `upJson()` omits `qr`, so the code never reaches the `--json` stream;
  // it rides the fragment, which never hits server logs/Referer.
  const qrTarget =
    bootstrapCode === undefined
      ? url
      : `${url}#code=${encodeURIComponent(bootstrapCode)}`;
  const qr = await renderQr(qrTarget).catch(() => undefined);
  const hint =
    bootstrapCode === undefined
      ? 'The pairing code was not ready yet — the gateway may still be starting. Run `qwen-rc status`, then retry `qwen-rc up` to fetch it.'
      : undefined;
  return {
    ok: true,
    url,
    host: id.host,
    port,
    unit,
    bootstrapCode,
    certExpiry,
    qr,
    hint,
  };
}

/**
 * Shape the `--json` payload for `qwen-rc up`. Deliberately OMITS
 * `bootstrapCode`: `--json` targets a machine-captured stream (e.g. the
 * Electron/wsl.exe launcher path), and the bootstrap code is a one-time OWNER
 * credential that must not be echoed onto a surface that may be logged or
 * relayed. The human-readable path (cli.ts, non-`--json`) still prints it to
 * the terminal.
 */
export function upJson(r: UpResult): Record<string, unknown> {
  return {
    status: r.ok ? 'running' : 'error',
    url: r.url,
    host: r.host,
    port: r.port,
    unit: r.unit,
    certExpiry: r.certExpiry,
    hint: r.hint,
  };
}

export async function down(deps: Deps): Promise<{ ok: boolean }> {
  const { run, dir, unit } = deps;
  const st = readState(dir);
  await stopUnit(run, st?.unit ?? unit); // idempotent; a stopped unit is fine
  clearState(dir);
  // Each gateway boot mints a fresh owner-bootstrap code. Leaving the old
  // file behind would let a subsequent `up` read a STALE code that doesn't
  // match the next boot's — pairing would then fail. Removing it here means
  // a following `up` only ever sees a code minted by the gateway it started.
  rmSync(join(dir, BOOTSTRAP_CODE_FILENAME), { force: true });
  return { ok: true };
}

export async function status(
  deps: Deps,
): Promise<{ running: boolean; url?: string; certExpiry?: string }> {
  const { run, dir, unit } = deps;
  const st = readState(dir);
  const running = await isActive(run, st?.unit ?? unit);
  return { running, url: st?.url, certExpiry: st?.certExpiry };
}
