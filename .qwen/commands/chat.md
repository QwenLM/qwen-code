---
description: Chat session manager. /chat [-s|-l|-r|-d|-h] [name] [-y|--force]
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

Run `node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"` to get system locale.
Use the language code (first 2 chars, e.g., "en", "zh", "ja") to determine response language.
If locale detection fails, match the language the user used in their prompt.

### OS Detection (ONLY for `-r`/`--resume`)

**Skip this step for other flags.** Only run when `-r` is detected.

Run `node -e "console.log(process.platform)"`. Works across all shells.

- `win32` → Windows
- `linux` → Linux (including WSL — detect WSL separately, see chat-resume.md)
- `darwin` → macOS

**WSL Detection**: If platform is `linux`, additionally read `/proc/version`. If it contains "Microsoft" or "WSL" (case-insensitive), treat as Windows for resume — use Windows Terminal or CMD.

---

## Step 2: Parse and Route

Split `{{args}}` by whitespace. First token = flag. Remaining = raw_args.

| Flag              | Action                                    | Sub-Command File |
| ----------------- | ----------------------------------------- | ---------------- |
| `-s` / `--save`   | Go to Step 3                              | `chat-save.md`   |
| `-l` / `--list`   | Read `chat-list.md` and execute its logic | `chat-list.md`   |
| `-r` / `--resume` | Go to Step 3                              | `chat-resume.md` |
| `-d` / `--delete` | Go to Step 3                              | `chat-delete.md` |
| `-h` / `--help`   | **Show Help immediately, STOP**           | —                |

### Step 3: Validate name (for `-s`, `-r`, `-d`)

**For delete (`-d`):**

1. Parse raw_args to extract name: Filter out `-y` and `--force` flags first, the first remaining token is the name.
2. If name is missing, empty, or whitespace only → **Show Help immediately, STOP**
3. If extra non-flag tokens remain after the first name → **Show Help immediately, STOP**
4. If `-y` or `--force` was found → Set `forceDelete = true`

**For save/resume (`-s`, `-r`):**

1. Parse raw_args to extract name: the first remaining token is the name.
   - **Reject any token starting with `-`** (e.g., `-y`, `--force` are delete-only options)
   - If extra non-flag tokens remain after the first name → Output: `Error: Unexpected token: <token>. /chat -s|-r takes only a single name.` and STOP
2. If name is missing, empty, or whitespace only → **Show Help immediately, STOP**

**Common validation:**

- Does name match `^[a-zA-Z0-9_.-]+$` and length ≤ 128?
  - **NO** → Output error: `Invalid name. Must match: ^[a-zA-Z0-9_.-]+$ (max 128 chars)` and STOP
  - **YES** → Check if name is reserved (`.`, `..`, `__proto__`, `constructor`, `prototype`)
    - **YES, reserved** → Output error: `Invalid name. Reserved: ., .., __proto__, constructor, prototype` and STOP
    - **NO, not reserved** → Read corresponding sub-command file and execute

---

## Common Rules

| Rule                  | Value                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Valid name regex**  | `^[a-zA-Z0-9_.-]+$`                                                                                                                                       |
| **Max length**        | 128 characters                                                                                                                                            |
| **Reserved names**    | `.`, `..`, `__proto__`, `constructor`, `prototype`                                                                                                        |
| **Index path**        | `.qwen/chat-index.json` (project root)                                                                                                                    |
| **Index format**      | `{"name": "sessionId", ...}`                                                                                                                              |
| **Session ID source** | Filename (no extension) of `.jsonl` in `<runtimeBase>/projects/<sanitizeCwd>/chats/`. runtimeBase priority: `$QWEN_RUNTIME_DIR` > `~/.qwen` (default)     |
| **Project dir**       | `sanitizeCwd(projectRoot)` replaces all non-alphanumeric characters with `-`. On Windows, also lowercase. E.g., `D:\code\qwen-code` → `d--code-qwen-code` |

**Note**: If user has configured `advanced.runtimeOutputDir` in settings.json, sessions are stored under that path. /chat commands cannot read settings.json (credential leak risk) and will not find those sessions.

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

Usage: /chat <flag> [name] [-y|--force]

Flags:
  -s, --save <name>   Save current session with a name
  -l, --list          List all saved sessions
  -r, --resume <name> Resume a saved session
  -d, --delete <name> Delete a saved session from index
  -h, --help          Show this help

Options:
  -y, --force         Skip confirmation prompt (for -d)

Examples:
  /chat -s my-session
  /chat -l
  /chat -r my-session
  /chat -d my-session
  /chat -d my-session -y  # Delete without confirmation
```
