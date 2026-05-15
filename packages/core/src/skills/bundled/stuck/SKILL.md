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
- **Stuck child process** — a hung `git`, `node`, or shell subprocess can freeze the parent. Check `pgrep -lP <pid>` for each session.

## Argument validation

If the user gave an argument, first check whether it is a positive integer (PID). If it contains shell metacharacters (`$`, `;`, `|`, `&`, `` ` ``, `(`, `)`, `<`, `>`, `*`, `?`, backslash, quote, whitespace, etc.), refuse to proceed and tell the user the argument does not look like a valid PID. Treat free-text symptom descriptions as guidance for the report, not as values to substitute into shell commands.

## Investigation steps

1. **Enumerate live sessions via the runtime sidecar (preferred, reliable)**:

   Qwen Code writes a `runtime.json` sidecar for each interactive session at `<runtime-base>/projects/<sanitized-cwd>/chats/<sessionId>.runtime.json`. The default `<runtime-base>` is `~/.qwen` (overridable by `QWEN_RUNTIME_DIR` or `QWEN_HOME`). Each file contains `{schema_version, pid, session_id, work_dir, hostname, started_at, qwen_version}`. Use this as the authoritative source of `(pid, session_id, work_dir)` mappings:

   ```
   ls -1 ~/.qwen/projects/*/chats/*.runtime.json 2>/dev/null
   ```

   For each file, read it and check whether the recorded `pid` is still alive (`kill -0 <pid>` returns 0). Stale files where the PID is gone mean the session has exited — skip them silently.

2. **List Qwen Code processes via `ps`** (macOS/Linux) — used to enrich each live session with CPU/RSS/state/uptime, and to catch sessions that may have started before the sidecar feature existed:

   ```
   ps -axo pid=,pcpu=,rss=,etime=,state=,comm=,command= -ww | grep -E '(qwen|node.*qwen|bun.*qwen)' | grep -v grep
   ```

   The `-ww` flag disables column truncation — without it, long command paths get cut off and `grep` may miss sessions whose "qwen" path component falls beyond the terminal width. The `comm` column will be `node` or `bun`, not `qwen`. Filter to rows where the `command` column contains a path related to qwen (e.g., `qwen-code/dist/cli.js`, or a bin symlink ending in `/qwen`). Cross-reference with the PIDs from step 1.

3. **For anything suspicious**, gather more context. Substitute `<pid>` only after the validation in "Argument validation" above (or after taking it from `ps` / sidecar output, which is trusted):
   - Child processes: `pgrep -lP <pid>`
   - If high CPU: sample again after 1-2s to confirm it's sustained
   - If a child looks hung (e.g., a git command), note its full command line with `ps -p <child_pid> -o command=`
   - Check the session's debug log if you can infer the session ID (from the sidecar): `~/.qwen/debug/<session-id>.txt` (the last few hundred lines often show what it was doing before hanging). If `QWEN_RUNTIME_DIR` or `QWEN_HOME` is set, the debug directory is `$QWEN_RUNTIME_DIR/debug/` or `$QWEN_HOME/debug/` instead of the default.
   - The `~/.qwen/debug/latest` symlink points to the most recent session's log

4. **Consider a stack dump** for a truly frozen process (advanced, optional):
   - macOS: `sample <pid> 3` gives a 3-second native stack sample
   - Linux: `cat /proc/<pid>/stack` for kernel stack, or `strace -p <pid> -c -f` for syscall profile
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

## Notes

- Don't kill or signal any processes — this is diagnostic only.
- If the user gave an argument (e.g., a specific PID or symptom), focus there first.
