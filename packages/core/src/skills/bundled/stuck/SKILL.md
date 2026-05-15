---
name: stuck
description: Diagnose frozen, stuck, or slow Qwen Code sessions on this machine. Scans for problematic processes, high CPU/memory usage, hung subprocesses, and debug logs. Use /stuck or /stuck <PID> to focus on a specific process.
argument-hint: '[PID or symptom]'
allowedTools:
  - run_shell_command
  - read_file
---

# /stuck — diagnose frozen/slow Qwen Code sessions

The user thinks another Qwen Code session on this machine is frozen, stuck, or very slow. Investigate and present a diagnostic report.

## What to look for

Scan for other Qwen Code processes (excluding the current one — exclude the PID you see running this prompt). Since Qwen Code is a Node.js CLI (`#!/usr/bin/env node`), the process name (`comm` column) is always `node` (or `bun` if run with Bun). Identify Qwen Code sessions by looking at the `command` column for paths containing "qwen" (e.g., `node /path/to/qwen-code/dist/cli.js` or a symlinked `qwen` script).

Signs of a stuck session:

- **High CPU (>=90%) sustained** — likely an infinite loop. Sample twice, 1-2s apart, to confirm it's not a transient spike.
- **Process state `D` / `U` (uninterruptible sleep)** — often an I/O hang. Linux uses `D`, macOS/BSD uses `U`. The `state` column in `ps` output; first character matters (ignore modifiers like `+`, `s`, `<`).
- **Process state `T` (stopped)** — user probably hit Ctrl+Z by accident.
- **Process state `Z` (zombie)** — parent isn't reaping.
- **Very high RSS (>=4GB)** — possible memory leak making the session sluggish.
- **Stuck child process** — a hung `git`, `node`, or shell subprocess can freeze the parent. Check `pgrep -P <pid>` (then `ps -p` for state — see step 3) for each session.

## Argument validation

If the user gave an argument, treat it as a PID **only if it consists entirely of digits 0-9**. Anything else — letters, whitespace, punctuation — fails the check, in which case treat it as a free-text symptom description (guidance for the report only, never substituted into shell commands). The strict digit-only whitelist is safer than enumerating shell metacharacters.

## Investigation steps

1. **Resolve the runtime base directory**, then enumerate live sessions via the runtime sidecar (preferred, reliable):

   Qwen Code writes a `runtime.json` sidecar for each interactive session at `<runtime-base>/projects/<sanitized-cwd>/chats/<sessionId>.runtime.json`. The base directory is taken from (in priority order): `QWEN_RUNTIME_DIR`, `QWEN_HOME`, the `advanced.runtimeOutputDir` setting, and finally `~/.qwen`. Use the resolved value in every command below — substituting the literal default would silently miss sessions on machines that override it.

   ```
   RUNTIME_DIR="${QWEN_RUNTIME_DIR:-${QWEN_HOME:-$HOME/.qwen}}"
   ls -1 "$RUNTIME_DIR"/projects/*/chats/*.runtime.json 2>/dev/null
   ```

   (If the user has set `advanced.runtimeOutputDir` in `settings.json`, ask them or read it from settings; otherwise the env-var resolution above is correct.) Each sidecar file contains `{schema_version, pid, session_id, work_dir, hostname, started_at, qwen_version}` — the authoritative source of `(pid, session_id, work_dir)` mappings.

   For each file, read it and check whether the recorded `pid` is still alive (`kill -0 <pid>` returns 0). Stale files where the PID is gone mean the session has exited — skip them silently. PID reuse is rare but possible, so when you cross-reference with `ps` in step 2, also skip records whose live PID's command line no longer looks like a Qwen Code process.

   **If no sidecar files are found** (empty output, or the directory does not exist), fall through to step 2 — `ps` is the working fallback.

2. **List Qwen Code processes via `ps`** (macOS/Linux) — used to enrich each live session with CPU/RSS/state/uptime, and to catch sessions that may have started before the sidecar feature existed:

   ```
   ps -xo pid=,pcpu=,rss=,etime=,state=,comm=,command= -u "$(id -u)" -ww | grep -E '(qwen|node.*qwen|bun.*qwen)' | grep -v grep
   ```

   `-u "$(id -u)"` restricts the scan to the current user — on shared hosts this avoids exposing other users' Qwen process paths/arguments into the chat. `-ww` disables column truncation so long "qwen" paths aren't cut off. The `comm` column will be `node` or `bun`, not `qwen`; filter to rows where the `command` column contains a qwen path (e.g., `qwen-code/dist/cli.js`, or a bin symlink ending in `/qwen`). Cross-reference with the PIDs from step 1.

   Note: `ps` reports `rss` in **kilobytes** on both macOS and Linux. Divide by 1024 before comparing to the >=4GB threshold or reporting in MB.

   Note: full command lines may contain credentials passed as CLI args (e.g., `--openai-api-key=sk-…`). Redact such values to `***` before quoting them in the report.

3. **For anything suspicious**, gather more context. If the process state alone explains the problem (`T` = accidentally stopped, `Z` = parent not reaping), skip directly to the report — child / log / stack inspection adds nothing. Otherwise, substitute `<pid>` only after the validation in "Argument validation" above (or after taking it from `ps` / sidecar output, which is trusted):
   - Child processes (with state, so a hung `git` / `node` shows up): `pgrep -P <pid>` to get child PIDs, then `ps -p <child_pids> -o pid=,ppid=,pcpu=,state=,etime=,command=` for their state
   - If high CPU: sample again after 1-2s to confirm it's sustained
   - Check the session's debug log if you can infer the session ID (from the sidecar): `"$RUNTIME_DIR"/debug/<session-id>.txt` using the same `RUNTIME_DIR` resolved in step 1. The last few hundred lines often show what it was doing before hanging. Debug logs may contain prompts, file contents, or tokens from other sessions — paste only the lines relevant to the hang, and never quote secrets/API keys you happen to see.
   - The `"$RUNTIME_DIR"/debug/latest` symlink points to the most recent session's log

4. **Consider a stack dump** for a truly frozen process (advanced, optional):
   - macOS: `sample <pid> 3` gives a 3-second native stack sample. Stack frames may include function arguments containing API keys or tokens held in memory — redact such values to `***` before including the dump in the report.
   - Linux: `cat /proc/<pid>/stack` for kernel stack (read-only, no `ptrace` permissions needed). Avoid `strace -p` for this purpose: it requires `CAP_SYS_PTRACE` (often denied under `kernel.yama.ptrace_scope=1`), and `strace -c` blocks until the target exits — it would hang on the very kind of stuck process you are diagnosing.
   - This is big — only grab it if the process is clearly hung and you want to know _why_

## Report

Present a structured diagnostic report directly to the user with these sections:

**For each stuck/slow session found:**

- PID, CPU%, RSS (in MB), process state, uptime, full command line
- Child processes and their states
- Your diagnosis of what's likely wrong
- Relevant debug log tail if you captured it
- Stack dump output if you captured it
- Suggested next step for the user to decide (e.g., "user may consider `kill <pid>` if the session is unresponsive", "likely waiting on I/O — check disk", "accidentally stopped — user can resume with `kill -CONT <pid>`"). Do not execute these actions yourself — present them as options for the user.

**If every session looks healthy**, tell the user directly — no diagnostic dump needed. Mention how many sessions you checked and that none showed signs of being stuck.

**If no sessions are found at all** (zero sidecars and zero matching `ps` rows), say so explicitly: which `RUNTIME_DIR` you searched and that `ps` returned no qwen-related processes for the current user. Suggest the session may have already exited.

## Notes

- Don't kill or signal any processes — this is diagnostic only.
- If the user gave an argument (e.g., a specific PID or symptom), focus there first.
