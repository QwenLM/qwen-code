---
description: Chat session manager. /chat [-s|-l|-r|-d|-h] [name]
---

# CRITICAL: First check {{args}}, then route

## Step 0: Immediate Validation (MUST execute FIRST)

**Check `{{args}}` right now, before doing anything else:**

1. Is `{{args}}` empty? → **Show Help immediately, STOP**
2. Is `{{args}}` only whitespace? → **Show Help immediately, STOP**
3. Does the first token look like a valid flag? (`-s`, `--save`, `-l`, `--list`, `-r`, `--resume`, `-d`, `--delete`, `-h`, `--help`)
   - **NO** → invalid flag/unrecognized → **Show Help immediately, STOP**
   - **YES** → Continue to Step 1

**⚠️ DO NOT skip this step. DO NOT proceed with any action until you verify `{{args}}`.**

---

## Step 1: Detect Environment

### Language

Read `~/.qwen/settings.json` (Windows: `%USERPROFILE%\.qwen\settings.json`).
Look for `general.language`. Respond in that language. If not found, match the language the user used in their prompt.

### OS Detection (ONLY for `-r`/`--resume`)

**Skip this step for other flags.** Only run when `-r` is detected.

Run `node -e "console.log(process.platform)"`. Works across all shells.

- `win32` → Windows
- `linux` → Linux
- `darwin` → macOS

---

## Step 2: Parse and Route

Split `{{args}}` by whitespace. First token = flag. Remaining = name.

| Flag              | Action                                    | Sub-Command File |
| ----------------- | ----------------------------------------- | ---------------- |
| `-s` / `--save`   | Go to Step 3                              | `chat-save.md`   |
| `-l` / `--list`   | Read `chat-list.md` and execute its logic | `chat-list.md`   |
| `-r` / `--resume` | Go to Step 3                              | `chat-resume.md` |
| `-d` / `--delete` | Go to Step 3                              | `chat-delete.md` |
| `-h` / `--help`   | **Show Help immediately, STOP**           | —                |

### Step 3: Validate name (for `-s`, `-r`, `-d`)

Extract the name (everything after the flag).

- Is name missing, empty, or whitespace only? → **Show Help immediately, STOP**
- Does name match `^[a-zA-Z0-9_.-]+$` and length ≤ 128?
  - **NO** → Output error: `Invalid name. Must match: ^[a-zA-Z0-9_.-]+$ (max 128 chars)` and STOP
  - **YES** → Check if name is reserved (`.`, `..`, `__proto__`, `constructor`, `prototype`)
    - **YES, reserved** → Output error: `Invalid name. Reserved: ., .., __proto__, constructor, prototype` and STOP
    - **NO, not reserved** → Read corresponding sub-command file and execute

---

## Common Rules

| Rule                  | Value                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Valid name regex**  | `^[a-zA-Z0-9_.-]+$`                                                                                                                                                                                  |
| **Max length**        | 128 characters                                                                                                                                                                                       |
| **Reserved names**    | `.`, `..`, `__proto__`, `constructor`, `prototype`                                                                                                                                                   |
| **Index path**        | `.qwen/chat-index.json` (project root)                                                                                                                                                               |
| **Index format**      | `{"name": "sessionId", ...}`                                                                                                                                                                         |
| **Session ID source** | Filename (no extension) of `.jsonl` in `~/.qwen/projects/<hash>/chats/`                                                                                                                              |
| **Hash calculation**  | Full cwd path, replace all non-alphanumeric characters with `-`. On Windows only, convert to lowercase. E.g., `D:\code\qwen-code` → `d--code-qwen-code` (Windows), `D--code-qwen-code` (Linux/macOS) |

---

## Help Text

**Show this when:**

- `{{args}}` is empty or whitespace only
- First token is NOT a valid flag
- Flag requires name but name is missing/empty
- User explicitly requests `-h` or `--help`

**Display this exact text and STOP all processing:**

```
Chat Session Manager

Usage: /chat <flag> [name]

Flags:
  -s, --save <name>   Save current session with a name
  -l, --list          List all saved sessions
  -r, --resume <name> Resume a saved session
  -d, --delete <name> Delete a saved session from index
  -h, --help          Show this help

Examples:
  /chat -s my-session
  /chat -l
  /chat -r my-session
  /chat -d my-session
```
