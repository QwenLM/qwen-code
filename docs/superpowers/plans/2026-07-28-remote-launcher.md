# qwen-rc up/down/status launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-command bring-up/down of the WSL2-hosted remote-control stack over Tailscale — `qwen-rc up` (tailscale up + cert + `qwen-rc serve` as a systemd transient unit, surfacing a connect URL + QR + `--json`), `down`, `status`.

**Architecture:** A new `packages/rc-gateway/src/launcher/` subsystem behind an injected `RunCommand` exec seam (so every flow is unit-testable with canned command outputs), plus three top-level subcommands in `cli.ts`. It only _invokes_ the existing `qwen-rc serve` + local `tailscale`/`systemctl` — no core changes.

**Tech Stack:** TypeScript, Node (`child_process`, `os`, `fs`), Vitest. New dep: `qrcode` (terminal QR).

## Global Constraints

- **No core/daemon changes.** All new code under `packages/rc-gateway/src/launcher/` + three subcommands in `packages/rc-gateway/src/cli.ts`. Nothing under `packages/cli/src/serve` or `packages/core`.
- **Everything external goes through the injected `RunCommand` seam** — `type RunCommand = (argv: string[]) => Promise<CommandResult>` — so units are testable with stubbed outputs. Flows take `run` as a parameter; only `cli.ts` wires the real `child_process` impl.
- **The gateway is started via `qwen-rc serve --host <ts-ip> --tls <cert> --tls-key <key> --port <port>`** (bind mode is derived from `--tls`/`--tls-key`; a non-loopback host requires TLS — which this satisfies). Run it as a systemd transient unit: `systemd-run --user --unit=<unit> -- <cmd…>`; stop with `systemctl --user stop <unit>`; liveness `systemctl --user is-active <unit>`.
- **State dir** `~/.qwen/rc/` = `join(homedir(), '.qwen', 'rc')`. State file `launcher-state.json`; TLS pair under `~/.qwen/rc/tls/`; the owner pairing code is read from the gateway's existing `~/.qwen/rc/owner-bootstrap.code`.
- **`--json` carries only connect metadata** (url, host, port, unit, certExpiry) and NOT the owner pairing code (a one-time credential must not enter a machine-captured stream — a `--json` caller reads the 0600 `owner-bootstrap.code` file itself). The **human-readable** output additionally prints the pairing code to the operator's terminal. Neither surface carries session or tool content.
- Idempotent: `up` while running re-prints connect info (no second instance); `down` while stopped succeeds.
- **PATH-independence:** the transient unit runs under systemd's environment, NOT the caller's shell — so the gateway is launched by an explicit argv prefix (`serveCmd`, e.g. `[process.argv[0], process.argv[1]]`), never by relying on `qwen-rc` being on PATH.
- **Known integration risk (document, don't test around):** `systemd-run --user` / `systemctl --user` require a user-session D-Bus — under `wsl.exe -- qwen-rc up` (a non-login shell, the Electron path) that can be absent, failing with "Failed to connect to bus." `up` MUST detect this and emit an actionable hint (remedy: `XDG_RUNTIME_DIR=/run/user/$(id -u)` + `loginctl enable-linger $USER`). This is the analogue of the mirrored-networking risk — surfaced, not silently swallowed.
- **Tests prove orchestration, not reachability.** Every test stubs `RunCommand`, so a green `up` only proves the flow composed the right commands — it does NOT prove the phone can reach the gateway (real Tailscale/systemd/TLS). That end-to-end check stays on the operator's manual first-run checklist; do not add a test that pretends to cover it.

---

### Task 1: exec seam + Tailscale + cert layer

**Files:**

- Create: `packages/rc-gateway/src/launcher/exec.ts`
- Create: `packages/rc-gateway/src/launcher/tailscale.ts`
- Create: `packages/rc-gateway/src/launcher/cert.ts`
- Test: `packages/rc-gateway/src/launcher/tailscale.test.ts`, `packages/rc-gateway/src/launcher/cert.test.ts`

**Interfaces:**

- Produces:
  - `exec.ts`: `interface CommandResult { code: number; stdout: string; stderr: string }`; `type RunCommand = (argv: string[]) => Promise<CommandResult>`; `realRunCommand: RunCommand`.
  - `tailscale.ts`: `interface NodeIdentity { host: string; ip: string }`; `type UpOutcome = { kind: 'running' } | { kind: 'needs-auth'; authUrl: string } | { kind: 'not-installed' } | { kind: 'needs-operator' } | { kind: 'error'; message: string }`; `ensureUp(run): Promise<UpOutcome>`; `nodeIdentity(run): Promise<NodeIdentity | null>`.
  - `cert.ts`: `interface CertPair { certPath: string; keyPath: string; expiry?: Date }`; `type CertOutcome = { kind: 'ok'; pair: CertPair } | { kind: 'https-not-enabled' } | { kind: 'error'; message: string }`; `ensureCert(run, host, dir): Promise<CertOutcome>`.

- [ ] **Step 1: Write `exec.ts` (no test needed — thin wrapper)**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFile } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected exec boundary — every launcher flow calls the outside world through this. */
export type RunCommand = (argv: string[]) => Promise<CommandResult>;

/** Real impl over child_process.execFile. Never rejects — a failed/absent command resolves with a nonzero code. */
export const realRunCommand: RunCommand = (argv) =>
  new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? (err as { code?: unknown }).code === 'ENOENT'
                ? 127
                : 1
              : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
```

- [ ] **Step 2: Write the failing test for `tailscale.ts`**

Create `launcher/tailscale.test.ts`. Build a `RunCommand` stub that dispatches on `argv[0..1]`:

```ts
import { describe, it, expect } from 'vitest';
import { ensureUp, nodeIdentity } from './tailscale.js';
import type { RunCommand, CommandResult } from './exec.js';

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (code: number, stderr: string): CommandResult => ({
  code,
  stdout: '',
  stderr,
});

const STATUS_RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: 'laptop-wsl.tailnet-abc.ts.net.',
    TailscaleIPs: ['100.101.102.103', 'fd7a::1'],
  },
});

function stub(map: Record<string, CommandResult>): RunCommand {
  return async (argv) =>
    map[argv.join(' ')] ?? fail(1, `unstubbed: ${argv.join(' ')}`);
}

describe('nodeIdentity', () => {
  it('parses host (trailing dot stripped) and the IPv4 100.x address', async () => {
    const run = stub({ 'tailscale status --json': ok(STATUS_RUNNING) });
    expect(await nodeIdentity(run)).toEqual({
      host: 'laptop-wsl.tailnet-abc.ts.net',
      ip: '100.101.102.103',
    });
  });
  it('returns null when not running/parseable', async () => {
    const run = stub({ 'tailscale status --json': fail(1, 'stopped') });
    expect(await nodeIdentity(run)).toBeNull();
  });
});

describe('ensureUp', () => {
  it('running when status is already Running', async () => {
    const run = stub({ 'tailscale status --json': ok(STATUS_RUNNING) });
    expect(await ensureUp(run)).toEqual({ kind: 'running' });
  });
  it('needs-auth surfaces the login URL', async () => {
    const run: RunCommand = async (argv) => {
      if (argv.join(' ') === 'tailscale status --json')
        return ok(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }));
      if (argv[1] === 'up')
        return fail(
          1,
          'To authenticate, visit:\n\n\thttps://login.tailscale.com/a/deadbeef\n',
        );
      return fail(1, 'x');
    };
    expect(await ensureUp(run)).toEqual({
      kind: 'needs-auth',
      authUrl: 'https://login.tailscale.com/a/deadbeef',
    });
  });
  it('not-installed when the binary is absent (code 127)', async () => {
    const run: RunCommand = async () => ({
      code: 127,
      stdout: '',
      stderr: 'tailscale: not found',
    });
    expect(await ensureUp(run)).toEqual({ kind: 'not-installed' });
  });
  it('needs-operator on a permission error', async () => {
    const run: RunCommand = async (argv) => {
      if (argv.join(' ') === 'tailscale status --json')
        return ok(JSON.stringify({ BackendState: 'Stopped', Self: {} }));
      if (argv[1] === 'up')
        return fail(
          1,
          'Access denied: this operation requires operator access.',
        );
      return fail(1, 'x');
    };
    expect(await ensureUp(run)).toEqual({ kind: 'needs-operator' });
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `cd packages/rc-gateway && npx vitest run src/launcher/tailscale.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement `tailscale.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { RunCommand } from './exec.js';

export interface NodeIdentity {
  host: string; // <name>.<tailnet>.ts.net (trailing dot stripped)
  ip: string; // 100.x IPv4
}

export type UpOutcome =
  | { kind: 'running' }
  | { kind: 'needs-auth'; authUrl: string }
  | { kind: 'not-installed' }
  | { kind: 'needs-operator' }
  | { kind: 'error'; message: string };

interface RawStatus {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
}

async function readStatus(run: RunCommand): Promise<RawStatus | null> {
  const r = await run(['tailscale', 'status', '--json']);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as RawStatus;
  } catch {
    return null;
  }
}

export async function nodeIdentity(
  run: RunCommand,
): Promise<NodeIdentity | null> {
  const st = await readStatus(run);
  const dns = st?.Self?.DNSName;
  const ip = st?.Self?.TailscaleIPs?.find((a) => /^100\.\d/.test(a));
  if (!dns || !ip) return null;
  return { host: dns.replace(/\.$/, ''), ip };
}

/**
 * Ensure the tailnet node is up. Checks status first; only invokes `tailscale up`
 * (bounded, so it cannot hang) when not already Running. Classifies the outcome —
 * on a logged-out node it surfaces the auth URL for the operator's one-time
 * browser authorization (they authenticate, then re-run `qwen-rc up`).
 */
export async function ensureUp(run: RunCommand): Promise<UpOutcome> {
  const st = await readStatus(run);
  if (st?.BackendState === 'Running') return { kind: 'running' };

  const r = await run(['tailscale', 'up', '--timeout', '3s']);
  if (r.code === 0) return { kind: 'running' };

  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code === 127 || /not found|not installed|ENOENT/i.test(out)) {
    return { kind: 'not-installed' };
  }
  const url = /(https:\/\/login\.tailscale\.com\/\S+)/.exec(out)?.[1];
  if (url) return { kind: 'needs-auth', authUrl: url };
  if (/operator|permission denied|access denied/i.test(out)) {
    return { kind: 'needs-operator' };
  }
  return { kind: 'error', message: out.trim().slice(0, 500) };
}
```

Note (implementer): confirm `tailscale up --timeout <dur>` is accepted by the installed Tailscale; if the flag differs, adjust — the seam+tests stay identical (they stub outputs). The first-run auth path (surface URL → operator authenticates → re-run) is the v1 behavior; live "poll until Running then continue" is a documented follow-up.

- [ ] **Step 5: Run tailscale tests to green** — `npx vitest run src/launcher/tailscale.test.ts` → PASS.

- [ ] **Step 6: Write the failing test for `cert.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { ensureCert } from './cert.js';
import type { RunCommand } from './exec.js';

describe('ensureCert', () => {
  it('runs tailscale cert and returns the pair paths', async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: '', stderr: '' };
    };
    const out = await ensureCert(run, 'laptop-wsl.tailnet.ts.net', '/tmp/tls');
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.pair.certPath).toBe('/tmp/tls/laptop-wsl.tailnet.ts.net.crt');
      expect(out.pair.keyPath).toBe('/tmp/tls/laptop-wsl.tailnet.ts.net.key');
    }
    // invoked tailscale cert with explicit output paths
    expect(calls.some((c) => c[0] === 'tailscale' && c[1] === 'cert')).toBe(
      true,
    );
  });
  it('classifies the HTTPS-not-enabled failure', async () => {
    const run: RunCommand = async () => ({
      code: 1,
      stdout: '',
      stderr: 'HTTPS is not enabled in the admin console',
    });
    expect(await ensureCert(run, 'h.ts.net', '/tmp/tls')).toEqual({
      kind: 'https-not-enabled',
    });
  });
});
```

- [ ] **Step 7: Implement `cert.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunCommand } from './exec.js';

export interface CertPair {
  certPath: string;
  keyPath: string;
}

export type CertOutcome =
  | { kind: 'ok'; pair: CertPair }
  | { kind: 'https-not-enabled' }
  | { kind: 'error'; message: string };

/**
 * Obtain a Tailscale TLS cert for `host` into `dir` (`<host>.crt` / `<host>.key`).
 * `tailscale cert` itself is idempotent — it reuses a valid cert and renews when
 * near expiry — so we always invoke it and let it decide.
 */
export async function ensureCert(
  run: RunCommand,
  host: string,
  dir: string,
): Promise<CertOutcome> {
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, `${host}.crt`);
  const keyPath = join(dir, `${host}.key`);
  const r = await run([
    'tailscale',
    'cert',
    '--cert-file',
    certPath,
    '--key-file',
    keyPath,
    host,
  ]);
  if (r.code === 0) return { kind: 'ok', pair: { certPath, keyPath } };
  const out = `${r.stdout}\n${r.stderr}`;
  if (/https .*not enabled|enable https|admin console/i.test(out)) {
    return { kind: 'https-not-enabled' };
  }
  return { kind: 'error', message: out.trim().slice(0, 500) };
}
```

Note (implementer): confirm the installed Tailscale supports `tailscale cert --cert-file <p> --key-file <p> <host>` (it does on current versions). Tests are output-stubbed and unaffected by the exact flag spelling.

- [ ] **Step 8: Run cert tests to green + typecheck** — `npx vitest run src/launcher/tailscale.test.ts src/launcher/cert.test.ts` → PASS; `npx tsc --noEmit -p tsconfig.json` → no NEW errors vs the 11-error baseline (unrelated files).

- [ ] **Step 9: Commit**

```bash
git add packages/rc-gateway/src/launcher/exec.ts packages/rc-gateway/src/launcher/tailscale.ts packages/rc-gateway/src/launcher/cert.ts packages/rc-gateway/src/launcher/tailscale.test.ts packages/rc-gateway/src/launcher/cert.test.ts
git commit -m "feat(rc-gateway): launcher exec seam + tailscale/cert layer"
```

---

### Task 2: state + process + qr + orchestrator

**Files:**

- Create: `packages/rc-gateway/src/launcher/state.ts`, `process.ts`, `qr.ts`, `orchestrator.ts`
- Modify: `packages/rc-gateway/package.json` (add `qrcode` dep)
- Test: `packages/rc-gateway/src/launcher/orchestrator.test.ts`

**Interfaces:**

- Consumes: `RunCommand` (exec.ts); `ensureUp`/`nodeIdentity` (tailscale.ts); `ensureCert` (cert.ts).
- Produces:
  - `state.ts`: `interface LauncherState { unit: string; url: string; host: string; port: number; certExpiry?: string }`; `readState(dir): LauncherState | null`; `writeState(dir, s): void`; `clearState(dir): void`.
  - `process.ts`: `startUnit(run, unit, argv): Promise<CommandResult>`; `stopUnit(run, unit): Promise<CommandResult>`; `isActive(run, unit): Promise<boolean>`.
  - `qr.ts`: `renderQr(text): Promise<string>`.
  - `orchestrator.ts`: `interface UpResult { ok: boolean; url?: string; host?: string; port?: number; unit?: string; bootstrapCode?: string; certExpiry?: string; qr?: string; hint?: string }`; `up(deps): Promise<UpResult>`; `down(deps): Promise<{ ok: boolean }>`; `status(deps): Promise<{ running: boolean; url?: string; certExpiry?: string }>`. `deps = { run: RunCommand; dir: string; port: number; unit: string; serveCmd: string[] }` (`serveCmd` = argv prefix to launch qwen-rc, PATH-independent).

- [ ] **Step 1: Add the `qrcode` dependency**

Add `"qrcode": "^1.5.3"` to `packages/rc-gateway/package.json` `dependencies` (and `"@types/qrcode": "^1.5.5"` to devDependencies), then install:

```bash
cd packages/rc-gateway && npm install qrcode@^1.5.3 && npm install -D @types/qrcode@^1.5.5
```

(If a QR library already exists in the workspace, reuse it instead and skip this step.)

- [ ] **Step 2: Implement `state.ts`, `process.ts`, `qr.ts` (mechanical — test via the orchestrator)**

`state.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface LauncherState {
  unit: string;
  url: string;
  host: string;
  port: number;
  certExpiry?: string;
}

const FILE = 'launcher-state.json';

export function readState(dir: string): LauncherState | null {
  const p = join(dir, FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LauncherState;
  } catch {
    return null;
  }
}

export function writeState(dir: string, s: LauncherState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), JSON.stringify(s, null, 2));
}

export function clearState(dir: string): void {
  rmSync(join(dir, FILE), { force: true });
}
```

`process.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandResult, RunCommand } from './exec.js';

/** Start `argv` as a systemd user transient unit (survives the invoking shell). */
export function startUnit(
  run: RunCommand,
  unit: string,
  argv: string[],
): Promise<CommandResult> {
  return run([
    'systemd-run',
    '--user',
    `--unit=${unit}`,
    '--collect',
    '--',
    ...argv,
  ]);
}

export function stopUnit(
  run: RunCommand,
  unit: string,
): Promise<CommandResult> {
  return run(['systemctl', '--user', 'stop', unit]);
}

export async function isActive(
  run: RunCommand,
  unit: string,
): Promise<boolean> {
  const r = await run(['systemctl', '--user', 'is-active', unit]);
  return r.stdout.trim() === 'active';
}
```

`qr.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import QRCode from 'qrcode';

/** Render `text` as a terminal-drawable QR (`utf8` type — half-block chars). */
export function renderQr(text: string): Promise<string> {
  // `type: 'utf8'` is documented for all qrcode versions; do NOT add
  // `{ small: true }` (not part of the toString options — it would be ignored
  // or throw and, because up swallows a renderQr rejection, silently drop the QR).
  return QRCode.toString(text, { type: 'utf8' });
}
```

- [ ] **Step 3: Write the failing test for the orchestrator flows**

Create `launcher/orchestrator.test.ts`. Drive `up`/`down`/`status` with a stubbed `RunCommand` + a temp dir. Also drop a fake `owner-bootstrap.code` in the dir so `up` can read the pairing code.

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, down, status } from './orchestrator.js';
import type { RunCommand, CommandResult } from './exec.js';

const RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'laptop-wsl.tn.ts.net.', TailscaleIPs: ['100.1.2.3'] },
});
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});
const mkdir = () => (dir = mkdtempSync(join(tmpdir(), 'launcher-')));

const DEPS = (d: string, run: RunCommand) => ({
  run,
  dir: d,
  port: 8443,
  unit: 'qwen-rc-gateway',
  serveCmd: ['qwen-rc'],
});

// tailnet Running + cert ok; the is-active answer is read live from `active()`,
// and `onStart` fires when the gateway unit is launched — so a test can model
// "inactive until started" (exercises the start path + idempotency).
function base(active: () => boolean, onStart?: () => void): RunCommand {
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
    if (k.startsWith('systemctl --user stop')) return ok();
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

describe('renderQr', () => {
  it('returns a non-empty multi-line QR string', async () => {
    const { renderQr } = await import('./qr.js');
    const out = await renderQr('https://example.ts.net:8443/ui/');
    expect(out.length).toBeGreaterThan(0);
    expect(out.split('\n').length).toBeGreaterThan(3);
  });
});

describe('down', () => {
  it('stops and clears state (idempotent)', async () => {
    const d = mkdir();
    const res = await down(
      DEPS(
        d,
        base(() => true),
      ),
    );
    expect(res.ok).toBe(true);
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
```

- [ ] **Step 4: Run to verify it fails** — `npx vitest run src/launcher/orchestrator.test.ts` → FAIL (module missing).

- [ ] **Step 5: Implement `orchestrator.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { existsSync, readFileSync } from 'node:fs';
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

export interface Deps {
  run: RunCommand;
  dir: string; // ~/.qwen/rc
  port: number;
  unit: string; // e.g. qwen-rc-gateway
  serveCmd: string[]; // PATH-independent argv prefix for qwen-rc, e.g. [process.argv[0], process.argv[1]]
}

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
  const p = join(dir, 'owner-bootstrap.code');
  if (!existsSync(p)) return undefined;
  const c = readFileSync(p, 'utf8').trim();
  return c.length > 0 ? c : undefined;
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

  const state: LauncherState = { unit, url, host: id.host, port };
  writeState(dir, state);

  // 4. Connect info.
  const bootstrapCode = readBootstrapCode(dir);
  const qr = await renderQr(url).catch(() => undefined);
  return { ok: true, url, host: id.host, port, unit, bootstrapCode, qr };
}

export async function down(deps: Deps): Promise<{ ok: boolean }> {
  const { run, dir, unit } = deps;
  const st = readState(dir);
  await stopUnit(run, st?.unit ?? unit); // idempotent; a stopped unit is fine
  clearState(dir);
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
```

- [ ] **Step 6: Run the orchestrator tests to green + typecheck** — `npx vitest run src/launcher/orchestrator.test.ts` → PASS; `npx tsc --noEmit -p tsconfig.json` → no NEW errors (the `qrcode` import must resolve — confirm `@types/qrcode` installed).

- [ ] **Step 7: Commit**

```bash
git add packages/rc-gateway/src/launcher/state.ts packages/rc-gateway/src/launcher/process.ts packages/rc-gateway/src/launcher/qr.ts packages/rc-gateway/src/launcher/orchestrator.ts packages/rc-gateway/src/launcher/orchestrator.test.ts packages/rc-gateway/package.json packages/rc-gateway/package-lock.json
git commit -m "feat(rc-gateway): launcher state/process/qr + up/down/status orchestrator"
```

---

### Task 3: CLI subcommands (`up`/`down`/`status`) + end-to-end

**Files:**

- Modify: `packages/rc-gateway/src/cli.ts` (three new subcommand branches)
- Test: `packages/rc-gateway/src/launcher/cli.e2e.test.ts`

**Interfaces:**

- Consumes: `up`/`down`/`status` + `Deps` (orchestrator.ts); `realRunCommand` (exec.ts). `homedir`/`join` already imported in `cli.ts`.

- [ ] **Step 1: Add the three subcommand branches in `cli.ts`**

After the existing top-level branches (e.g. near the `daemons discover` branch, following the same `process.argv[2] === '…'` + `void (async () => { … })()` style), add:

```ts
} else if (process.argv[2] === 'up' || process.argv[2] === 'down' || process.argv[2] === 'status') {
  void (async () => {
    const { up, down, status } = await import('./launcher/orchestrator.js');
    const { realRunCommand } = await import('./launcher/exec.js');
    const wantJson = process.argv.includes('--json');
    const portFlag = (() => {
      const i = process.argv.indexOf('--port');
      return i >= 0 ? Number(process.argv[i + 1]) : undefined;
    })();
    const deps = {
      run: realRunCommand,
      dir: join(homedir(), '.qwen', 'rc'),
      port: portFlag ?? 8443,
      unit: 'qwen-rc-gateway',
      // PATH-independent self-invocation: [node, this cli.js] so the systemd
      // --user unit can exec qwen-rc even when it isn't on PATH.
      serveCmd: [process.argv[0], process.argv[1]],
    };
    const cmd = process.argv[2];
    if (cmd === 'up') {
      const r = await up(deps);
      if (wantJson) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ status: r.ok ? 'running' : 'error', url: r.url, host: r.host, port: r.port, unit: r.unit, bootstrapCode: r.bootstrapCode, certExpiry: r.certExpiry, hint: r.hint }));
      } else if (r.ok) {
        // eslint-disable-next-line no-console
        console.log(`\nConnect from your phone:\n  ${r.url}\n\nPairing code: ${r.bootstrapCode ?? '(see gateway logs)'}\n\n${r.qr ?? ''}`);
      } else {
        // eslint-disable-next-line no-console
        console.error(`qwen-rc up: ${r.hint}`);
      }
      process.exit(r.ok ? 0 : 1);
    } else if (cmd === 'down') {
      const r = await down(deps);
      if (wantJson) console.log(JSON.stringify({ status: 'stopped' }));
      else console.log('qwen-rc: stopped'); // eslint-disable-line no-console
      process.exit(r.ok ? 0 : 1);
    } else {
      const r = await status(deps);
      if (wantJson) console.log(JSON.stringify(r));
      else console.log(r.running ? `running\n  ${r.url ?? ''}` : 'stopped'); // eslint-disable-line no-console
      process.exit(0);
    }
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`qwen-rc ${process.argv[2]} failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
```

(Match the existing file's exact `} else if …` chaining and lint-comment conventions; place it alongside the other subcommand branches.)

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit -p tsconfig.json` → no NEW errors.

- [ ] **Step 3: Write the end-to-end test (orchestrator wired to a fully stubbed run, driving up→status→down)**

Create `launcher/cli.e2e.test.ts` — exercise the orchestrator triplet the CLI dispatches, proving the up→status→down lifecycle over one stubbed `RunCommand` + temp dir (the CLI branch itself is thin argv glue; the e2e covers the wired flow):

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, status, down } from './orchestrator.js';
import type { RunCommand } from './exec.js';

const RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'l.tn.ts.net.', TailscaleIPs: ['100.9.9.9'] },
});

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

it('up -> status(running) -> down -> status(stopped)', async () => {
  dir = mkdtempSync(join(tmpdir(), 'launcher-e2e-'));
  writeFileSync(join(dir, 'owner-bootstrap.code'), 'PAIR-9\n');
  let active = false;
  const run: RunCommand = async (argv) => {
    const k = argv.join(' ');
    if (k === 'tailscale status --json')
      return { code: 0, stdout: RUNNING, stderr: '' };
    if (argv[0] === 'tailscale' && argv[1] === 'cert')
      return { code: 0, stdout: '', stderr: '' };
    if (argv[0] === 'systemd-run') {
      active = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (k.startsWith('systemctl --user is-active'))
      return {
        code: active ? 0 : 3,
        stdout: active ? 'active\n' : 'inactive\n',
        stderr: '',
      };
    if (k.startsWith('systemctl --user stop')) {
      active = false;
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: k };
  };
  const deps = {
    run,
    dir,
    port: 8443,
    unit: 'qwen-rc-gateway',
    serveCmd: ['qwen-rc'],
  };

  const u = await up(deps);
  expect(u.ok).toBe(true);
  expect(u.url).toBe('https://l.tn.ts.net:8443/ui/');
  expect(u.bootstrapCode).toBe('PAIR-9');

  expect((await status(deps)).running).toBe(true);
  await down(deps);
  expect((await status(deps)).running).toBe(false);
});
```

- [ ] **Step 4: Run the e2e + full suite + typecheck**

Run: `cd packages/rc-gateway && npx vitest run src/launcher/ && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: launcher tests green; full suite green (no regressions); tsc no NEW errors.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/cli.ts packages/rc-gateway/src/launcher/cli.e2e.test.ts
git commit -m "feat(rc-gateway): qwen-rc up/down/status subcommands + e2e"
```
