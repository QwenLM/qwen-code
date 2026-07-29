/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, down, status, upJson } from './orchestrator.js';
import { readState } from './state.js';
import type { RunCommand, CommandResult } from './exec.js';

const RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'laptop-wsl.tn.ts.net.', TailscaleIPs: ['100.1.2.3'] },
});
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

// A short static self-signed EC cert fixture (10-year validity), used only to
// exercise the real `X509Certificate(...).validTo` parse path in
// `readCertExpiry` — generated once via:
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
//     -keyout /dev/null -out fixture.crt -days 3650 -nodes -subj "/CN=test.ts.net"
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIBgTCCASegAwIBAgIUcjHPDdamKJs+DNUfYI8MiyFpPBowCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLdGVzdC50cy5uZXQwHhcNMjYwNzI5MDE1MzAzWhcNMzYwNzI2
MDE1MzAzWjAWMRQwEgYDVQQDDAt0ZXN0LnRzLm5ldDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABCzTeL4514klGDNi1b/spMWeWZUEOXSdY/eDuM0GRiYJqmPZaRdE
+LCdKyeUq12EMof0ZWIsxvHYfgt53t/4H6+jUzBRMB0GA1UdDgQWBBRV9IfASE0x
p5kvjZnS8KtnAzpbATAfBgNVHSMEGDAWgBRV9IfASE0xp5kvjZnS8KtnAzpbATAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIBMkIA5rkPP1ObJJzo1w
6zBzuKdajpOeIpRsNbr9jIasAiEA8NdmkV99/Xd3399uUYeLSXyGnK978RKfGBgg
cukmM3E=
-----END CERTIFICATE-----
`;
// Expected ISO expiry, derived the same way `readCertExpiry` does — proves
// the orchestrator's parse matches reality without hardcoding a date string
// that would drift if the fixture is ever regenerated.
const FIXTURE_CERT_EXPIRY_ISO = new Date(
  new X509Certificate(FIXTURE_CERT).validTo,
).toISOString();

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});
const mkdir = () => (dir = mkdtempSync(join(tmpdir(), 'launcher-')));

// Tiny bootstrap-poll timing by default so tests that reach `up`'s step 4
// without pre-seeding owner-bootstrap.code (e.g. the idempotency and
// certExpiry tests below) fail fast on the poll instead of waiting out the
// real ~15s production timeout. Tests that specifically exercise the poll
// (see `bootstrap code polling` below) override these per-case.
const DEPS = (d: string, run: RunCommand) => ({
  run,
  dir: d,
  port: 8443,
  unit: 'qwen-rc-gateway',
  serveCmd: ['qwen-rc'],
  bootstrapTimeoutMs: 50,
  bootstrapPollMs: 5,
});

// tailnet Running + cert ok; the is-active answer is read live from `active()`,
// and `onStart` fires when the gateway unit is launched — so a test can model
// "inactive until started" (exercises the start path + idempotency). `onStop`
// fires with the unit name systemctl was asked to stop, so a test can assert
// which unit was actually recorded/stopped rather than just that stop ran.
function base(
  active: () => boolean,
  onStart?: () => void,
  onStop?: (unit: string) => void,
): RunCommand {
  return async (argv) => {
    const k = argv.join(' ');
    if (k === 'tailscale status --json') return ok(RUNNING);
    if (argv[0] === 'tailscale' && argv[1] === 'cert') return ok();
    if (argv[0] === 'systemd-run') {
      onStart?.();
      return ok();
    }
    if (k.startsWith('systemctl --user is-active'))
      return active()
        ? ok('active\n')
        : { code: 3, stdout: 'inactive\n', stderr: '' };
    if (k.startsWith('systemctl --user stop')) {
      onStop?.(argv[3]);
      return ok();
    }
    return { code: 1, stdout: '', stderr: `unstubbed ${k}` };
  };
}

describe('up', () => {
  it('starts the stack and returns connect info + QR + bootstrap code', async () => {
    const d = mkdir();
    writeFileSync(join(d, 'owner-bootstrap.code'), 'ABCD-1234\n');
    let starts = 0;
    const run = base(
      () => starts > 0,
      () => {
        starts++;
      },
    ); // inactive until started
    const res = await up(DEPS(d, run));
    expect(res.ok).toBe(true);
    expect(starts).toBe(1); // the start path ran
    expect(res.url).toBe('https://laptop-wsl.tn.ts.net:8443/ui/');
    expect(res.host).toBe('laptop-wsl.tn.ts.net');
    expect(res.port).toBe(8443);
    expect(res.bootstrapCode).toBe('ABCD-1234');
    expect(typeof res.qr).toBe('string');
    expect(res.qr!.length).toBeGreaterThan(0);
  });

  it('is idempotent — a second up does not start a second unit', async () => {
    const d = mkdir();
    let starts = 0;
    const run = base(
      () => starts > 0,
      () => {
        starts++;
      },
    );
    await up(DEPS(d, run)); // starts (was inactive)
    await up(DEPS(d, run)); // sees is-active → skips
    expect(starts).toBe(1);
  });

  it('surfaces the HTTPS-not-enabled hint and starts nothing', async () => {
    const d = mkdir();
    let started = false;
    const run: RunCommand = async (argv) => {
      const k = argv.join(' ');
      if (k === 'tailscale status --json') return ok(RUNNING);
      if (argv[0] === 'tailscale' && argv[1] === 'cert')
        return {
          code: 1,
          stdout: '',
          stderr: 'HTTPS is not enabled in the admin console',
        };
      if (argv[0] === 'systemd-run') {
        started = true;
        return ok();
      }
      return { code: 1, stdout: '', stderr: k };
    };
    const res = await up(DEPS(d, run));
    expect(res.ok).toBe(false);
    expect(res.hint).toMatch(/HTTPS.*admin console/i);
    expect(started).toBe(false); // cert fails before the start step is reached
  });

  it('surfaces the needs-auth URL when logged out', async () => {
    const d = mkdir();
    const run: RunCommand = async (argv) => {
      if (argv.join(' ') === 'tailscale status --json')
        return ok(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }));
      if (argv[1] === 'up')
        return {
          code: 1,
          stdout: '',
          stderr:
            'To authenticate, visit:\n\thttps://login.tailscale.com/a/deadbeef\n',
        };
      return { code: 1, stdout: '', stderr: 'x' };
    };
    const res = await up(DEPS(d, run));
    expect(res.ok).toBe(false);
    expect(res.hint).toContain('https://login.tailscale.com/a/deadbeef');
  });

  it('gives the D-Bus remedy when systemd --user is unavailable', async () => {
    const d = mkdir();
    const run: RunCommand = async (argv) => {
      const k = argv.join(' ');
      if (k === 'tailscale status --json') return ok(RUNNING);
      if (argv[0] === 'tailscale' && argv[1] === 'cert') return ok();
      if (k.startsWith('systemctl --user is-active'))
        return {
          code: 1,
          stdout: '',
          stderr: 'Failed to connect to bus: No such file or directory',
        };
      if (argv[0] === 'systemd-run')
        return {
          code: 1,
          stdout: '',
          stderr: 'Failed to connect to bus: No such file or directory',
        };
      return { code: 1, stdout: '', stderr: k };
    };
    const res = await up(DEPS(d, run));
    expect(res.ok).toBe(false);
    expect(res.hint).toMatch(/XDG_RUNTIME_DIR|enable-linger/);
  });
});

describe('upJson', () => {
  it('never includes bootstrapCode — the --json payload must not leak the one-time OWNER credential', () => {
    const r = {
      ok: true,
      url: 'https://laptop-wsl.tn.ts.net:8443/ui/',
      host: 'laptop-wsl.tn.ts.net',
      port: 8443,
      unit: 'qwen-rc-gateway',
      bootstrapCode: 'SECRET-1',
      certExpiry: '2030-01-01T00:00:00.000Z',
    };
    const json = upJson(r);
    expect(json).not.toHaveProperty('bootstrapCode');
    expect(json).toEqual({
      status: 'running',
      url: r.url,
      host: r.host,
      port: r.port,
      unit: r.unit,
      certExpiry: r.certExpiry,
      hint: undefined,
    });
    expect(JSON.stringify(json)).not.toContain('SECRET-1');
  });

  it('reports status "error" when ok is false', () => {
    const json = upJson({ ok: false, hint: 'something failed' });
    expect(json['status']).toBe('error');
    expect(json).not.toHaveProperty('bootstrapCode');
  });
});

describe('renderQr', () => {
  it('returns a non-empty multi-line QR string', async () => {
    const { renderQr } = await import('./qr.js');
    const out = await renderQr('https://example.ts.net:8443/ui/');
    expect(out.length).toBeGreaterThan(0);
    expect(out.split('\n').length).toBeGreaterThan(3);
  });
});

describe('certExpiry', () => {
  // `tailscale cert` here actually writes the fixture cert to the requested
  // `--cert-file` path, so `up`'s `readCertExpiry` reads a real file — this
  // exercises the X509Certificate parse itself, not just the wiring.
  function withRealCert(
    active: () => boolean,
    onStart?: () => void,
  ): RunCommand {
    return async (argv) => {
      const k = argv.join(' ');
      if (k === 'tailscale status --json') return ok(RUNNING);
      if (argv[0] === 'tailscale' && argv[1] === 'cert') {
        const certFile = argv[argv.indexOf('--cert-file') + 1];
        writeFileSync(certFile, FIXTURE_CERT);
        return ok();
      }
      if (argv[0] === 'systemd-run') {
        onStart?.();
        return ok();
      }
      if (k.startsWith('systemctl --user is-active'))
        return active()
          ? ok('active\n')
          : { code: 3, stdout: 'inactive\n', stderr: '' };
      if (k.startsWith('systemctl --user stop')) return ok();
      return { code: 1, stdout: '', stderr: `unstubbed ${k}` };
    };
  }

  it('up populates certExpiry from the real cert file', async () => {
    const d = mkdir();
    let starts = 0;
    const run = withRealCert(
      () => starts > 0,
      () => {
        starts++;
      },
    );
    const res = await up(DEPS(d, run));
    expect(res.ok).toBe(true);
    expect(res.certExpiry).toBe(FIXTURE_CERT_EXPIRY_ISO);
  });

  it('status surfaces the certExpiry persisted by a prior up', async () => {
    const d = mkdir();
    let starts = 0;
    const run = withRealCert(
      () => starts > 0,
      () => {
        starts++;
      },
    );
    await up(DEPS(d, run));
    const s = await status(DEPS(d, run));
    expect(s.certExpiry).toBe(FIXTURE_CERT_EXPIRY_ISO);
  });
});

describe('bootstrap code polling', () => {
  // `up`'s step 4 no longer reads owner-bootstrap.code synchronously — it
  // polls, because the gateway unit writes that file from its own process
  // well after `systemd-run` returns. These three cases pin the poll's
  // observable behavior; the shared `DEPS` helper already sets
  // `bootstrapTimeoutMs: 50, bootstrapPollMs: 5` so none of this incurs a
  // real multi-second wait.

  it('returns the code immediately when the file is already present (first attempt, no sleep)', async () => {
    const d = mkdir();
    writeFileSync(join(d, 'owner-bootstrap.code'), 'READY-1\n');
    let starts = 0;
    const run = base(
      () => starts > 0,
      () => {
        starts++;
      },
    );
    const res = await up(DEPS(d, run));
    expect(res.ok).toBe(true);
    expect(res.bootstrapCode).toBe('READY-1');
    expect(res.hint).toBeUndefined();
  });

  it('returns the code once it appears after a couple of polls', async () => {
    const d = mkdir();
    let starts = 0;
    const run = base(
      () => starts > 0,
      () => {
        starts++;
      },
    );
    // The gateway "finishes booting" a few poll intervals in — write the
    // file from a timer, not synchronously, so the poll loop actually has
    // to retry rather than seeing it on the first check.
    setTimeout(() => {
      writeFileSync(join(d, 'owner-bootstrap.code'), 'LATE-2\n');
    }, 20);
    const res = await up({
      ...DEPS(d, run),
      bootstrapTimeoutMs: 500,
      bootstrapPollMs: 5,
    });
    expect(res.ok).toBe(true);
    expect(res.bootstrapCode).toBe('LATE-2');
    expect(res.hint).toBeUndefined();
  });

  it('gives up after the timeout and leaves bootstrapCode undefined, with a "still starting" hint', async () => {
    const d = mkdir();
    let starts = 0;
    const run = base(
      () => starts > 0,
      () => {
        starts++;
      },
    );
    // owner-bootstrap.code is never written in this test.
    const res = await up({
      ...DEPS(d, run),
      bootstrapTimeoutMs: 30,
      bootstrapPollMs: 5,
    });
    expect(res.ok).toBe(true); // the gateway did start; only the code read timed out
    expect(res.bootstrapCode).toBeUndefined();
    expect(res.hint).toMatch(/starting|status/i);
    // The note must actually reach the --json surface (upJson passes `hint`
    // through unconditionally) — that's the mechanism this finding relies on
    // to let a machine caller learn "still starting, retry/poll status".
    expect(upJson(res)['hint']).toMatch(/starting|status/i);
  });
});

describe('down', () => {
  it('stops the recorded unit and clears state', async () => {
    const d = mkdir();
    let starts = 0;
    let stoppedUnit: string | undefined;
    const run = base(
      () => starts > 0,
      () => {
        starts++;
      },
      (unit) => {
        stoppedUnit = unit;
      },
    );
    const deps = DEPS(d, run);
    writeFileSync(join(d, 'owner-bootstrap.code'), 'PRIOR-CODE\n');
    await up(deps); // writes state + records the unit that was started
    expect(readState(d)).not.toBeNull(); // sanity: state exists before down
    // Sanity: the code file is still present right up to the moment `down`
    // runs — `up` reads it, it doesn't consume/delete it. So the removal
    // asserted below is attributable to `down`, not to anything upstream.
    expect(existsSync(join(d, 'owner-bootstrap.code'))).toBe(true);

    const res = await down(deps);

    expect(res.ok).toBe(true);
    expect(stoppedUnit).toBe('qwen-rc-gateway'); // the unit recorded in state was actually stopped
    expect(readState(d)).toBeNull(); // state was cleared
    // Each gateway boot mints a fresh code; leaving the old file around
    // would let the next `up` read a STALE code that doesn't match the next
    // boot's, breaking pairing. `down` must remove it.
    expect(existsSync(join(d, 'owner-bootstrap.code'))).toBe(false);
  });

  it('is idempotent when there is no prior state', async () => {
    const d = mkdir();
    const res = await down(
      DEPS(
        d,
        base(() => true),
      ),
    );
    expect(res.ok).toBe(true);
    expect(readState(d)).toBeNull();
  });
});

describe('status', () => {
  it('reports running with the connect url after up', async () => {
    const d = mkdir();
    writeFileSync(join(d, 'owner-bootstrap.code'), 'X\n');
    let starts = 0;
    const run = base(
      () => starts > 0,
      () => {
        starts++;
      },
    );
    await up(DEPS(d, run));
    const s = await status(DEPS(d, run));
    expect(s.running).toBe(true);
    expect(s.url).toBe('https://laptop-wsl.tn.ts.net:8443/ui/');
  });
});
