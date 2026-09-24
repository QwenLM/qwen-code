# Fresh-Startup Performance: Time to Typeable and RSS

[English](2026-09-24-fresh-startup-performance.md) | [简体中文](2026-09-24-fresh-startup-performance.zh-CN.md)

Status: implemented as a draft PR. Section 9 lists the decisions still open.

## 1. Problem

On a clean machine, `qwen` takes about 2.5 s before the user can type. For
the first ~2 s the terminal is blank, and the process tree holds about 575 MB
of RSS. `qwen -p` takes about 2.1 s before its first model request leaves the
process, even against a local model server that answers instantly.

Nothing measured this. The existing startup profiler starts its clock inside
the last process, after module loading. It reported about 1.8 s to
`input_enabled` while the user actually waited about 2.8 s, and no CI job
tracks interactive startup.

## 2. Method

We followed the approach in
[How we made claude.ai 3x faster in two weeks](https://claude.dev/blog/how-we-made-claude-ai-faster/)
(Anthropic, 2026). Its principles, as applied here:

1. **Measure the moment users feel, at p75.** The user-felt moment is "a
   typed key shows up in the input box", not an internal mark.
2. **Measuring makes a problem tractable.** Each slow stretch was traced,
   then shown with a number that a change could move, before anything was
   changed.
3. **Wall-clock is the truth but too noisy to gate on.** It is backed by
   deterministic proxies: process count, JS bytes loaded, and CPU
   instructions under Valgrind. Each proxy was checked against wall-clock
   before being trusted.
4. **Throw out metrics that are flaky or don't correlate.** They are listed
   in section 8.
5. **Guard against instability after "usable".** In their case that was
   layout shift after load; here it is the screen changing after TTI.

### 2.1 Clean environment

- **Install.** `corepack pnpm install --frozen-lockfile`, then build and
  bundle. Node 22, Linux, 4 vCPU.
- **Fresh state per run.** Every run gets new `HOME`, `QWEN_HOME`,
  `QWEN_RUNTIME_DIR`, `XDG_*` and `TMPDIR` directories. The workspace is an
  empty git repo, and `settings.json` holds only the auth type and model
  name. The environment is reduced to `PATH`, `LANG` and `TERM`.
- **Model.** A loopback OpenAI-compatible stub that answers instantly.
- **Entry point.** The real `qwen` bin entry, `scripts/cli-entry.js`.
- **Terminal.** A node-pty terminal at 120×40, with the screen reconstructed
  by `@xterm/headless`. It answers DA1 and OSC 11 the way a modern terminal
  does; a "silent" variant answers nothing.

### 2.2 Metrics

| ID  | Metric                         | Kind                     | Definition                                                                                                           |
| --- | ------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| J1  | Interactive TTI                | wall-clock, p75          | From spawning `qwen` until "Type your message" is visible, a key has been typed, and that key shows in the input box |
| J2  | Headless TTFR                  | wall-clock, p75          | From spawning `qwen -p` until the first request reaches the model server                                             |
| J3  | First content                  | wall-clock, p75          | From spawn until the first visible glyph (how long the screen stays blank)                                           |
| M1  | RSS at TTI                     | memory                   | Summed RSS of the process tree at TTI; for `-p`, peak RSS until exit                                                 |
| S1  | Post-TTI stability             | rate                     | Share of launches where the screen changes after TTI with no input                                                   |
| D1  | Node boots before TTI          | deterministic (strace)   | Number of Node processes started before TTI                                                                          |
| D2  | JS bytes loaded before TTI     | deterministic (strace)   | Bytes of JS read, summed over all processes                                                                          |
| D3  | CPU instructions, `-p` to exit | deterministic (Valgrind) | Measured with ASLR off, V8 `--predictable --hash-seed=1 --random-seed=1`, and a warm compile cache                   |

**Proxy validation:**

- **D3 tracks wall-clock.** Across `--version`, `--help`, `-p`, and `-p` with a
  warm cache, D3 correlates with wall-clock at Pearson r = 0.9997, and
  repeated runs agree to 0.008–0.04%.
- **D3 cannot see waits.** A terminal that never answers the OSC 11 probe
  adds 165 ms of wall-clock with no extra instructions.

### 2.3 Experiment protocol

- **One hypothesis per experiment.** The evidence behind each one comes from
  a CPU profile, strace, the esbuild metafile, or a screen diff.
- **Interleaved A/B.** Each change ran against the build before it in
  interleaved ABBA pairs: 20–30 pairs, each run in a fresh HOME. We report
  the paired median difference and how many pairs the change won.
- **Noise floor.** An A/A run with both builds laid out at the same directory
  depth showed no bias. The paired median was about 0, with roughly 50/50
  wins. A first A/A attempt had exposed a 24 ms path-depth bias, which the
  equal-depth layout fixed.
- **Keep or drop.** A change was kept only if its metric moved. A regression
  on any metric was root-caused before continuing.

## 3. Baseline: where the time went

| Finding                                                                                                                                                                                                                       | Evidence                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Process chain.** Four Node processes before TTI: the launcher, the CLI, a relaunched copy of the CLI, and `npm view` for the update check. The first CLI loads the whole module graph (~700 ms) and then relaunches itself. | strace; running as a single process gives −33% TTI and −240 MB |
| **Compile cache.** Interactive and `-p` never enable Node's compile cache; only the `serve`/`mcp`/`--help`/`--version` fast paths do.                                                                                         | Cold-cache runs equal warm-cache runs                          |
| **Import-time side effects.** 10 synchronous `execSync('command -v <editor>')` calls; 7 `sh`+`ps` spawns walking the IDE process ancestry; `npm view` during startup.                                                         | CPU-profile caller stacks                                      |
| **Two-byte JS source.** Comments containing `—`/`─` make 21 of the 25 MB of pre-TTI JS non-ASCII, so V8 stores it as two-byte strings; 64 ms go to UTF-8 decode.                                                              | Byte scan; CPU profile                                         |
| **Oversized module graph.** The whole `review` command tree (1.5 MB) is evaluated to parse arguments, and all ~190 highlight.js grammars are evaluated although only `common` is registered.                                  | esbuild metafile import chains                                 |
| **Late footer update.** The footer's git branch arrives after TTI, and Ink redraws the whole screen.                                                                                                                          | Screen diff after TTI                                          |

## 4. Goals and scope

**Goals.** Improve J1–J3 and M1 on a fresh start without regressing S1.

**In scope.** The plain interactive TUI, `-i` and `-p`, on POSIX.

**Unchanged:**

- ACP and IDE integrations;
- stream-json, `--json-fd`, file input and dual output;
- sandbox;
- Windows process handling;
- `advanced.autoConfigureMemory=true`.

**Out of scope for this PR:**

- resume and first-turn latency;
- field telemetry;
- CI gates.

## 5. Changes (experiment log)

Every Δ is a paired median against the previous build; "pairs" is how many
pairs the change won.

| #   | Change                                                                                                                                             | Result                                                                                       | Decision                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------ |
| E1  | Skip the relaunch when it adds no Node flags. Trust restarts re-exec in place (`execve`); `/update` runs in-process.                               | TTI −767 ms (20/20); first content −707 ms; RSS −190 MB; `-p` −748 ms                        | Kept                     |
| E2  | `module.enableCompileCache()` before loading the main module graph                                                                                 | Warm: TTI −358 ms (20/20), `-p` −296 ms, RSS +10 MB. Cold first launch: TTI +104 ms          | Kept                     |
| E3  | Probe for editors when the editor dialog asks, not at import time                                                                                  | First content −47 ms (19/24); TTI −32 ms (14/24)                                             | Kept                     |
| E4  | Walk the IDE process ancestry only when `TERM_PROGRAM=vscode`                                                                                      | TTI −50 ms (20/24); CPU −120 ms; **S1 regressed**, 8/24 → 22/24                              | Kept together with E5    |
| E5  | Resolve the git branch before the first frame                                                                                                      | S1 17/24 → 0/24; time neutral                                                                | Kept                     |
| E6  | esbuild `minifyWhitespace`, with `keepNames` still on                                                                                              | RSS −23 MB (24/24); first content −48 ms (21/24); TTI −36 ms (17/24); `-p` −43 ms and −21 MB | Kept, pending decision 3 |
| E7  | Start the update check 3 s after render                                                                                                            | TTI −56 ms (20/24); RSS at TTI −81 MB (24/24); CPU −335 ms                                   | Kept                     |
| E8  | The bin launcher imports the CLI in-process on POSIX. `gc` is exposed with `v8.setFlagsFromString`, and exit code 44 relaunches from an exit hook. | TTI −48 ms (20/24); first content −73 ms (23/24); RSS −49 MB (24/24); `-p` −48 ms and −50 MB | Kept                     |
| E9  | Register the `review` command only when `review` is in argv                                                                                        | RSS −8 MB (24/24); `-p` −14 MB; time neutral                                                 | Kept                     |
| E10 | Load only lowlight's `common` grammars (chunk 1.5 MB → 216 KB)                                                                                     | RSS −1.5 MB; time neutral                                                                    | Kept (improves D2)       |
| —   | Extension-store lock, suspected of costing 200 ms in `config.initialize`                                                                           | Uncontended: the gaps are a busy main thread, not the lock                                   | No change                |

### 5.1 The relaunch

The relaunch was the biggest single cost, and nobody could say what it was
for.

**What it did:**

- **Heap limit.** It adds `--max-old-space-size`, but only when
  `advanced.autoConfigureMemory` is `true`. The default is `false`, so by
  default the child got no extra flags.
- **Supervision.** The parent stayed alive only to handle three events:
  - exit 42: a folder or IDE trust change restarts the session;
  - exit 43: `/update` asks for a relaunch;
  - an IPC "update on exit" message.
- **Environment hand-off.** It passed along which variables came from `.env`
  or settings. This matters only across a process boundary.

**What changed.** On POSIX, when there are no memory flags and the mode needs
no separate supervisor, the CLI marks itself as supervising in-process:

- `relaunchApp()` runs exit cleanup and then `execve`s the same command line.
  It adds `--expose-gc` if gc had been exposed at runtime.
- `relaunchForUpdate()` runs the update handler in-process and exits with its
  code. When that code is 44, the launcher's exit hook relaunches.
- Every other mode keeps the supervised relaunch.

## 6. Results

Baseline `main` @ 906418a against the final build, 30 interleaved pairs, clean
HOME, 4 vCPU:

| Metric             | Baseline p50 | Final p50 | Change       | Pairs won |
| ------------------ | ------------ | --------- | ------------ | --------- |
| J1 interactive TTI | 2546 ms      | 1179 ms   | −54% (2.16×) | 30/30     |
| J3 first content   | 1973 ms      | 746 ms    | −62% (2.65×) | 30/30     |
| J2 headless TTFR   | 2149 ms      | 940 ms    | −56% (2.29×) | 30/30     |
| M1 RSS at TTI      | 574 MB       | 231 MB    | −60%         | 30/30     |
| M1 `-p` peak RSS   | 294 MB       | 218 MB    | −26%         | 30/30     |
| S1 post-TTI change | 12/30        | 0/30      | —            | —         |

**Headline.** The geometric mean over J1–J3 is **2.36× faster**, and RSS is
2.48× lower.

**Other scenarios:**

- First launch with an empty compile cache: TTI −40% (15/15 pairs).
- A terminal that ignores OSC 11: TTI −49% (15/15 pairs).

**Deterministic proxies:**

| Proxy              | Interactive    | Headless       |
| ------------------ | -------------- | -------------- |
| D1 Node boots      | 4 → 1          | 3 → 1          |
| D2 JS loaded       | 40.8 → 16.0 MB | 35.8 → 13.3 MB |
| Other subprocesses | 29 → 3         | 24 → 8         |

**D3.** The final `-p` count is 8.195 B instructions. The baseline counts at
least 9.37 B; that is a lower bound, because Valgrind drops the process image
that `execve` replaces.

## 7. Risks and behaviour changes

1. **Update-on-exit** (standalone and `updateCommand` installs). With no
   parent process, the startup check shows "Run /update to install the
   update." instead of installing after exit.
2. **Trust restart, then `/update`.** After an in-place trust restart, a later
   `/update` exits with code 44 instead of relaunching, because the new image
   has no launcher exit hook. The update itself is still installed.
3. **Stack traces.** With `minifyWhitespace`, stack traces from the bundle keep
   function names but lose useful line numbers.
4. **Short sessions.** The update check waits 3 s, so sessions shorter than
   that skip it.
5. **Legacy IDE discovery.** The IDE process walk now runs only in VS Code
   terminals. Legacy VS Code companions older than 0.5.1, reached through a
   terminal that rewrites `TERM_PROGRAM` (for example tmux), lose pid-file
   discovery.
6. **Compile cache.** It lives in the OS temp directory (about 9 MB), and the
   first launch after an install or upgrade is about 100 ms slower.
7. **Process chain.** On POSIX, `QWEN_CODE_LAUNCHER_PID` is no longer set.
   Only the Windows standalone updater reads it, and Windows keeps the spawned
   child.
8. **Core-gated areas.** The change touches `packages/core/src/**` and
   `packages/cli/src/config/**`, which need maintainer review.

## 8. Rejected metrics

| Metric                                        | Reason for rejection                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| External frame or write counts                | CV 12–18%, driven by PTY chunking                                                                                             |
| Raw subprocess counts from strace             | Not repeatable: `git` calls vary, and the `ps` walk depends on process-tree depth                                             |
| Interactive instruction counts under Valgrind | Spread of about 10%, because timer-driven work scales with the slowdown; needs a benchmark hook that exits at `input_enabled` |
| Internal `to_input_enabled` as the headline   | Misses about 1 s (35%) of what the user waits for; kept as a phase breakdown only                                             |

## 9. Open decisions

Each needs a maintainer and author decision before this leaves draft.

1. **Update-on-exit.** Keep the "Run /update" fallback, or restore
   install-after-exit with an exit hook?
2. **Trust restart, then `/update`.** Accept the edge case, or have in-place
   restarts re-exec the launcher so its exit hook survives?
3. **E6 stack traces.** Accept, ship sourcemaps (and decide how to load them),
   or drop E6, giving back 23 MB and about 40 ms?
4. **Update-check delay.** Is 3 s right, or should the check run when the
   session is idle instead?
5. **IDE walk.** Is gating it on `TERM_PROGRAM=vscode` acceptable for legacy
   companions?
6. **Split.** Land this as one PR, or split it into independent PRs? A
   natural split is:
   - E1+E8 (process chain);
   - E2 (compile cache);
   - E3/E4/E5/E7 (startup side effects);
   - E6/E9/E10 (bundle).
7. **Harness and CI.** Check in the benchmark harness and add D1–D3 CI
   ratchets? These would fail on any increase in D1/D2 or a >0.2% increase in
   D3; a nightly job would lower the ceilings and track J1–J3/S1. The harness
   is not part of this PR.

## 10. Validation

**Build and static checks:**

- `npm run build` and `npm run typecheck` pass.
- Lint and Prettier are clean on the changed files.
- `npm run check:serve-fast-path-bundle` passes.

**Unit tests:**

- cli: 973 tests across the touched modules;
- core IDE: 119 tests;
- `scripts/tests/cli-entry`: 10 tests.

New tests cover:

- in-process restart and update;
- relaunch routing;
- the IDE-walk gate;
- branch priming;
- the update-check delay;
- the in-process launcher and its exit-44 relaunch.

**Integration:**

- The no-API-key suite passes (26 files, 196 tests).
- The interactive suite passes except 4 tests that need real credentials; the
  baseline fails the same 4 in the same environment.

**Manual:**

- Drove the real folder-trust dialog: startup ran twice, the prompt was
  typeable again, and the session stayed a single process.
- A fake install that exits 44 relaunched with its arguments preserved, `gc`
  available, and the exit code propagated.
- `qwen review --help` works.

## 11. Acceptance criteria

The PR is ready when:

- J1, J2 and J3 improve by at least 2× at p75 against `main` in the clean
  environment, M1 improves by at least 50%, and S1 is 0.
- The decisions in section 9 are resolved and reflected in both language
  versions of this document.
- CI is green on macOS, Linux and Windows.

## 12. Follow-up

These are not part of this PR:

- **Render the prompt earlier.** `config.initialize()` still sits between first
  paint and TTI (about 350 ms). Showing the prompt before it finishes is a
  design change.
- **Trim the module graph further.** Candidates: `@google/genai` (581 KB) on
  OpenAI-auth sessions, and the daemon SDK and channels code (about 670 KB).
- **Fix the spurious notice.** "Extensions changed on disk" appears on a fresh
  HOME.
- **Add a render-commit counter** in the app, so "commits before TTI" can
  become a gate.
- **Field telemetry.** Enable the reserved `qwen-code.startup.duration`
  metric.
