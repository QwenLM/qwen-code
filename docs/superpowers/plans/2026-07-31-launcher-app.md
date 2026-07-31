# Launcher control panel (Electron) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows Electron control panel (`packages/launcher-app`) that drives the Spec-1 `qwen-rc up`/`down`/`status` launcher over `wsl.exe` — Start/Stop, status, connect URL + QR + pairing code, logs, and a Lovelace-endpoint config tab.

**Architecture:** A thin Electron shell over a Node-testable core. Every main-process module talks to WSL through an injected `RunWsl` seam (like Spec 1's `RunCommand`), so the core is unit-tested with Vitest. The Electron shell, renderer UI, real `wsl.exe`, and packaging are Windows-only and operator-verified (not automated here).

**Tech Stack:** TypeScript, Node (`child_process`), Electron, esbuild, `qrcode`, Vitest.

## Global Constraints

- **New fork-local package `packages/launcher-app`** (`"type": "module"`). No changes to any other package; no core/daemon changes. Not an OpenSpec change.
- **All WSL interaction goes through `RunWsl`** — `type RunWsl = (command: string) => Promise<{ code: number; stdout: string; stderr: string }>` — run as `wsl.exe -d <distro> -- bash -lc "<command>"` (login shell so `qwen-rc` is on PATH). Modules take `run: RunWsl` as a parameter; only the real impl touches `child_process`.
- **The launcher `--json` omits the pairing code** (Spec 1's secret-hygiene decision). The app reads it separately from the 0600 `~/.qwen/rc/owner-bootstrap.code`. The app MUST NOT log or persist the pairing code or the `OPENAI_API_KEY` anywhere except the `.env` file it manages.
- **Testable here vs operator-verified:** Tasks 1–2 (the Node core) are TDD with a stubbed `RunWsl`. Tasks 3–4 (Electron shell + renderer) are operator-verified scaffold — only the small pure pieces (the status-poll reducer) get unit tests; the Electron/renderer wiring is validated by running it on Windows (a checklist, not a test).
- **Launcher `--json` shapes** (from Spec 1, consumed verbatim): `up` → `{ status: 'running'|'error', url?, host?, port?, unit?, certExpiry?, hint? }`; `status` → `{ running: boolean, url?, certExpiry? }`; `down` → `{ status: 'stopped' }`.

---

### Task 1: Package scaffold + `wsl.ts` seam + `launcherClient.ts`

**Files:**

- Create: `packages/launcher-app/package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/launcher-app/src/main/wsl.ts`, `src/main/launcherClient.ts`
- Test: `packages/launcher-app/src/main/wsl.test.ts`, `src/main/launcherClient.test.ts`

**Interfaces:**

- Produces:
  - `wsl.ts`: `interface CommandResult { code: number; stdout: string; stderr: string }`; `type RunWsl = (command: string) => Promise<CommandResult>`; `realRunWsl(distro?: string): RunWsl`; `parseDistroList(raw: string): string[]`; `listDistros(): Promise<string[]>`.
  - `launcherClient.ts`: `interface UpResult { ok: boolean; url?: string; host?: string; port?: number; unit?: string; certExpiry?: string; hint?: string }`; `interface StatusResult { running: boolean; url?: string; certExpiry?: string }`; `up(run): Promise<UpResult>`; `down(run): Promise<{ ok: boolean; hint?: string }>`; `status(run): Promise<StatusResult>`; `readPairingCode(run): Promise<string | undefined>`.

- [ ] **Step 1: Create the package files**

`packages/launcher-app/package.json`:

```json
{
  "name": "@qwen-code/launcher-app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Windows control panel for the qwen-rc remote-control launcher",
  "main": "dist/main/main.cjs",
  "scripts": {
    "build": "node esbuild.js",
    "start": "npm run build && electron .",
    "test": "vitest run",
    "test:ci": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "qrcode": "^1.5.3"
  },
  "devDependencies": {
    "electron": "^32.0.0",
    "electron-builder": "^24.13.3",
    "esbuild": "^0.23.0",
    "@types/qrcode": "^1.5.5"
  }
}
```

`packages/launcher-app/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`packages/launcher-app/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

`packages/launcher-app/.gitignore`:

```
dist/
node_modules/
```

- [ ] **Step 2: Write the failing test for `wsl.ts`'s `parseDistroList`**

`src/main/wsl.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseDistroList } from './wsl.js';

describe('parseDistroList', () => {
  it('returns distro names, stripping CR / blanks / the default marker', () => {
    // wsl.exe -l -q output, already decoded from UTF-16 to a string
    const raw = 'Ubuntu\r\nUbuntu-22.04\r\ndocker-desktop\r\n\r\n';
    expect(parseDistroList(raw)).toEqual([
      'Ubuntu',
      'Ubuntu-22.04',
      'docker-desktop',
    ]);
  });
  it('handles an empty listing', () => {
    expect(parseDistroList('\r\n')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `cd packages/launcher-app && npx vitest run src/main/wsl.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement `wsl.ts`**

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

/** Run a shell command inside the WSL distro (login shell → qwen-rc on PATH). */
export type RunWsl = (command: string) => Promise<CommandResult>;

/**
 * Real impl. Runs `wsl.exe [-d <distro>] -- bash -lc "<command>"`. `command`
 * is passed as a single argv element (execFile does not use a shell), so its
 * spaces/quotes are safe. Never rejects — a failure resolves with a nonzero code.
 */
export function realRunWsl(distro?: string): RunWsl {
  const distroArgs = distro ? ['-d', distro] : [];
  return (command) =>
    new Promise((resolve) => {
      execFile(
        'wsl.exe',
        [...distroArgs, '--', 'bash', '-lc', command],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : err
                ? 1
                : 0;
          resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
    });
}

/** Parse decoded `wsl.exe -l -q` output into a list of distro names. */
export function parseDistroList(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) =>
      l
        .replace(/\r/g, '')
        .replace(/\s*\(Default\)\s*$/i, '')
        .trim(),
    )
    .filter((l) => l.length > 0);
}

/**
 * Enumerate installed WSL distros. `wsl.exe -l -q` emits UTF-16LE, so read the
 * raw buffer and decode before parsing. (Operator-verified on Windows.)
 */
export function listDistros(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-l', '-q'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 },
      (_err, stdout) => {
        const buf = (stdout as unknown as Buffer) ?? Buffer.alloc(0);
        // UTF-16LE from wsl.exe; fall back to utf8 if it looks like utf8.
        const text = buf.includes(0)
          ? buf.toString('utf16le')
          : buf.toString('utf8');
        resolve(parseDistroList(text));
      },
    );
  });
}
```

- [ ] **Step 5: Run `wsl.ts` tests to green** — `npx vitest run src/main/wsl.test.ts` → PASS.

- [ ] **Step 6: Write the failing test for `launcherClient.ts`**

`src/main/launcherClient.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { up, down, status, readPairingCode } from './launcherClient.js';
import type { RunWsl, CommandResult } from './wsl.js';

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const stub =
  (map: Record<string, CommandResult>): RunWsl =>
  async (cmd) =>
    map[cmd] ?? { code: 1, stdout: '', stderr: `unstubbed: ${cmd}` };

describe('up', () => {
  it('maps a running result', async () => {
    const run = stub({
      'qwen-rc up --json': ok(
        JSON.stringify({
          status: 'running',
          url: 'https://h.ts.net:8443/ui/',
          host: 'h.ts.net',
          port: 8443,
          unit: 'qwen-rc-gateway',
          certExpiry: '2036-01-01T00:00:00.000Z',
        }),
      ),
    });
    expect(await up(run)).toEqual({
      ok: true,
      url: 'https://h.ts.net:8443/ui/',
      host: 'h.ts.net',
      port: 8443,
      unit: 'qwen-rc-gateway',
      certExpiry: '2036-01-01T00:00:00.000Z',
    });
  });
  it('maps an error result with the hint', async () => {
    const run = stub({
      'qwen-rc up --json': ok(
        JSON.stringify({ status: 'error', hint: 'enable HTTPS/MagicDNS' }),
      ),
    });
    expect(await up(run)).toEqual({ ok: false, hint: 'enable HTTPS/MagicDNS' });
  });
  it('surfaces a hint when the command itself fails / output is unparseable', async () => {
    const run: RunWsl = async () => ({
      code: 1,
      stdout: 'bash: qwen-rc: command not found',
      stderr: '',
    });
    const r = await up(run);
    expect(r.ok).toBe(false);
    expect(r.hint).toContain('qwen-rc');
  });
});

describe('status', () => {
  it('maps running + url', async () => {
    const run = stub({
      'qwen-rc status --json': ok(
        JSON.stringify({ running: true, url: 'https://h.ts.net:8443/ui/' }),
      ),
    });
    expect(await status(run)).toEqual({
      running: true,
      url: 'https://h.ts.net:8443/ui/',
    });
  });
  it('reports stopped on an unparseable/failed status', async () => {
    const run: RunWsl = async () => ({ code: 1, stdout: '', stderr: 'x' });
    expect(await status(run)).toEqual({ running: false });
  });
});

describe('down', () => {
  it('ok on stopped', async () => {
    const run = stub({
      'qwen-rc down --json': ok(JSON.stringify({ status: 'stopped' })),
    });
    expect(await down(run)).toEqual({ ok: true });
  });
});

describe('readPairingCode', () => {
  it('returns the trimmed code', async () => {
    const run = stub({
      'cat ~/.qwen/rc/owner-bootstrap.code 2>/dev/null': ok('ABCD-1234\n'),
    });
    expect(await readPairingCode(run)).toBe('ABCD-1234');
  });
  it('returns undefined when absent', async () => {
    const run: RunWsl = async () => ({ code: 1, stdout: '', stderr: '' });
    expect(await readPairingCode(run)).toBeUndefined();
  });
});
```

- [ ] **Step 7: Implement `launcherClient.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { RunWsl } from './wsl.js';

export interface UpResult {
  ok: boolean;
  url?: string;
  host?: string;
  port?: number;
  unit?: string;
  certExpiry?: string;
  hint?: string;
}
export interface StatusResult {
  running: boolean;
  url?: string;
  certExpiry?: string;
}

function parseJson(stdout: string): Record<string, unknown> | null {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function up(run: RunWsl): Promise<UpResult> {
  const r = await run('qwen-rc up --json');
  const j = parseJson(r.stdout);
  if (!j) {
    return {
      ok: false,
      hint: (r.stdout || r.stderr).trim().slice(0, 500) || 'launcher up failed',
    };
  }
  const ok = j['status'] === 'running';
  return {
    ok,
    url: typeof j['url'] === 'string' ? j['url'] : undefined,
    host: typeof j['host'] === 'string' ? j['host'] : undefined,
    port: typeof j['port'] === 'number' ? j['port'] : undefined,
    unit: typeof j['unit'] === 'string' ? j['unit'] : undefined,
    certExpiry:
      typeof j['certExpiry'] === 'string' ? j['certExpiry'] : undefined,
    hint: typeof j['hint'] === 'string' ? j['hint'] : undefined,
  };
}

export async function down(
  run: RunWsl,
): Promise<{ ok: boolean; hint?: string }> {
  const r = await run('qwen-rc down --json');
  const j = parseJson(r.stdout);
  if (j && j['status'] === 'stopped') return { ok: true };
  return {
    ok: r.code === 0,
    hint: j ? undefined : (r.stderr || r.stdout).trim().slice(0, 300),
  };
}

export async function status(run: RunWsl): Promise<StatusResult> {
  const r = await run('qwen-rc status --json');
  const j = parseJson(r.stdout);
  if (!j) return { running: false };
  return {
    running: j['running'] === true,
    url: typeof j['url'] === 'string' ? j['url'] : undefined,
    certExpiry:
      typeof j['certExpiry'] === 'string' ? j['certExpiry'] : undefined,
  };
}

export async function readPairingCode(
  run: RunWsl,
): Promise<string | undefined> {
  const r = await run('cat ~/.qwen/rc/owner-bootstrap.code 2>/dev/null');
  const code = r.stdout.trim();
  return r.code === 0 && code.length > 0 ? code : undefined;
}
```

- [ ] **Step 8: Run all Task-1 tests + typecheck**

Run: `cd packages/launcher-app && npm install && npx vitest run && npx tsc --noEmit`
Expected: all green; tsc clean. (`npm install` pulls electron/esbuild/qrcode — first install for the new package.)

- [ ] **Step 9: Commit**

```bash
git add packages/launcher-app/package.json packages/launcher-app/tsconfig.json packages/launcher-app/vitest.config.ts packages/launcher-app/.gitignore packages/launcher-app/src/main/wsl.ts packages/launcher-app/src/main/launcherClient.ts packages/launcher-app/src/main/wsl.test.ts packages/launcher-app/src/main/launcherClient.test.ts package-lock.json
git commit -m "feat(launcher-app): package scaffold + RunWsl seam + launcher client"
```

---

### Task 2: `envConfig.ts` (Lovelace `.env`) + `logs.ts`

**Files:**

- Create: `packages/launcher-app/src/main/envConfig.ts`, `src/main/logs.ts`
- Test: `packages/launcher-app/src/main/envConfig.test.ts`, `src/main/logs.test.ts`

**Interfaces:**

- Consumes: `RunWsl` (Task 1).
- Produces:
  - `envConfig.ts`: `interface ProviderEnv { OPENAI_BASE_URL?: string; OPENAI_API_KEY?: string; OPENAI_MODEL?: string }`; `parseEnv(raw: string): Record<string, string>`; `mergeEnv(existing: string, updates: ProviderEnv): string`; `readEnv(run): Promise<ProviderEnv>`; `writeEnv(run, updates): Promise<{ ok: boolean }>`.
  - `logs.ts`: `class LineFramer { push(chunk: string): string[] }` (buffers partial lines, emits complete ones); `streamLogs(run, onLine, opts?): { stop(): void }` (thin wrapper over a streamed `journalctl` — the framing is the tested part).

- [ ] **Step 1: Write the failing tests for `envConfig.ts`**

`src/main/envConfig.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseEnv, mergeEnv } from './envConfig.js';

describe('parseEnv', () => {
  it('parses KEY=VALUE lines, ignoring comments/blanks', () => {
    expect(
      parseEnv('# c\nOPENAI_BASE_URL=http://x/v1\n\nOPENAI_MODEL=m\n'),
    ).toEqual({
      OPENAI_BASE_URL: 'http://x/v1',
      OPENAI_MODEL: 'm',
    });
  });
});

describe('mergeEnv', () => {
  it('updates the provider keys and PRESERVES unrelated lines', () => {
    const existing = 'FOO=bar\nOPENAI_BASE_URL=old\n# note\n';
    const out = mergeEnv(existing, {
      OPENAI_BASE_URL: 'http://lovelace:1234/v1',
      OPENAI_API_KEY: 'sk-1',
      OPENAI_MODEL: 'qwen',
    });
    expect(out).toContain('FOO=bar');
    expect(out).toContain('# note');
    expect(out).toContain('OPENAI_BASE_URL=http://lovelace:1234/v1');
    expect(out).toContain('OPENAI_API_KEY=sk-1');
    expect(out).toContain('OPENAI_MODEL=qwen');
    // no duplicate OPENAI_BASE_URL line
    expect(out.match(/^OPENAI_BASE_URL=/gm)?.length).toBe(1);
    expect(out).not.toContain('OPENAI_BASE_URL=old');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/envConfig.test.ts` → FAIL.

- [ ] **Step 3: Implement `envConfig.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { RunWsl } from './wsl.js';

export interface ProviderEnv {
  OPENAI_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}

const KEYS = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'] as const;

export function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** Update the provider keys in `existing`, preserving all other lines. */
export function mergeEnv(existing: string, updates: ProviderEnv): string {
  const lines = existing.split('\n');
  const seen = new Set<string>();
  const result = lines.map((line) => {
    const eq = line.indexOf('=');
    if (eq <= 0) return line;
    const key = line.slice(0, eq).trim();
    if (
      (KEYS as readonly string[]).includes(key) &&
      updates[key as keyof ProviderEnv] !== undefined
    ) {
      seen.add(key);
      return `${key}=${updates[key as keyof ProviderEnv]}`;
    }
    return line;
  });
  // Append any provided keys not already present.
  for (const key of KEYS) {
    if (updates[key] !== undefined && !seen.has(key)) {
      result.push(`${key}=${updates[key]}`);
    }
  }
  return result.join('\n');
}

export async function readEnv(run: RunWsl): Promise<ProviderEnv> {
  const r = await run('cat ~/.qwen/.env 2>/dev/null');
  const parsed = r.code === 0 ? parseEnv(r.stdout) : {};
  const out: ProviderEnv = {};
  for (const k of KEYS) if (parsed[k] !== undefined) out[k] = parsed[k];
  return out;
}

/**
 * Write the merged `.env` back with mode 0600. The new content is base64'd and
 * decoded in WSL so arbitrary values (keys, URLs) never hit shell quoting.
 */
export async function writeEnv(
  run: RunWsl,
  updates: ProviderEnv,
): Promise<{ ok: boolean }> {
  const existing = await run('cat ~/.qwen/.env 2>/dev/null');
  const merged = mergeEnv(existing.code === 0 ? existing.stdout : '', updates);
  const b64 = Buffer.from(merged, 'utf8').toString('base64');
  const r = await run(
    `mkdir -p ~/.qwen && echo ${b64} | base64 -d > ~/.qwen/.env && chmod 600 ~/.qwen/.env`,
  );
  return { ok: r.code === 0 };
}
```

- [ ] **Step 4: Run `envConfig` tests to green** — `npx vitest run src/main/envConfig.test.ts` → PASS.

- [ ] **Step 5: Write the failing test for `logs.ts`'s `LineFramer`**

`src/main/logs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { LineFramer } from './logs.js';

describe('LineFramer', () => {
  it('emits only complete lines and buffers the partial tail', () => {
    const f = new LineFramer();
    expect(f.push('hello\nwor')).toEqual(['hello']);
    expect(f.push('ld\nfoo\n')).toEqual(['world', 'foo']);
    expect(f.push('')).toEqual([]);
    expect(f.push('bar')).toEqual([]); // no newline yet
    expect(f.push('\n')).toEqual(['bar']);
  });
});
```

- [ ] **Step 6: Implement `logs.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { spawn } from 'node:child_process';

/** Buffers streamed chunks and emits complete lines; the partial tail is kept. */
export class LineFramer {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts;
  }
}

export interface LogStream {
  stop(): void;
}

/**
 * Tail the gateway unit's journal, framing lines to `onLine`. The framing is
 * unit-tested (LineFramer); this spawn wrapper is operator-verified on Windows.
 */
export function streamLogs(
  distro: string | undefined,
  onLine: (line: string) => void,
  unit = 'qwen-rc-gateway',
): LogStream {
  const framer = new LineFramer();
  const args = [
    ...(distro ? ['-d', distro] : []),
    '--',
    'bash',
    '-lc',
    `journalctl --user -u ${unit} -f -n 100 --no-pager`,
  ];
  const child = spawn('wsl.exe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (b: Buffer) => framer.push(b.toString('utf8')).forEach(onLine);
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return { stop: () => child.kill() };
}
```

- [ ] **Step 7: Run all Task-2 tests + typecheck**

Run: `cd packages/launcher-app && npx vitest run && npx tsc --noEmit`
Expected: all green; tsc clean.

- [ ] **Step 8: Commit**

```bash
git add packages/launcher-app/src/main/envConfig.ts packages/launcher-app/src/main/logs.ts packages/launcher-app/src/main/envConfig.test.ts packages/launcher-app/src/main/logs.test.ts
git commit -m "feat(launcher-app): Lovelace .env config (merge-preserving) + log line framing"
```

---

### Task 3: Electron shell — status-poll reducer + main/preload/ipc

**Files:**

- Create: `packages/launcher-app/src/main/statusPoll.ts`, `src/main/appConfig.ts`, `src/main/ipc.ts`, `src/main/main.ts`, `src/preload/preload.ts`
- Test: `packages/launcher-app/src/main/statusPoll.test.ts`

**Interfaces:**

- Consumes: `up`/`down`/`status`/`readPairingCode` (Task 1); `readEnv`/`writeEnv` (Task 2); `streamLogs` (Task 2); `realRunWsl`/`listDistros` (Task 1).
- Produces: the preload `window.launcher` API (used by the renderer, Task 4): `{ up(), down(), status(), pairingCode(), listDistros(), getConfig(), saveConfig(env), setDistro(d), onLog(cb), startLogs(), stopLogs() }`.

**Note:** Only `statusPoll.ts` is unit-testable here (a pure reducer). `appConfig.ts`, `ipc.ts`, `main.ts`, `preload.ts` are Electron wiring — **operator-verified on Windows** (Step 6 checklist), not automated.

- [ ] **Step 1: Write the failing test for the status-poll reducer**

`src/main/statusPoll.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nextPollState, type PollState } from './statusPoll.js';

const S = (over: Partial<PollState> = {}): PollState => ({
  running: false,
  url: undefined,
  lastError: undefined,
  ...over,
});

describe('nextPollState', () => {
  it('transitions to running with the url on a running status', () => {
    expect(nextPollState(S(), { running: true, url: 'https://h/ui/' })).toEqual(
      { running: true, url: 'https://h/ui/', lastError: undefined },
    );
  });
  it('clears url when stopped', () => {
    expect(
      nextPollState(S({ running: true, url: 'https://h/ui/' }), {
        running: false,
      }),
    ).toEqual({ running: false, url: undefined, lastError: undefined });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/statusPoll.test.ts` → FAIL.

- [ ] **Step 3: Implement `statusPoll.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { StatusResult } from './launcherClient.js';

export interface PollState {
  running: boolean;
  url?: string;
  lastError?: string;
}

/** Pure reducer: fold a status probe into the poll state (unit-tested). */
export function nextPollState(_prev: PollState, s: StatusResult): PollState {
  return {
    running: s.running,
    url: s.running ? s.url : undefined,
    lastError: undefined,
  };
}
```

- [ ] **Step 4: Run to green** — `npx vitest run src/main/statusPoll.test.ts` → PASS.

- [ ] **Step 5: Implement the Electron wiring (operator-verified — no automated test)**

`src/main/appConfig.ts` — persist the chosen distro (+ window bounds) in Electron `userData` (`app.getPath('userData')/launcher-app.json`); NEVER secrets. Read on start, write on change.

`src/main/ipc.ts` — register `ipcMain.handle(...)` for each API method, delegating to the Task-1/2 modules with a `RunWsl` built from `realRunWsl(currentDistro)`; forward `streamLogs` lines to the focused window via `webContents.send('log', line)`; run a `setInterval` status poll (fold with `nextPollState`) and `send('status', state)`; clear the interval + stop logs on `window.on('closed')`.

`src/preload/preload.ts` — `contextBridge.exposeInMainWorld('launcher', { up: () => ipcRenderer.invoke('up'), down: …, status: …, pairingCode: …, listDistros: …, getConfig: …, saveConfig: (env) => ipcRenderer.invoke('saveConfig', env), setDistro: (d) => ipcRenderer.invoke('setDistro', d), onLog: (cb) => ipcRenderer.on('log', (_e, l) => cb(l)), onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)), startLogs: …, stopLogs: … })`. `contextIsolation: true`, `nodeIntegration: false`.

`src/main/main.ts` — `app.whenReady()` → create a `BrowserWindow` (`webPreferences: { preload: <preload.cjs>, contextIsolation: true, nodeIntegration: false }`), load `dist/renderer/index.html`, `registerIpc()`; standard `window-all-closed`/`activate` lifecycle.

- [ ] **Step 6: Typecheck + record the operator-verify checklist**

Run: `cd packages/launcher-app && npx tsc --noEmit` → clean.
Add an `OPERATOR-VERIFY.md` in the package listing the Windows checks (Task 3 slice): app launches, window opens, `listDistros` populates the distro picker, a status poll updates the dot. (These cannot be automated in the Linux CI — the review verifies structure + the poll-reducer test.)

- [ ] **Step 7: Commit**

```bash
git add packages/launcher-app/src/main/statusPoll.ts packages/launcher-app/src/main/statusPoll.test.ts packages/launcher-app/src/main/appConfig.ts packages/launcher-app/src/main/ipc.ts packages/launcher-app/src/main/main.ts packages/launcher-app/src/preload/preload.ts packages/launcher-app/OPERATOR-VERIFY.md
git commit -m "feat(launcher-app): Electron shell (main/preload/ipc) + status-poll reducer"
```

---

### Task 4: Renderer (3 tabs + QR) + esbuild build + Windows target

**Files:**

- Create: `packages/launcher-app/src/renderer/index.html`, `renderer.ts`, `styles.css`
- Create: `packages/launcher-app/esbuild.js`, `electron-builder.yml`

**Note:** the renderer + build are **operator-verified on Windows** — no automated tests. The review verifies the build succeeds (`node esbuild.js` produces `dist/`), the structure, and the secret-hygiene rule (the renderer never persists the pairing code / API key).

- [ ] **Step 1: Implement `esbuild.js`** — bundle three entry points (mirroring `packages/vscode-ide-companion/esbuild.js`): `src/main/main.ts` → `dist/main/main.cjs` (`platform: 'node'`, `format: 'cjs'`, `external: ['electron']`), `src/preload/preload.ts` → `dist/preload/preload.cjs` (same), `src/renderer/renderer.ts` → `dist/renderer/renderer.js` (`platform: 'browser'`, bundling `qrcode`); copy `src/renderer/index.html` + `styles.css` into `dist/renderer/`. Support `--production`/`--watch` flags like the companion's build.

- [ ] **Step 2: Implement the renderer** — `index.html` (three tab buttons + panels: Control, Logs, Config; loads `renderer.js`), `styles.css` (minimal), `renderer.ts`:
  - **Control:** a Start/Stop button → `window.launcher.up()/down()`; subscribe `onStatus` to update a status dot + the connect URL; on running, fetch `pairingCode()` and render it, and render a QR image of the URL with `QRCode.toDataURL(url)` into an `<img>`. On `up().hint` (error), show the hint in a banner.
  - **Logs:** `startLogs()` on tab open; `onLog(line => append)`; a scrolling `<pre>`; `stopLogs()` on leave.
  - **Config:** load `getConfig()` into the form (base URL / api key / model); Save → `saveConfig(env)` then confirm-restart (`down()`→`up()`); never store the values in the renderer beyond the form/DOM.

- [ ] **Step 3: Implement `electron-builder.yml`** — a portable/dir Windows target (`win: { target: [dir] }`), `files: [dist/**]`, `appId`, `productName`. Deferred: nsis installer, signing, publish/auto-update.

- [ ] **Step 4: Verify the build succeeds + typecheck**

Run: `cd packages/launcher-app && npm run build && npx tsc --noEmit`
Expected: `dist/main/main.cjs`, `dist/preload/preload.cjs`, `dist/renderer/{renderer.js,index.html,styles.css}` produced; tsc clean. (Running the app + scanning the QR from a phone is the operator's Windows first-run check — append those steps to `OPERATOR-VERIFY.md`.)

- [ ] **Step 5: Commit**

```bash
git add packages/launcher-app/src/renderer packages/launcher-app/esbuild.js packages/launcher-app/electron-builder.yml packages/launcher-app/OPERATOR-VERIFY.md
git commit -m "feat(launcher-app): 3-tab renderer + QR + esbuild build + Windows target"
```
