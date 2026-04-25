---
description: Chat session manager. /chat [-s|-l|-r|-d|-h] [name]
---

# CRITICAL: First check {{args}}, then route

## Step 0: Immediate Validation (MUST execute FIRST)

**Check `{{args}}` right now, before doing anything else:**

1. Is `{{args}}` empty? �� **Show Help immediately, STOP**
2. Is `{{args}}` only whitespace? �� **Show Help immediately, STOP**
3. Does the first token look like a valid flag? (`-s`, `--save`, `-l`, `--list`, `-r`, `--resume`, `-d`, `--delete`, `-h`, `--help`)
   - **NO** �� invalid flag/unrecognized �� **Show Help immediately, STOP**
   - **YES** �� Continue to Step 1

**?? DO NOT skip this step. DO NOT proceed with any action until you verify `{{args}}`.**

---

## Step 1: Detect Environment
Read `./.qwen/settings.json` (project root).
If missing/not found → use `~/.qwen/settings.json` (global).

## Step 2: Detect Language
Read `./.qwen/settings.json` (project root).
Look for `general.language`.
If missing/not found → use `~/.qwen/settings.json` (global).
If still missing/not found → use `en`.
Supported languages: `zh`, `en`.

## Step 3: Parse Flags and Route
Split `{{args}}` by whitespace. First token = flag, rest = parameters.
Route based on flag:
| Flag | Action | File |
|------|--------|------|
| `-s` / `--save` `<name>` | Save session | `chat-save.md` |
| `-l` / `--list` | List sessions | `chat-list.md` |
| `-r` / `--resume` `<name>` | Resume session | `chat-resume.md` |
| `-d` / `--delete` `<name>` | Delete session | `chat-delete.md` |
| `-h` / `--help` | Show help | `chat-help.md` |
| (no flag) | New temporary session | `chat-new.md` |

## Step 4: Execute Command
Load the referenced `.md` file (from `.qwen/commands/`).
Replace `{{name}}` with the provided name parameter (if any).
Execute the command as written.

---
## Common Rules

| Rule | Value |
|------|-------|
| **Valid name regex** | `^[a-zA-Z0-9_.-]+$` |
| **Max length** | 128 characters |
| **Reserved names** | `.`, `..`, `__proto__`, `constructor`, `prototype` |
| **Index path** | `.qwen/chat-index.json` (project root) |
| **Index format** | `{"name": "sessionId", ...}` |
| **Session ID source** | Filename (no extension) of `.jsonl` in `.qwen/projects/<hash>/chats/` (project root) |
| **Hash calculation** | SHA-256 of the full project root path. Replace all `\` and `/` with `-`, then lowercase. Session files live under `.qwen/projects/<hash>/chats/` (project root) |

---
## Help Text

Usage: `/chat [-s|-l|-r|-d|-h] [name]`

Flags:
  -s, --save <name>   Save current session with name
  -l, --list          List all saved sessions
  -r, --resume <name> Resume a saved session
  -d, --delete <name> Delete a saved session
  -h, --help          Show this help message
  [name]              Session name (for -s/-r/-d flags)

Examples:
  /chat --save my-work    # Save current session as "my-work"
  /chat --resume my-work  # Resume session "my-work"
  /chat --list            # List all saved sessions
  /chat                   # Start new temporary session

Notes:
  - Session names must match `^[a-zA-Z0-9_.-]+$` and be ≤128 characters
  - Reserved names: `.`, `..`, `__proto__`, `constructor`, `prototype`
  - Session data stored in `.qwen/projects/<hash>/chats/` (project root)
  - `<hash>` is SHA-256 of project root path with all `\` and `/` replaced by `-`, then lowercased
