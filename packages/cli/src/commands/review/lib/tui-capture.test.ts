/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  captureServerName,
  freezePlan,
  isNothingToKill,
  isSocketDirNeverCreated,
  isSocketDirUnusable,
  verdictExaminedBase,
  tmuxPlan,
  tmuxSupportsCaptureN,
  tmuxSupportsCaptureT,
  tmuxPadsWithCaptureN,
  validGeometry,
} from './tui-capture.js';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('kill-server stderr classification', () => {
  // The two predicates answer DIFFERENT questions, and conflating them
  // unlinks live servers: "nothing to kill" authorizes removing the socket,
  // so it may only contain wordings that establish there is no server.
  const nothingToKill = [
    'no server running on /tmp/tmux-501/qwen-review-capture-1-a',
    // All FOUR alternates of the create-directory branch: only two were
    // pinned, so narrowing the regex to those two shipped green while the
    // other wordings printed a false orphan WARNING.
    "can't create directory /tmp/tmux-501: Permission denied",
    "couldn't create directory /tmp/tmux-501 (Permission denied)",
    'cannot create directory /tmp/tmux-501: Permission denied',
    'could not create directory /tmp/tmux-501 (Permission denied)',
    'error connecting to /very/long/... (File name too long)',
  ];
  for (const line of nothingToKill) {
    it(`treats as nothing to kill: ${line.slice(0, 40)}`, () => {
      expect(isNothingToKill(line)).toBe(true);
      expect(isSocketDirUnusable(line)).toBe(false);
    });
  }

  // The ENOENT class proves only that the socket path was absent when the
  // client looked — a LIVE server behind a removed socket file answers
  // exactly these (probed live on tmux), so the class left isNothingToKill
  // for its own predicate the way isSocketDirUnusable did for the same
  // folded-in reason. Both wordings: the `error connecting` shape always
  // carries the bare one, and the bare capital-N fixture pins the /i flag
  // independently of that shape (strerror renders it capital N).
  const pathAbsent = [
    'error connecting to /tmp/x (No such file or directory)',
    'No such file or directory',
  ];
  for (const line of pathAbsent) {
    it(`never establishes death on its own: ${line.slice(0, 40)}`, () => {
      expect(isNothingToKill(line)).toBe(false);
      expect(isSocketDirUnusable(line)).toBe(false);
    });
  }

  // Client-side refusals: tmux never looked at the server. An earlier
  // revision of this PR folded these into isNothingToKill on the strength
  // of "they also appear when no server was ever created" — which is true
  // and beside the point: a LIVE server behind such a socket then read as
  // reaped, the WARNING was skipped, and the socket was unlinked under
  // both bases, making that server unreachable forever.
  const dirUnusable = [
    'directory /tmp/tmux-501 has unsafe permissions',
    '/tmp/tmux-501 is not a directory',
  ];
  for (const line of dirUnusable) {
    it(`never authorizes an unlink: ${line.slice(0, 40)}`, () => {
      expect(isSocketDirUnusable(line)).toBe(true);
      expect(isNothingToKill(line)).toBe(false);
    });
  }

  it('answers neither for an unrecognized failure', () => {
    expect(isNothingToKill('server exited unexpectedly')).toBe(false);
    expect(isSocketDirUnusable('server exited unexpectedly')).toBe(false);
  });
});

describe('kill-verdict base attribution', () => {
  // A goal-state wording establishes death only about the base the client
  // EXAMINED: tmux falls back to /tmp when the pinned base is unusable and
  // answers about IT (probe-verified on 3.4 with a mid-window-deleted
  // base), and crediting that verdict to the pinned base read a live
  // server as reaped.
  it('credits a wording naming a path under the pinned base', () => {
    expect(
      verdictExaminedBase(
        'error connecting to /tmp/tmux-501/srv (No such file or directory)',
        '/tmp',
      ),
    ).toBe(true);
    expect(
      verdictExaminedBase(
        'no server running on /scratch/base/tmux-501/srv',
        '/scratch/base',
      ),
    ).toBe(true);
  });

  it('refuses a wording whose path names the FALLBACK base', () => {
    expect(
      verdictExaminedBase(
        'error connecting to /tmp/tmux-501/srv (No such file or directory)',
        '/scratch/gone',
      ),
    ).toBe(false);
    expect(
      verdictExaminedBase(
        "couldn't create directory /tmp/tmux-501 (Permission denied)",
        '/scratch/gone',
      ),
    ).toBe(false);
  });

  it('normalizes the base before comparing', () => {
    expect(
      verdictExaminedBase('no server running on /tmp/tmux-501/srv', '/tmp/'),
    ).toBe(true);
    expect(
      verdictExaminedBase(
        'no server running on /scratch/base/tmux-501/srv',
        '/scratch/base/',
      ),
    ).toBe(true);
  });

  it('keeps the old meaning for a wording that names no path', () => {
    expect(verdictExaminedBase('No such file or directory', '/tmp')).toBe(true);
  });

  // win32: realpathSafe resolves with `posix.*` by design (tmux's wordings are
  // POSIX paths), and this is the one fixture in the file that builds REAL
  // paths — `join()` hands it backslashes and `symlinkSync` needs a privilege
  // Windows does not give by default, so it fails red against healthy code.
  // Its POSIX-literal siblings above stay unguarded because they never touch
  // the filesystem.
  it.skipIf(process.platform === 'win32')(
    'canonicalizes a symlinked base the way tmux canonicalizes its wordings',
    () => {
      // tmux names the REALPATH of a symlinked socket base in its wordings
      // (probed on 3.4): under a linked TMUX_TMPDIR every honest verdict
      // names the target while the kill was pinned to the link, and the
      // lexical comparison rejected every one of them — a false orphan
      // WARNING for every server that predeceased its reap.
      const root = mkdtempSync(join(tmpdir(), 'tui-cap-verdict-'));
      try {
        const real = join(root, 'real');
        mkdirSync(real);
        const link = join(root, 'link');
        symlinkSync(real, link);
        expect(
          verdictExaminedBase(
            `no server running on ${real}/tmux-501/srv`,
            link,
          ),
        ).toBe(true);
        expect(
          verdictExaminedBase(
            `error connecting to ${real}/tmux-501/srv ` +
              '(No such file or directory)',
            link,
          ),
        ).toBe(true);
        // A wording about an UNRELATED directory stays refused.
        expect(
          verdictExaminedBase(
            `no server running on ${root}/elsewhere/tmux-501/srv`,
            link,
          ),
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('recognizes every create-directory wording', () => {
    for (const line of [
      "couldn't create directory /tmp/tmux-501 (Permission denied)",
      "can't create directory /tmp/tmux-501: Not a directory",
      'could not create directory /tmp/tmux-501 (Permission denied)',
      'cannot create directory /tmp/tmux-501: Permission denied',
    ]) {
      expect(isSocketDirNeverCreated(line)).toBe(true);
    }
    expect(isSocketDirNeverCreated('no server running on /tmp/x')).toBe(false);
  });
});

describe('captureServerName', () => {
  it('scopes by pid and nonce so concurrent reviews cannot collide', () => {
    expect(captureServerName(123, 'abcd')).toBe('qwen-review-capture-123-abcd');
    expect(captureServerName(123, 'abcd')).not.toBe(
      captureServerName(123, 'efgh'),
    );
  });
});

describe('validGeometry', () => {
  it('accepts sane terminals and refuses the degenerate ones', () => {
    expect(validGeometry(80, 24).ok).toBe(true);
    expect(validGeometry(500, 200).ok).toBe(true);
    // The exact lower bounds are ACCEPTED — a `v < lo` → `v <= lo` mutation
    // would refuse a legal 20×5 capture with a self-contradictory message.
    expect(validGeometry(20, 5).ok).toBe(true);
    for (const [c, r] of [
      [0, 24],
      [80, 0],
      [19, 24],
      [80, 4],
      [501, 24],
      [80, 201],
      [80.5, 24],
      [Number.NaN, 24],
      // The ROWS branch needs its own non-integer and NaN cases: with only
      // the cols ones, an asymmetric mutant that drops `Number.isInteger`
      // from the rows check shipped green — and `new-session -y 24.5`
      // reaches real tmux, which is not a shape this command should send.
      [80, 24.5],
      [80, Number.NaN],
    ] as const) {
      const v = validGeometry(c, r);
      expect(v.ok, `${c}x${r}`).toBe(false);
    }
  });

  it('names the FLAG that violated, not its sibling', () => {
    // The reason is user-facing: a flag-name swap once produced
    // "--rows must be an integer in [20, 500], got 10" for a --cols
    // violation — the caller then "fixes" the wrong flag.
    const cols = validGeometry(10, 24);
    if (!cols.ok) expect(cols.reason).toContain('--cols');
    const rows = validGeometry(80, 1000);
    if (!rows.ok) expect(rows.reason).toContain('--rows');
    expect(cols.ok).toBe(false);
    expect(rows.ok).toBe(false);
  });
});

describe('tmuxSupportsCaptureN', () => {
  it('accepts 3.1 and later, refuses the whole 3.0 line, ignores the unparseable', () => {
    // -N landed in 3.1 (upstream CHANGES lists it under "CHANGES FROM 3.0a
    // TO 3.1"; the 3.0a man page has no -N) — 3.0a/3.0b are TOO OLD, and
    // Ubuntu 20.04 ships 3.0a: accepting them would die mid-capture on the
    // unknown flag after paying for a server start.
    for (const line of ['tmux 3.1', 'tmux 3.1b', 'tmux 3.3a', 'tmux 4.0']) {
      expect(tmuxSupportsCaptureN(line), `${line}`).toBe(true);
    }
    for (const line of [
      'tmux 1.8',
      'tmux 2.8',
      'tmux 3.0',
      'tmux 3.0a',
      'tmux 3.0b',
    ]) {
      expect(tmuxSupportsCaptureN(line), `${line}`).toBe(false);
    }
    // Unparseable is undefined, not false: a version that cannot be named
    // is not a reason to refuse.
    expect(tmuxSupportsCaptureN('')).toBeUndefined();
    expect(tmuxSupportsCaptureN('no digits here')).toBeUndefined();
  });
});

describe('tmuxPlan — every call is scoped to the private server', () => {
  const plan = tmuxPlan({
    server: 'srv',
    session: 'cap',
    cols: 80,
    rows: 24,
    command: 'node cli.js',
    cwd: '/work',
    readyFile: '/ready',
    sleepBin: '/bin/sleep',
  });

  it('carries -L on every call — start, capture, captureText, kill', () => {
    // One stray unscoped call is the entire isolation property gone: an
    // unscoped kill-server would kill the USER's tmux server.
    for (const argv of [
      plan.start,
      plan.capture,
      plan.captureText,
      plan.kill,
    ]) {
      const i = argv.indexOf('-L');
      expect(i).toBeGreaterThan(-1);
      expect(argv[i + 1]).toBe('srv');
    }
    // POSITION is load-bearing in start, not just presence: tmux requires
    // global flags BEFORE the first command name, so a -L displaced past
    // the `;` separator dies "no server running" on real tmux while every
    // indexOf probe above stays green.
    expect(plan.start.slice(2, 4)).toEqual(['-L', 'srv']);
  });

  it('starts CONFIG-FREE with a POSIX pane shell, in ONE client invocation', () => {
    // -f /dev/null: without it the private server loads ~/.tmux.conf
    // (measured: destroy-unattached killed the detached session). The
    // default-shell pin rides the SAME invocation as new-session, chained
    // with `;`, because a session-less server exits the moment its first
    // client leaves — and it must run BEFORE the pane exists (measured:
    // tcsh as default-shell killed the holder instantly).
    expect(plan.start.slice(0, 2)).toEqual(['-f', '/dev/null']);
    const set = plan.start.indexOf('set-option');
    const sep = plan.start.indexOf(';');
    const news = plan.start.indexOf('new-session');
    expect(set).toBeGreaterThan(-1);
    expect(plan.start.slice(set, set + 4)).toEqual([
      'set-option',
      '-g',
      'default-shell',
      '/bin/sh',
    ]);
    expect(sep).toBeGreaterThan(set);
    expect(news).toBeGreaterThan(sep);
  });

  it('kills the SERVER, not the session — reaping everything it started', () => {
    expect(plan.kill).toEqual(['-L', 'srv', 'kill-server']);
  });

  it('sends each key as ONE token behind `--` — no joining, no flag-eating', () => {
    // Without `--`, tmux consumes a dash-leading token as a send-keys flag:
    // measured, `send-keys -t cap -l` exits 0 and types NOTHING — silent
    // evidence corruption. `--` makes every token a key, verbatim.
    expect(plan.sendKeys('C-c')).toEqual([
      '-L',
      'srv',
      'send-keys',
      '-t',
      'cap',
      '--',
      'C-c',
    ]);
    expect(plan.sendKeys('-l')[plan.sendKeys('-l').length - 1]).toBe('-l');
  });

  it('escapes a TRAILING `;` on the user-derived key and cwd elements', () => {
    // tmux's client splits any argv element ending in `;` into a separate
    // command before dispatch — `--` ends option parsing but never reaches
    // that splitter. Measured on tmux 3.3a: `send-keys -- 'x;'` typed only
    // `x` (exit 0, no warning), and `-c '/tmp/foo;'` turned the cwd element
    // into a command boundary and failed with a misleading socket error;
    // `\;` round-trips (pane_current_path came back `/tmp/foo;`).
    expect(plan.sendKeys('x;').at(-1)).toBe('x\\;');
    expect(plan.sendKeys(';').at(-1)).toBe('\\;');
    // Mid-string is literal to tmux already and passes through.
    expect(plan.sendKeys('a;b').at(-1)).toBe('a;b');
    // A token that ALREADY ends in `\;` still gets escaped: tmux consumes
    // that backslash (measured on 3.3a — the token `x\;` types `x;`, and
    // `x\\;` types `x\;`), and nothing escapes these values upstream, so
    // treating it as already-escaped silently typed the wrong keys.
    expect(plan.sendKeys('q\\;').at(-1)).toBe('q\\\\;');
    const withCwd = tmuxPlan({
      server: 'srv',
      session: 'cap',
      cols: 80,
      rows: 24,
      command: 'node cli.js',
      cwd: '/tmp/foo;',
      readyFile: '/tmp/out.holder-ready',
      sleepBin: '/bin/sleep',
    });
    expect(withCwd.start[withCwd.start.indexOf('-c') + 1]).toBe('/tmp/foo\\;');
  });

  it('escapes `#` in the cwd — the start-directory is FORMAT-EXPANDED', () => {
    // Measured on tmux 3.3a and 3.4: a real directory named
    // `/tmp/fmt/#{session_name}` passed the usability gate, and the pane
    // started in `/tmp/fmt` — the PARENT — with exit 0 and the manifest
    // recording the literal path. `##` round-trips to a literal `#`
    // (verified), so a plain `#` in a dirname survives the doubling.
    const fmt = tmuxPlan({
      server: 'srv',
      session: 'cap',
      cols: 80,
      rows: 24,
      command: 'node cli.js',
      cwd: '/tmp/fmt/#{session_name}',
      readyFile: '/tmp/out.holder-ready',
      sleepBin: '/bin/sleep',
    });
    expect(fmt.start[fmt.start.indexOf('-c') + 1]).toBe(
      '/tmp/fmt/##{session_name}',
    );
    const plainHash = tmuxPlan({
      server: 'srv',
      session: 'cap',
      cols: 80,
      rows: 24,
      command: 'node cli.js',
      cwd: '/tmp/d/a#b',
      readyFile: '/tmp/out.holder-ready',
      sleepBin: '/bin/sleep',
    });
    expect(plainHash.start[plainHash.start.indexOf('-c') + 1]).toBe(
      '/tmp/d/a##b',
    );
  });

  it('drops -N on the tmux versions that FABRICATE trailing spaces', () => {
    // 3.1-3.2.x pad each line out to the grid's allocated cells and have no
    // -T to undo it: measured on 3.2a (what Ubuntu 22.04 ships), a
    // three-character line came back with 17 phantom spaces. Trimming
    // understates a clipped right edge; padding INVENTS one, and the
    // command records the caveat as a degradation.
    const opts = {
      server: 'srv',
      session: 'cap',
      cols: 80,
      rows: 24,
      command: 'node cli.js',
      cwd: '/work',
      readyFile: '/ready',
      sleepBin: '/bin/sleep',
    };
    expect(tmuxPlan({ ...opts, captureTrailing: false }).capture).not.toContain(
      '-N',
    );
    expect(tmuxPlan({ ...opts, captureTrailing: true }).capture).toContain(
      '-N',
    );
    // Default stays -N: only the padding versions opt out.
    expect(tmuxPlan(opts).capture).toContain('-N');
    expect(tmuxPadsWithCaptureN('tmux 3.2a')).toBe(true);
    expect(tmuxPadsWithCaptureN('tmux 3.1')).toBe(true);
    // The lettered 3.1 line — Debian 11 ships 3.1c — on the TRUE side,
    // which is the dangerous one: it drops -N and adds the degradation
    // caveat. The false side already pins letters, and this predicate's
    // own history includes a lettered-minor regression.
    for (const v of ['tmux 3.1a', 'tmux 3.1b', 'tmux 3.1c', 'tmux 3.2']) {
      expect(tmuxPadsWithCaptureN(v)).toBe(true);
    }
    // The documented range is exactly 3.1-3.2.x. 3.0.x answered true,
    // contradicting the sibling predicate (there is no `capture-pane -N`
    // before 3.1) and the version gate that refuses those hosts first.
    for (const v of ['tmux 3.0', 'tmux 3.0a', 'tmux 3.0b']) {
      expect(tmuxPadsWithCaptureN(v)).toBe(false);
    }
    expect(tmuxPadsWithCaptureN('tmux 3.3a')).toBe(false);
    expect(tmuxPadsWithCaptureN('tmux 3.4')).toBe(false);
    expect(tmuxPadsWithCaptureN('tmux 4.0')).toBe(false);
    expect(tmuxPadsWithCaptureN('tmux next')).toBeUndefined();
  });

  it('adds capture-pane -T only when the tmux has it (3.4+)', () => {
    // -N alone pads a line out to its grid line's ALLOCATED cells: measured
    // on 3.4, a row that had held 24 characters and was erased and rewritten
    // with `BBB` came back as `BBB` plus four phantom spaces, so a column or
    // clipping verdict would judge allocation history. -T drops exactly
    // those unwritten positions. The same probe on 3.3a shows no padding —
    // and passing -T there fails the call ('unknown flag -T', measured), so
    // the flag must follow the version.
    const opts = {
      server: 'srv',
      session: 'cap',
      cols: 80,
      rows: 24,
      command: 'node cli.js',
      cwd: '/work',
      readyFile: '/ready',
      sleepBin: '/bin/sleep',
    };
    const trimmed = tmuxPlan({ ...opts, captureTrim: true });
    expect(trimmed.capture).toContain('-T');
    expect(trimmed.captureText).toContain('-T');
    // -N stays: the REAL trailing spaces are the evidence.
    expect(trimmed.capture).toContain('-N');
    const old = tmuxPlan({ ...opts, captureTrim: false });
    expect(old.capture).not.toContain('-T');
    expect(old.captureText).not.toContain('-T');
    expect(tmuxSupportsCaptureT('tmux 3.4')).toBe(true);
    expect(tmuxSupportsCaptureT('tmux 3.5a')).toBe(true);
    expect(tmuxSupportsCaptureT('tmux 4.0')).toBe(true);
    expect(tmuxSupportsCaptureT('tmux 3.3a')).toBe(false);
    expect(tmuxSupportsCaptureT('tmux 3.1')).toBe(false);
    expect(tmuxSupportsCaptureT('tmux next')).toBeUndefined();
  });

  it('starts the command behind `--` so a dash-leading command is not getopt fodder', () => {
    const i = plan.start.indexOf('--');
    expect(i).toBeGreaterThan(-1);
    expect(plan.start[i + 1]).toContain('node cli.js');
    expect(i + 2).toBe(plan.start.length);
  });

  it('PROPAGATES geometry — a hardcoded 80x24 must not pass', () => {
    // Every other plan call in this file uses 80x24, so a plan that
    // ignored opts.cols/opts.rows and hardcoded them passed the whole
    // suite — and the fake-tmux seam tests too, since they drive the same
    // default. Distinct values are the only way to see it.
    const p = tmuxPlan({
      server: 'srv',
      session: 'cap',
      cols: 132,
      rows: 43,
      command: 'node cli.js',
      cwd: '/work',
      readyFile: '/ready',
      sleepBin: '/bin/sleep',
    });
    expect(p.start[p.start.indexOf('-x') + 1]).toBe('132');
    expect(p.start[p.start.indexOf('-y') + 1]).toBe('43');
  });

  it('starts detached at the requested geometry and cwd', () => {
    // new-session and its `-s cap` are the join key every later call
    // targets via `-t cap` — dropping them would only fail the tmux-gated
    // integration tests, so they are pinned here too.
    expect(plan.start).toContain('new-session');
    const s = plan.start.indexOf('-s');
    expect(plan.start[s + 1]).toBe('cap');
    expect(plan.start).toContain('-d');
    const x = plan.start.indexOf('-x');
    expect(plan.start[x + 1]).toBe('80');
    const y = plan.start.indexOf('-y');
    expect(plan.start[y + 1]).toBe('24');
    const c = plan.start.indexOf('-c');
    expect(plan.start[c + 1]).toBe('/work');
  });

  it('holds the pane open past the command in a NESTED shell', () => {
    // tmux's remain-on-exit off destroys the session the moment the command
    // exits (measured: a render-and-exit fixture was uncapturable 0/10).
    // TWO shells, not one: in a single shell a command ending in `exit N`
    // (or `exec`, or its own `set -e`) takes the keep-alive down with it —
    // measured, deterministic "no server running" on `printf ...; exit 0`.
    // The inner sh absorbs the exit; the outer holds the pane, with the
    // hold on its OWN LINE so no command tail (`;`, `#`) can void it — and
    // `trap : INT` so one C-c through the capture's own --keys path kills
    // neither the holder nor the server (measured: untrapped, pane →
    // session → server died before the capture).
    expect(plan.start[plan.start.length - 1]).toBe(
      `trap : INT QUIT\n( trap '' INT QUIT; '/bin/sleep' 10800; kill -9 -$$ 2>/dev/null ) &\n: > '/ready'\n/bin/sh -c 'node cli.js'\ni=0; while [ $i -lt 180 ]; do '/bin/sleep' 60; i=$((i+1)); done`,
    );
  });

  it('quote-escapes the command inside the holder script', () => {
    const p = tmuxPlan({
      server: 'srv',
      session: 'cap',
      cols: 80,
      rows: 24,
      command: `printf '%s' "it's"`,
      cwd: '/work',
      readyFile: '/ready',
      sleepBin: '/bin/sleep',
    });
    // ONE layer: the plan hands tmux the holder SCRIPT, whose single
    // `/bin/sh -c '<command>'` line is the only place the command is
    // quoted. A
    // single quote in the command must not close that quoting. The
    // expectation is COMPOSED with the same POSIX escaping rule stated
    // independently ('→'\''): dropping esc() breaks the equality
    // (measured: the mutant produced a holder /bin/sh rejects with an
    // unmatched quote, while the structural assertions all stayed green).
    const esc = (v: string): string => v.replaceAll("'", "'\\''");
    const cmd = `printf '%s' "it's"`;
    const inner = `/bin/sh -c '${esc(cmd)}'`;
    const held = p.start[p.start.length - 1];
    expect(held).toBe(
      `trap : INT QUIT\n( trap '' INT QUIT; '/bin/sleep' 10800; kill -9 -$$ 2>/dev/null ) &\n: > '${esc('/ready')}'\n${inner}\ni=0; while [ $i -lt 180 ]; do '/bin/sleep' 60; i=$((i+1)); done`,
    );
  });

  it("runs the holder's sleeps by resolved path, never by bare name", () => {
    // The pane resolves a bare name through its OWN inherited PATH — the
    // hazard the `/bin/sh` pin three lines above it already answers. Under a
    // PATH that finds tmux but not sleep, the watchdog's `sleep 10800` exits
    // 127 in milliseconds and falls straight through to `kill -9 -$$`,
    // SIGKILLing the pane process group: the window collapses to ~0ms and
    // the bounded three-hour hold with it. The caller resolves it once and
    // the plan embeds it, quoted like every other caller-supplied path.
    const p = tmuxPlan({
      server: 'srv',
      session: 'cap',
      cols: 80,
      rows: 24,
      command: 'node cli.js',
      cwd: '/work',
      readyFile: '/ready',
      sleepBin: "/opt/sl eep/sl'eep",
    });
    const held = p.start[p.start.length - 1];
    expect(held).toContain(`'/opt/sl eep/sl'\\''eep' 10800`);
    expect(held).toContain(`'/opt/sl eep/sl'\\''eep' 60`);
    // No bare invocation survives anywhere in the script.
    expect(held).not.toMatch(/(^|[^'])\bsleep 10800/);
    expect(held).not.toMatch(/(^|[^'])\bsleep 60/);
  });

  it('quote-escapes the readyFile in the holder script', () => {
    // The holder shell re-parses the sentinel line, so the path needs its
    // OWN esc() — an unescaped apostrophe broke the quoting and burned the
    // full sentinel deadline blaming tmux (measured: exit 3 at ~10s, back
    // when the caller built this path from the user's --out). It is minted
    // under the system temp dir now, which is not a reason to drop the
    // escaping: this function takes the path from its caller, mkdtemp-style
    // parents are not guaranteed apostrophe-free, and the plan is pure —
    // it cannot know where the next caller's path comes from.
    const readyFile = "/evidence/ca'p/ready";
    const p = tmuxPlan({
      server: 'srv',
      session: 'cap',
      cols: 80,
      rows: 24,
      command: 'node cli.js',
      cwd: '/work',
      readyFile,
      sleepBin: '/bin/sleep',
    });
    const esc = (v: string): string => v.replaceAll("'", "'\\''");
    const inner = `/bin/sh -c '${esc('node cli.js')}'`;
    const held = p.start[p.start.length - 1];
    // Single layer now: the plan hands tmux the SCRIPT itself (default-shell
    // is pinned to /bin/sh in the same invocation), so the trap lives at
    // layer 0 — QUIT included — and only the sentinel path needs escaping.
    expect(held).toBe(
      `trap : INT QUIT\n( trap '' INT QUIT; '/bin/sleep' 10800; kill -9 -$$ 2>/dev/null ) &\n: > '${esc(readyFile)}'\n${inner}\ni=0; while [ $i -lt 180 ]; do '/bin/sleep' 60; i=$((i+1)); done`,
    );
  });

  it('matches --until on a joined, escape-free view while .ans stays physical', () => {
    // -J joins wraps and no -e keeps escapes out: a marker spanning a wrap
    // boundary or an SGR change can never match the physical frame
    // (measured: both miss forever).
    expect(plan.captureText).toEqual([
      '-L',
      'srv',
      'capture-pane',
      '-p',
      '-J',
      '-t',
      'cap',
    ]);
  });

  it('captures with escapes and trailing spaces, wraps NOT joined', () => {
    // -e escapes (freeze needs them), -N trailing spaces (a clipped right
    // edge is trailing-space significant). Deliberately no -J: joining wraps
    // re-flows the pane, erasing the wrap structure a layout claim is about —
    // measured on the smoke capture, where -J turned a wrapped 100-char line
    // back into one long line.
    expect(plan.capture).toEqual([
      '-L',
      'srv',
      'capture-pane',
      '-p',
      '-e',
      '-N',
      '-t',
      'cap',
    ]);
  });
});

describe('freezePlan', () => {
  it('renders the .ans as ansi to the named output', () => {
    expect(freezePlan('/x/a.ans', '/x/a.png')).toEqual([
      '--language',
      'ansi',
      '/x/a.ans',
      '--output',
      '/x/a.png',
    ]);
  });
});
