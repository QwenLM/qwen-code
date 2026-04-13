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

Read `~/.qwen/settings.json` (Windows: `%USERPROFILE%\.qwen\settings.json`).
Look for `general.language`. Respond in that language. If not found, match the
language the user used in their prompt.

**Why not hardcode English?** Users worldwide prefer their native language. The AI
can respond in any language — we just need to tell it which one.

### OS Detection

Run `echo %OS%` (Windows) or `echo $OSTYPE` (Linux/macOS).

- `Windows_NT` → Windows
- `linux-*` → Linux
- `darwin*` → macOS

**Why detect OS?** The `--resume` command needs to open a new terminal window.
Each OS has different commands for this. We detect once here and pass the result
to the sub-command.

## Step 2: Parse Arguments

Split `{{args}}` by whitespace. First token = flag. Remaining tokens = name.

## Step 3: Route to Sub-Command

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

| Rule                  | Value                                                                                                              | Rationale                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Valid name regex**  | `^[a-zA-Z0-9_.-]+$`                                                                                                | Only safe characters; no spaces, no special chars that could break file paths                                     |
| **Reserved names**    | `.`, `..`, `__proto__`, `constructor`, `prototype`                                                                 | `.` and `..` are path traversal risks; `__proto__`/`constructor`/`prototype` cause JavaScript prototype pollution |
| **Max length**        | 128 characters                                                                                                     | Prevents abuse and keeps index file readable                                                                      |
| **Index path**        | `.qwen/chat-index.json` (project root, NOT user home)                                                              | Project-scoped isolation; each project has its own session namespace                                              |
| **Index format**      | `{"name": "sessionId", ...}`                                                                                       | Simple flat key-value; no nested objects to minimize read/write complexity                                        |
| **Session ID source** | Filename (no extension) of `.jsonl` in `~/.qwen/projects/<hash>/chats/`                                            | The session storage uses JSONL format; the UUID filename IS the session ID                                        |
| **Hash calculation**  | Full cwd path, replace `\` and `/` with `-`, convert to lowercase. E.g., `D:\code\qwen-code` → `d--code-qwen-code` | Deterministic mapping from project path to storage directory                                                      |

**Important**: The index file (`.qwen/chat-index.json`) is stored in the **project root**, NOT in the user's home directory. Session files are stored in the user home (`~/.qwen/projects/<hash>/chats/`). This keeps session names project-scoped.

## Help Text

Display when the user provides no flag or an unrecognized one. **Show this immediately when `{{args}}` is empty or flag is `-h`/`--help`:**

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
