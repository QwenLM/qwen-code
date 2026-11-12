import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('./reap-isolated-home.sh', import.meta.url),
);

// The selection reads procfs, so a canned /proc is the only way to exercise it
// off Linux — and the only way to assert on a NEIGHBOUR job's process without
// starting one on a shared machine. Each entry names the home it belongs to,
// where it lives, and which of the three arms (cmdline / cwd / environ) carries
// the reference, because a detached daemon's argv usually carries none of it.
//
// `run` defaults to REAP_DRY_RUN=1, and every case that fabricates a pid keeps
// it: those pids are real on the machine running the test, so signalling them
// would signal whatever happens to own them. The signalling legs are covered
// separately, against processes this file actually starts (or, for the
// unreachable-pid case, one that cannot exist).
function fakeProc({ procs, root }) {
  const proc = join(root, 'proc');
  mkdirSync(proc, { recursive: true });
  for (const p of procs) {
    const dir = join(proc, String(p.pid));
    mkdirSync(dir, { recursive: true });
    // state is field 1 and ppid field 2 after the parenthesised comm, which is
    // deliberately hostile here: a comm with spaces AND a ')' is what breaks a
    // naive `awk '{print $4}'` over the whole line.
    writeFileSync(
      join(dir, 'stat'),
      `${p.pid} (a b) c) ${p.state ?? 'S'} ${p.ppid ?? 1} 1 1 0 -1 0\n`,
    );
    writeFileSync(
      join(dir, 'cmdline'),
      (p.argv ?? ['node', '/srv/cli.js', 'serve']).join('\0') + '\0',
    );
    writeFileSync(
      join(dir, 'environ'),
      Object.entries(p.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\0') + '\0',
    );
    if (p.cwd) {
      // readlink of a real symlink returns the target path verbatim, which is
      // what the script compares; the target need not exist (a daemon whose
      // cwd was already unlinked reports a ' (deleted)' suffix, covered below).
      symlinkSync(p.cwd, join(dir, 'cwd'));
    }
  }
  return proc;
}

function run({ home, procs = [], env = {}, root }) {
  const proc = fakeProc({ procs, root });
  return spawnSync('bash', [SCRIPT, home], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REAP_PROC_ROOT: proc,
      REAP_TERM_WAIT_TRIES: '2',
      REAP_DRY_RUN: '1',
      RUNNER_NAME: 'ecs-test-runner-1',
      GITHUB_RUN_ID: '43011096774',
      GITHUB_RUN_ATTEMPT: '1',
      ...env,
    },
  });
}

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'reap-home-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const HOME = '/runner/_temp/qwen-no-ak-home-43011096774-1';
const OTHER = '/runner/_temp/qwen-no-ak-home-99999999999-1';

// The real ancestor chain of this test process, including itself. The script
// reads its own chain from the real /proc, so these are the pids it will
// exclude; listing them in the scan root reproduces the cleanup shell's
// situation (HOME points at the home being removed).
function realAncestors() {
  const chain = [];
  let pid = process.pid;
  for (let hop = 0; hop < 32 && pid > 1; hop += 1) {
    chain.push(pid);
    const out = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    const ppid = Number(String(out.stdout).trim());
    if (!Number.isInteger(ppid) || ppid <= 0 || ppid === pid) break;
    pid = ppid;
  }
  chain.push(1);
  return chain;
}

function reaped(result) {
  return [...result.stdout.matchAll(/^REAP pid\[(\d+)\]/gm)].map((m) =>
    Number(m[1]),
  );
}

describe('reap-isolated-home selection', () => {
  it('selects a daemon by its home-bearing environment, not its argv', () => {
    // The measured shape: argv names no home at all, HOME does.
    withRoot((root) => {
      const r = run({
        root,
        home: HOME,
        procs: [
          { pid: 100, env: { HOME, QWEN_HOME: `${HOME}/.qwen` } },
          { pid: 200, env: { HOME: OTHER } },
        ],
      });
      assert.equal(r.status, 0);
      assert.deepEqual(reaped(r), [100]);
    });
  });

  it('selects by argv and by cwd as well', () => {
    withRoot((root) => {
      const r = run({
        root,
        home: HOME,
        procs: [
          { pid: 101, argv: ['node', `${HOME}/daemon.js`] },
          { pid: 102, cwd: `${HOME}/.qwen` },
          { pid: 103, cwd: `${HOME} (deleted)` },
          { pid: 201, argv: ['node', `${OTHER}/daemon.js`] },
        ],
      });
      assert.equal(r.status, 0);
      assert.deepEqual(reaped(r), [101, 102, 103]);
    });
  });

  it('never selects a neighbour job whose home merely shares the prefix', () => {
    // The pool runs many jobs per host. The run id is what separates them, and
    // a substring match would make `...-43011096774-1` match `...-1-extra`.
    withRoot((root) => {
      const r = run({
        root,
        home: HOME,
        procs: [
          { pid: 300, env: { HOME: `${HOME}-extra` } },
          { pid: 301, env: { HOME: '/runner/_temp' } },
          { pid: 302, env: { PATH: `/usr/bin:${HOME}/bin` } },
          { pid: 303, env: { HOME: OTHER } },
          // The argv arm had the same defect and only the environment arm was
          // pinned: a substring match here selected a neighbour's daemon on
          // hz3. Both the bare path and the `--flag=path` form are checked.
          { pid: 304, argv: ['node', `${HOME}-extra/daemon.js`] },
          { pid: 305, argv: ['node', `--home=${HOME}-extra`] },
          { pid: 306, cwd: `${HOME}-extra` },
        ],
      });
      assert.equal(r.status, 0);
      assert.deepEqual(reaped(r), []);
      assert.match(r.stdout, /no process references/);
    });
  });

  it('selects an argv entry that carries the home as a flag value', () => {
    withRoot((root) => {
      const r = run({
        root,
        home: HOME,
        procs: [{ pid: 310, argv: ['node', `--home=${HOME}`, 'serve'] }],
      });
      assert.equal(r.status, 0);
      assert.deepEqual(reaped(r), [310]);
    });
  });

  it(
    'excludes its own ancestors but not a daemon reparented to pid 1',
    // The chain is read from the REAL /proc, so this is only observable on
    // Linux. Elsewhere the chain is empty by design and the script declines to
    // signal at all (covered by the no-procfs and dry-run cases).
    { skip: process.platform !== 'linux' },
    () => {
      // The cleanup step itself runs with HOME set to this path, and the
      // script's own `tr`/`grep` receive the path as an argument. Signalling
      // either would kill the step doing the cleanup.
      withRoot((root) => {
        // The pids to exclude are the real ones: this test process and its
        // ancestors, listed in the scan root as holding the home, exactly as
        // the real cleanup shell is.
        const chain = realAncestors();
        const r = run({
          root,
          home: HOME,
          procs: [
            ...chain.map((pid) => ({ pid, ppid: 1, env: { HOME } })),
            // THE regression this pins: a detached daemon is reparented to
            // pid 1, which is on the ancestor chain. Excluding by parent
            // instead of by marker made the reaper select nothing on hz3.
            { pid: 601, ppid: 1, env: { HOME } },
            { pid: 600, ppid: 2, env: { HOME } },
          ],
        });
        assert.equal(r.status, 0);
        assert.deepEqual(reaped(r), [600, 601]);
      });
    },
  );

  it('excludes its own helpers by the marker they inherit at exec', () => {
    // The helpers hold the home path in their argv, so without this guard the
    // reaper kills its own grep. Their pids are unguessable, hence the marker.
    withRoot((root) => {
      const r = run({
        root,
        home: HOME,
        procs: [
          {
            pid: 800,
            ppid: 1,
            argv: ['grep', '-qF', '--', HOME],
            env: { HOME: '/root', REAP_SELF_MARKER: 'marker-under-test' },
          },
          { pid: 801, ppid: 1, argv: ['node', `${HOME}/d.js`] },
        ],
        env: { REAP_SELF_MARKER: 'marker-under-test' },
      });
      assert.equal(r.status, 0);
      assert.deepEqual(reaped(r), [801]);
    });
  });

  it('reports the selection and signals nothing under REAP_DRY_RUN', () => {
    // This is what makes the selection testable at all: the fabricated pids
    // are real pids on the test machine, so the dry run must not reach the
    // signalling legs even when the selection is non-empty.
    withRoot((root) => {
      const r = run({
        root,
        home: HOME,
        procs: [{ pid: 800, ppid: 1, env: { HOME } }],
      });
      assert.equal(r.status, 0);
      assert.deepEqual(reaped(r), [800]);
      assert.match(r.stdout, /dry run; signalling nothing/);
      // The dry run must not remove anything either — HOME here is a fabricated
      // path, and the script now owns the removal.
      assert.match(r.stdout, /dry run; removing nothing/);
      assert.doesNotMatch(r.stdout, /escalating to KILL/);
      assert.doesNotMatch(r.stdout, /all references stopped/);
    });
  });
});

describe('reap-isolated-home degradation', () => {
  it('refuses a relative or root-like path instead of scanning', () => {
    for (const home of ['relative/path', '/', '', '/x']) {
      withRoot((root) => {
        const r = run({
          root,
          home,
          procs: [{ pid: 700, env: { HOME: '/' } }],
        });
        assert.equal(r.status, 0, home);
        assert.deepEqual(reaped(r), [], home);
        assert.match(r.stdout, /refusing|no home path given/, home);
      });
    }
  });

  it('skips quietly when procfs is absent', () => {
    withRoot((root) => {
      // The removal still has to happen: without procfs there is nothing to
      // select, but the home is still this run's to reclaim.
      const home = join(root, 'qwen-no-ak-home-43011096774-1');
      mkdirSync(join(home, 'nested'), { recursive: true });
      const r = spawnSync('bash', [SCRIPT, home], {
        encoding: 'utf8',
        env: {
          ...process.env,
          REAP_PROC_ROOT: join(root, 'does-not-exist'),
        },
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /removing without a reap/);
      assert.equal(existsSync(home), false);
    });
  });

  it('never fails the job, whatever it finds', () => {
    // The caller's `rm -rf` is the real reclamation; a reap that cannot signal
    // anything must degrade to today's behaviour, not redden the check it is
    // trying to protect.
    withRoot((root) => {
      const r = run({
        root,
        home: HOME,
        // A pid that cannot exist: kill fails on both legs.
        procs: [{ pid: 2147483646, env: { HOME } }],
        env: { REAP_TERM_WAIT_TRIES: 'not-a-number', REAP_DRY_RUN: '' },
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /REAP_TERM_WAIT_TRIES must be/);
      assert.deepEqual(reaped(r), [2147483646]);
    });
  });

  it('reports a failed removal instead of returning its status', () => {
    // The script is the cleanup step's last command, so a non-zero exit here
    // reddens a job whose tests all passed — the exact failure it exists to
    // prevent. A read-only parent makes rm fail for an unprivileged user.
    const root = mkdtempSync(join(tmpdir(), 'reap-rmfail-'));
    const home = join(root, 'qwen-no-ak-home-43011096774-1');
    mkdirSync(join(home, 'nested'), { recursive: true });
    try {
      chmodSync(root, 0o500);
      const r = spawnSync('bash', [SCRIPT, home], {
        encoding: 'utf8',
        env: { ...process.env, REAP_PROC_ROOT: join(root, 'absent') },
      });
      if (process.getuid && process.getuid() === 0) {
        // root bypasses the permission, so the trigger cannot be built here.
        assert.equal(r.status, 0);
      } else {
        assert.equal(r.status, 0, `must not redden the job:\n${r.stderr}`);
        assert.match(r.stdout, /could not remove/);
      }
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('reap-isolated-home against a real process', () => {
  // The canned-proc tests above prove the selection; this proves the signals
  // actually stop something and that the ENOTEMPTY race is gone. Skipped off
  // Linux, where the real /proc the script defaults to does not exist.
  const isLinux = process.platform === 'linux';

  it(
    'treats a zombie as stopped instead of warning about it',
    { skip: !isLinux },
    async () => {
      // kill -0 succeeds on a zombie, but it holds no cwd and no descriptor, so
      // it cannot recreate an entry. Counting it as alive burns both wait
      // windows and ends in a false warning while the removal was already safe.
      //
      // The pid is a real child this test owns (so kill -0 genuinely succeeds
      // and any signal is harmless), while the STATE comes from the scan root.
      // A real zombie cannot be produced portably — node reaps its own children
      // — and a fabricated pid would make kill -0 consult a stranger's process.
      const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
      const root = mkdtempSync(join(tmpdir(), 'reap-zombie-'));
      try {
        const r = run({
          root,
          home: HOME,
          procs: [{ pid: sleeper.pid, ppid: 2, state: 'Z', env: { HOME } }],
          env: { REAP_DRY_RUN: '' },
        });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /all references stopped/);
        assert.doesNotMatch(r.stdout, /escalating to KILL/);
        assert.doesNotMatch(r.stdout, /still alive after KILL/);
      } finally {
        sleeper.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    'stops a writer holding the home so the removal succeeds',
    { skip: !isLinux },
    async () => {
      // The writer has to create NEW SUBDIRECTORIES in bulk, not rewrite one
      // file. Measured on hz3: a 5ms single-file writer left `rm -rf` winning
      // every time (so a test built on it proves nothing), while bulk fresh
      // directories reproduce the production failure verbatim —
      // `rm: cannot remove '<home>': Directory not empty`, exit 1.
      //
      // The tree is CAPPED at 12k directories, two orders of magnitude below
      // the pool's tmpfs inode budget. That cap is load-bearing on this shared
      // fleet: /tmp there is a tmpfs with a fixed 1M-inode allowance for EVERY
      // job on the host, and an uncapped writer exhausts it in about five
      // seconds — killing the writer with ENOSPC before the assertion runs and
      // reddening the host's other jobs too.
      const root = mkdtempSync(join(tmpdir(), 'reap-live-'));
      const home = join(root, 'qwen-no-ak-home-43011096774-1');
      mkdirSync(home, { recursive: true });
      const writer = spawn(
        process.execPath,
        [
          '-e',
          `const fs=require('fs');const p=${JSON.stringify(home)};let i=0;` +
            // Stay alive and keep writing, but CAP the tree: once the cap is
            // reached, recycle the same directories instead of minting new
            // ones. rm still loses the race (the entries keep reappearing)
            // while the inode cost stays bounded. An uncapped writer, or one
            // that exits at the cap, both break this test — the first by
            // exhausting the host, the second by being gone before the reap.
            `const t=setInterval(()=>{for(let k=0;k<50;k++){` +
            `const d=p+'/d'+((i++)%12000);fs.mkdirSync(d,{recursive:true});` +
            `fs.writeFileSync(d+'/f','x');}},1);`,
        ],
        { env: { ...process.env, HOME: home }, stdio: 'ignore' },
      );
      try {
        await new Promise((r) => setTimeout(r, 500));
        // Without a reap the removal really does fail, which is what makes the
        // assertion below evidence rather than a tautology. Verified by
        // mutation: removing both kill legs reddens this test.
        const r = spawnSync('bash', [SCRIPT, home], {
          encoding: 'utf8',
          env: { ...process.env, REAP_TERM_WAIT_TRIES: '20' },
        });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(
          reaped(r).includes(writer.pid),
          `writer ${writer.pid} not selected:\n${r.stdout}`,
        );
        assert.match(r.stdout, /all references stopped/);
        // A process that exits mid-scan must not put shell errors in the job
        // log: the redirection form `< file` reports `No such process` even
        // with 2>/dev/null on the command.
        assert.equal(r.stderr, '', `unexpected stderr:\n${r.stderr}`);
        // The script owns the removal the lane used to spell out, so a green
        // exit must mean the home is actually GONE — not merely that the reap
        // reported success and left the directory behind.
        assert.equal(
          existsSync(home),
          false,
          'the home must be removed, not just reaped',
        );
      } finally {
        try {
          writer.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
