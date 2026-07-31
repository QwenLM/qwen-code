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

Scan for other Qwen Code processes (excluding the current one — exclude the PID you see running this prompt). Since Qwen Code is a Node.js CLI (`#!/usr/bin/env node`), the process name (`comm` column) is always `node` (or `bun` if run with Bun). Identify Qwen Code sessions by looking at the `command` column for a script path inside a directory whose name starts with `qwen-code` (matches `qwen-code/`, `qwen-code-dev/`, worktree clones, etc.) — anchored to the start of the path or after `/` so unrelated names like `analyze-qwen-code/` don't false-match — or a bin invocation ending in `/qwen` (the global symlink). Avoid loose `qwen-code` substring matching: it false-positives on plugin brokers that merely pass a qwen-code path as `--cwd`.

Signs of a stuck session:

- **High CPU (>=90%) sustained** — likely an infinite loop. Sample twice, 1-2s apart, to confirm it's not a transient spike.
- **Process state `D` / `U` (uninterruptible sleep)** — often an I/O hang. Linux uses `D`, macOS/BSD uses `U`. The `state` column in `ps` output; first character matters (ignore modifiers like `+`, `s`, `<`).
- **Process state `T` (stopped)** — user probably hit Ctrl+Z by accident.
- **Process state `Z` (zombie)** — parent isn't reaping.
- **Very high RSS (>=4GB)** — possible memory leak making the session sluggish.
- **State `S` with low CPU** — the most common hang signature: a hung HTTPS request to the model API. Not a process-level red flag on its own, but combined with the user reporting "stuck", treat it as a strong signal to run the network check in step 3.
- **Stuck child process** — a hung `git`, `node`, or shell subprocess can freeze the parent. Check `pgrep -P <pid>` (then `ps -p` for state — see step 3) for each session.

## Argument validation

If the user gave an argument, treat it as a PID **only if it consists entirely of digits 0-9**. Anything else — letters, whitespace, punctuation — fails the check, in which case treat it as a free-text symptom description (guidance for the report only, never substituted into shell commands). The strict digit-only whitelist is safer than enumerating shell metacharacters.

## Investigation steps

**Preamble — resolve the runtime base directory.** Required for both paths below (sidecar enumeration in step 1, debug log lookup in step 3, and the PID fast path). The base directory is taken from (in priority order): `QWEN_RUNTIME_DIR` env var, the `advanced.runtimeOutputDir` setting, `QWEN_HOME` env var, and finally `~/.qwen`.

```
RUNTIME_DIR="${QWEN_RUNTIME_DIR:-}"
[ -z "$RUNTIME_DIR" ] && command -v jq >/dev/null && RUNTIME_DIR=$(jq -r '.advanced.runtimeOutputDir // empty' "${QWEN_HOME:-$HOME/.qwen}/settings.json" 2>/dev/null)
# `advanced.runtimeOutputDir` may be `~/...` or relative; mirror Storage.resolvePath() before using in globs
[ -n "$RUNTIME_DIR" ] && RUNTIME_DIR="${RUNTIME_DIR/#\~/$HOME}"
[ -n "$RUNTIME_DIR" ] && case "$RUNTIME_DIR" in /*) ;; *) RUNTIME_DIR="$(cd "$RUNTIME_DIR" 2>/dev/null && pwd)" || RUNTIME_DIR="" ;; esac
RUNTIME_DIR="${RUNTIME_DIR:-${QWEN_HOME:-$HOME/.qwen}}"
```

(If `jq` isn't installed, the settings layer is silently skipped — the env-var / default fallback covers the common case.)

**Fast path for targeted diagnosis** — if a digit-only PID argument was given, skip step 1 enumeration. Validate that the PID is a live current-user Qwen Code process before dumping any details:

```
kill -0 <pid> 2>/dev/null || { echo "PID <pid> is dead, or owned by another user"; exit 0; }
ps -p <pid> -o command= -ww 2>/dev/null | grep -qE '((^|/)qwen-code[^ /]*/[^ ]*\.(js|ts|mjs|cjs)( |$)|/qwen( |$))' || { echo "PID <pid> is yours but is not a Qwen Code process — refusing to dump details"; exit 0; }
```

If either guard prints, stop the diagnostic and surface the message verbatim. Otherwise, gather stats and the sidecar mapping, then jump to step 3:

```
ps -p <pid> -o pid=,pcpu=,rss=,etime=,state=,comm=,command= -ww
grep -El '"pid"[[:space:]]*:[[:space:]]*<pid>\b' "$RUNTIME_DIR"/projects/*/chats/*.runtime.json 2>/dev/null
```

Note: as in step 2, the `command=` column may include credentials passed as CLI args (e.g., `--openai-api-key=sk-…`). Redact such values to `***` before quoting them in the report.

`-E` is required so `\b` is interpreted as word boundary (BSD `grep` without `-E` treats `\b` as a backspace character, silently returning nothing on macOS). The `-l` flag returns the matching sidecar file path; the basename (stripped of `.runtime.json`) is the session ID for step 3's debug log read. If multiple sidecars match (rare — happens only after PID reuse leaves a stale file), prefer the most recently modified one: `ls -t <matches> | head -n 1`.

Otherwise (no arg, or symptom-only arg), run the general path below:

1. **Enumerate live sessions via the runtime sidecar** (preferred, reliable):

   Qwen Code writes a `runtime.json` sidecar for each interactive session at `"$RUNTIME_DIR"/projects/<sanitized-cwd>/chats/<sessionId>.runtime.json`. Each file contains `{schema_version, pid, session_id, work_dir, hostname, started_at, qwen_version}` — the authoritative source of `(pid, session_id, work_dir)` mappings.

   Filter to live `(pid, sidecar-path)` pairs in one shot. Use Node (guaranteed available — qwen-code requires it) instead of `jq` (often missing on default macOS / minimal Linux) so this path doesn't silently degrade:

   ```
   node -e 'const fs=require("fs"); for (const f of process.argv.slice(1)) { try { const p=JSON.parse(fs.readFileSync(f,"utf8")).pid; if (p) { try { process.kill(p,0); console.log(p+" "+f); } catch {} } } catch {} }' "$RUNTIME_DIR"/projects/*/chats/*.runtime.json 2>/dev/null
   ```

   PID reuse is rare but possible — when you cross-reference with `ps` in step 2, skip pairs whose live PID's command line no longer looks like a Qwen Code process.

   **If the command emits nothing** (no sidecars, or no live PIDs), fall through to step 2 — `ps` is the working fallback.

2. **List Qwen Code processes via `ps`** (macOS/Linux) — used to enrich each live session with CPU/RSS/state/uptime, and to catch sessions that may have started before the sidecar feature existed:

   ```
   ps -xo pid=,pcpu=,rss=,etime=,state=,comm=,command= -u "$(id -u)" -ww | grep -E '((^|/)qwen-code[^ /]*/[^ ]*\.(js|ts|mjs|cjs)( |$)|/qwen( |$))' | grep -v grep
   ```

   `-u "$(id -u)"` restricts the scan to the current user — on shared hosts this avoids exposing other users' Qwen process paths/arguments into the chat. `-ww` disables column truncation so long "qwen" paths aren't cut off. The `comm` column will be `node` or `bun`, not `qwen`; filter to rows where the `command` column contains a qwen path (e.g., `qwen-code/dist/cli.js`, or a bin symlink ending in `/qwen`). Cross-reference with the PIDs from step 1.

   Note: `ps` reports `rss` in **kilobytes** on both macOS and Linux. To report in MB, divide by 1024; to report in GB, divide by 1048576. The 4GB threshold is `4194304` KB — compare the raw `rss` value against that, or compare the GB value against 4. Do not divide once and then compare against 4; that would flag every process >4MB as "very high RSS".

   Note: full command lines may contain credentials passed as CLI args (e.g., `--openai-api-key=sk-…`). Redact such values to `***` before quoting them in the report.

3. **For anything suspicious**, gather more context. If the process state alone explains the problem (`T` = accidentally stopped, `Z` = parent not reaping), skip directly to the report — child / log / stack inspection adds nothing. Otherwise:
   - Child processes (with state, so a hung `git` / `node` shows up): `CHILDREN=$(pgrep -P <pid> | tr '\n' ',' | sed 's/,$//'); [ -n "$CHILDREN" ] && ps -p "$CHILDREN" -o pid=,ppid=,pcpu=,state=,etime=,command= -ww`. Single `ps` call (avoids forking one per child) and `-ww` so long child command lines aren't truncated.
   - If high CPU: sample again after 1-2s to confirm it's sustained
   - **Network hang** — if CPU is low and state is `S` despite the user reporting "stuck", the most likely cause is a hung HTTPS request to the model API. macOS: `lsof -nP -i -p <pid> 2>/dev/null | head -20` (the `-nP` flags skip reverse-DNS and port lookups, which can themselves hang). If `lsof` itself feels slow, prefix with `timeout 10` (or `gtimeout 10` on macOS with Homebrew coreutils). Linux: `ss -tnp 2>/dev/null | grep "pid=<pid>,"`. Note that `ss -tnp`'s `-p` requires root or `CAP_NET_ADMIN` — without it, the PID column shows `-` and the grep returns empty. If you see no matches but `ss -t 2>/dev/null` does show ESTABLISHED sockets, fall back to `lsof -nP -i -p <pid>` rather than reporting "no connections". A long-lived `ESTABLISHED` connection to a model host (dashscope, openai, anthropic, etc.) with no recent traffic is the smoking gun.
   - **Debug log** — start with `"$RUNTIME_DIR"/debug/latest` (symlink to the most recent session); if it matches the suspicious PID's session, that's usually the right one. Otherwise infer the session ID from the sidecar and read `"$RUNTIME_DIR"/debug/<session-id>.txt`. Bound the read with `tail -n 200 <path>` — debug logs can be GB-sized. The last few hundred lines typically show what the session was doing before hanging. Debug logs may contain prompts, file contents, or tokens from other sessions — paste only lines relevant to the hang, and never quote secrets/API keys you happen to see.

4. **Consider a stack dump** for a truly frozen process (advanced, optional):
   - macOS: `sample <pid> 3` gives a 3-second native stack sample. If `sample` itself seems to hang (the target's Mach task port may be wedged on a kernel-level freeze), wrap it: `timeout 15 sample <pid> 3` (or `gtimeout 15 ...` on Homebrew coreutils). Stack frames may include function arguments containing API keys or tokens held in memory — redact such values to `***` before including the dump in the report.
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
