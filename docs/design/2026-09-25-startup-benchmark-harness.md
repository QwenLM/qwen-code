# Startup Benchmark Harness

[English](2026-09-25-startup-benchmark-harness.md) | [简体中文](2026-09-25-startup-benchmark-harness.zh-CN.md)

Status: implemented.

## 1. Problem

The fresh-startup work in
[#12622](https://github.com/QwenLM/qwen-code/pull/12622) (design doc
`2026-09-24-fresh-startup-performance.md`) measured startup with a harness that
was never checked in. Its section 9 (decision 7) left it for this follow-up:
anyone should be able to repeat the measurements, on the same definitions,
without rebuilding the tooling. The same decision also proposed CI ratchets on
the deterministic counts; section 3.5 records why this design does not add
them.

Building the harness a second time, to verify that PR independently, turned
up pitfalls that silently skew the numbers. The harness should encode them so
nobody has to rediscover them.

## 2. Goals and scope

**Goals:**

- Check in a harness that measures the metrics of the fresh-startup design
  (J1, J2, J3, M1, S1, D1, D2) the same way it defines them.

**Out of scope:**

- A CI gate or scheduled job; the harness is run by hand (section 3.5).
- D3 (CPU instructions under Valgrind); it is slow and needs a benchmark hook.
- macOS and Windows; the harness reads `/proc` and uses strace.

## 3. Design

### 3.1 Components

| Piece                                     | Role                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `scripts/startup-benchmark/lib.mjs`       | Shared parts: a clean environment per launch, a loopback OpenAI-compatible stub, a real terminal, `/proc` and strace readers |
| `scripts/startup-benchmark/benchmark.mjs` | Interleaved A/B wall-clock benchmark of two builds, run by hand                                                              |
| `scripts/startup-benchmark/proxies.mjs`   | D1 and D2 for one build under strace, printed for manual comparison                                                          |

### 3.2 Clean environment

Every launch gets a new `HOME`, `QWEN_HOME`, `QWEN_RUNTIME_DIR`, `XDG_*`
directories and workspace, which is an empty git repository. The settings file
selects OpenAI auth against the loopback stub, and the environment is reduced
to what a terminal passes: `PATH`, `LANG`, `TERM` and the stub's key and URL.
`--credentials settings` or `--credentials dotenv` moves that key and URL out
of the shell into the settings file's `env` block, where `/auth` stores them,
or into `~/.qwen/.env`, where the docs recommend them, so the env-file
relaunch rule can be measured.
The CLI starts through the real bin entry, `cli-entry.js`, in a node-pty
terminal of 120×40 whose screen `@xterm/headless` reconstructs.

### 3.3 Metrics

The definitions are those of the fresh-startup design.

| ID  | Measured as                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------- |
| J1  | From spawn until "Type your message" is visible, a key has been typed, and that key shows in the input box |
| J3  | From spawn until the first visible glyph                                                                   |
| J2  | From spawning `qwen -p` until its first request reaches the stub                                           |
| M1  | Summed RSS of the process tree at J1; for `-p`, peak RSS until exit                                        |
| S1  | Whether text already on screen is replaced or cleared after J1                                             |
| D1  | Node process images started before J1 (for `-p`, before exit), counted from `execve`                       |
| D2  | Bytes of JavaScript those images opened, each file once per image                                          |

### 3.4 Pitfalls the harness encodes

| Pitfall                                                    | Effect if ignored                                                                | What the harness does                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Node writes its compile cache only on a normal exit        | A benchmark that kills its sessions measures a cold cache in every "warm" run    | Each interactive session ends with `/quit`; each build keeps its own cache directory            |
| xterm answers DA1 but not the background-colour query      | The CLI waits for the query to time out, which a real terminal never makes it do | The harness answers it, and `--silent-terminal` measures the waiting case                       |
| `npm` renames its process (`process.title`)                | A poll of process names misses the update check's `npm view`                     | D1 counts `execve` calls under strace instead of polling                                        |
| A forked child looks like `node` until it runs its program | Polling counts `git` and `rg` as Node processes                                  | Same: only `execve` of a `node` binary counts                                                   |
| Rows of one frame can arrive in separate reads             | A frame still being drawn looks like a change after J1                           | S1 counts only text that is replaced or cleared                                                 |
| Timing varies between separate runs                        | Comparing across runs shows shifts that no change caused                         | The benchmark alternates builds in pairs and reports the paired median difference and pairs won |

### 3.5 No CI gate

A CI step could fail a PR when D1 or D2 grows past a checked-in budget, and
catch a regression at the PR that introduces it. This design leaves it out:

- **Runner speed leaks in.** D1 and D2 count events, not time, but the
  interactive counts stop at J1, and some work before J1 is timer-driven: the
  update check's `npm view` and lazily loaded modules. A slow or contended
  runner shifts them, so a gate would either fail unrelated PRs or need a
  tolerance loose enough to miss real regressions.
- **Upkeep.** Every intended increase would need a budget change, and the
  harness breaks loudly when the prompt text or the quit flow changes.

Instead, PRs that touch startup run the harness by hand and report its
numbers, as the fresh-startup PR did.

## 4. Risks

1. **Manual only.** A startup regression is caught only when someone runs the
   harness.
2. **Linux only.** macOS and Windows startup is not measured.
3. **Coupling to the UI.** The harness waits for "Type your message" and quits
   with `/quit`. When either changes, it fails with the last screen instead of
   reporting wrong numbers.

## 5. Validation

- Unit tests cover the strace parsing.
- `proxies.mjs` measured `main` three times in a row: D1 was 4 interactive and
  2 for `-p` every time, and D2 was 44.9–45.0 MB and 21.7 MB. The fresh-startup
  PR measures 1 process for each, with 17.1 MB and 14.2 MB.
- `benchmark.mjs`, 8 pairs, `main` before the fresh-startup PR against that PR:
  J1 1755 → 852 ms, J3 1231 → 527 ms, J2 1366 → 636 ms, M1 574 → 232 MB, S1
  8/8 → 0/8. The PR won every pair.

## 6. Acceptance criteria

- The harness runs from the repository with no setup beyond `pnpm install`,
  a build and a bundle.
- Both language versions of this document match.
