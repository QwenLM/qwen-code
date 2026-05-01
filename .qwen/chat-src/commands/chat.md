---
description: Chat session manager. /chat [-s|-l|-r|-d|-h] [name]
---

# chat.md — Session Command Router

## Architecture

This is the **entry point** for all `/chat` commands. It does three things:

1. Detects the user's environment (language, OS)
2. Parses the command arguments
3. Routes to the appropriate sub-command file

## Why we split into sub-command files

Qwen Code loads command files entirely into the LLM context. A single monolithic
file (~6KB, ~2000 tokens) wastes tokens on every invocation. By splitting into a
small router (~1KB) + lazy-loaded sub-commands (~0.5KB each), we save 50-75% of
token consumption depending on which sub-command is used.

**How routing works:** The AI reads this file, detects the flag, then reads the
corresponding sub-command file and executes its logic. This has been verified to
work in practice.

---

## Step 1: Detect Environment

### Language

Run `node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"` to
get system locale. Use the language code (first 2 chars, e.g., "en", "zh", "ja")
to determine response language. If locale detection fails, match the language
the user used in their prompt.

**Why use system locale instead of settings.json?** Reading the full settings file
could expose sensitive data (API keys, tokens, MCP server configs). System locale
is a safe, minimal alternative that only reveals language preference.

**Why not hardcode English?** Users worldwide prefer their native language. The AI
can respond in any language — we just need to tell it which one.

### OS Detection (only needed for `-r`/`--resume`)

**Important**: OS detection is ONLY needed when the user runs `/chat -r` (resume).
For other flags (`-s`, `-l`, `-d`, `-h`), skip this step entirely.

When `-r` is detected, run `node -e "console.log(process.platform)"`. This works across all shells (CMD, PowerShell, bash, zsh, fish, nushell).

- `win32` → Windows
- `linux` → Linux (including WSL — see below)
- `darwin` → macOS

**Why detect OS?** The `--resume` command needs to open a new terminal window.
Each OS has different commands for this. We detect once here and pass the result
to the sub-command.

**Why `node -e`?** `echo %OS%` only works in CMD, not PowerShell. `$OSTYPE` only works in bash/zsh, not fish or nushell. Using Node.js ensures consistent behavior across all shell environments.

**WSL Detection**: WSL users are running on Windows but report as Linux to Node.js. When platform is `linux`, additionally read `/proc/version`. If it contains "Microsoft" or "WSL" (case-insensitive), treat as Windows for resume — the sub-command will use Windows Terminal or CMD.

**Why handle WSL?** Many Windows developers use WSL. Without this check, resume would try to launch Linux terminals (gnome-terminal, xterm) which either fail (no X display) or pop up windows the user can't reach.

---

## Step 2: Parse Arguments

Split `{{args}}` by whitespace. First token = flag. Remaining = raw_args.

## Step 3: Validate Arguments (before routing)

### For delete (`-d`):

1. Parse raw_args to extract name: Filter out `-y` and `--force` flags first, the first remaining token is the name.
2. If name is missing, empty, or whitespace only → **Show Help immediately, STOP**
3. If extra non-flag tokens remain after the first name → **Show Help immediately, STOP**
4. If `-y` or `--force` was found → Set `forceDelete = true`

**Why reject extra tokens?** For delete, `/chat -d good-name unexpected` should error, not silently operate on "good-name" while ignoring the typo. This prevents user mistakes from going unnoticed.

### For save/resume (`-s`, `-r`):

1. Parse raw_args to extract name: the first remaining token is the name.
   - **Reject any token starting with `-`** (e.g., `-y`, `--force` are delete-only options)
   - If extra non-flag tokens remain after the first name → Output: `Error: Unexpected token: <token>. /chat -s|-r takes only a single name.` and STOP
2. If name is missing, empty, or whitespace only → **Show Help immediately, STOP**

**Why this rule?** Save and resume have no options. If a user types `/chat -s my-name -y` (copy-paste error from delete), we should reject it rather than silently ignoring `-y`.

---

## Step 4: Route to Sub-Command

Based on the parsed flag, read the corresponding file and execute its logic:

| Flag                                | Sub-Command File  | Description                                         |
| ----------------------------------- | ----------------- | --------------------------------------------------- |
| `-s`, `--save`                      | `chat-save.md`    | Save current session with a human-readable name     |
| `-l`, `--list`                      | `chat-list.md`    | List all saved sessions for this project            |
| `-r`, `--resume`                    | `chat-resume.md`  | Resume a saved session in a new window              |
| `-d`, `--delete`                    | `chat-delete.md`  | Remove a session name from the index (not the file) |
| `-h`, `--help`, empty, unrecognized | (show help below) | Display usage information                           |

## Common Rules (inherited by all sub-commands)

These rules are defined here once and inherited by all sub-commands:

| Rule                  | Value                                                                                                                                                     | Rationale                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Valid name regex**  | `^[a-zA-Z0-9_.-]+$`                                                                                                                                       | Only safe characters; no spaces, no special chars that could break file paths                                     |
| **Reserved names**    | `.`, `..`, `__proto__`, `constructor`, `prototype`                                                                                                        | `.` and `..` are path traversal risks; `__proto__`/`constructor`/`prototype` cause JavaScript prototype pollution |
| **Max length**        | 128 characters                                                                                                                                            | Prevents abuse and keeps index file readable                                                                      |
| **Index path**        | `.qwen/chat-index.json` (project root, NOT user home)                                                                                                     | Project-scoped isolation; each project has its own session namespace                                              |
| **Index format**      | `{"name": "sessionId", ...}`                                                                                                                              | Simple flat key-value; no nested objects to minimize read/write complexity                                        |
| **Session ID source** | Filename (no extension) of `.jsonl` in `<runtimeBase>/projects/<sanitizeCwd>/chats/`. runtimeBase priority: `$QWEN_RUNTIME_DIR` > `~/.qwen` (default)     | The session storage uses JSONL format; sanitizeCwd replaces non-alphanumerics with -                              |
| **Project dir**       | `sanitizeCwd(projectRoot)` replaces all non-alphanumeric characters with `-`. On Windows, also lowercase. E.g., `D:\code\qwen-code` → `d--code-qwen-code` | Deterministic mapping from project path to storage directory using path sanitization                              |

**Important**: The index file (`.qwen/chat-index.json`) is stored in the **project root**, NOT in the user's home directory. Session files are stored under `<runtimeBase>/projects/<sanitizeCwd>/chats/`. This keeps session names project-scoped.

**Note on settings.json**: If user has configured `advanced.runtimeOutputDir` in settings.json, sessions are stored under that path. /chat commands cannot read settings.json (credential leak risk) and will not find those sessions.

---

## Help Text

Display when the user provides no flag or an unrecognized one. **Show this immediately when `{{args}}` is empty or flag is `-h`/`--help`:**

```
Chat Session Manager

Usage: /chat <flag> [name]

Flags:
  -s, --save <name>   Save current session with a name
  -l, --list          List all saved sessions
  -r, --resume <name> Resume a saved session
  -d, --delete <name> Delete a saved session from index (-y/--force to skip confirmation)
  -h, --help          Show this help

Examples:
  /chat -s my-session
  /chat -l
  /chat -r my-session
  /chat -d my-session
```
