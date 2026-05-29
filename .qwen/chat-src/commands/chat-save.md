# chat-save.md — Save Current Session with a Name

## What this command does

Maps a human-readable name (e.g., `auth-refactor`) to the current session's UUID
in `.qwen/chat-index.json`.

## Why this exists

Session IDs are long UUIDs (`2ea864df-ffed-444e-b472-190a8f83b552`). Humans prefer
meaningful names. This command creates the mapping so users can later resume with
`/chat -r auth-refactor` instead of typing the UUID.

## Steps

### 1. Validate `{{name}}`

- **Regex check**: `^[a-zA-Z0-9_.-]+$`
  - Why: Prevents path traversal (`../`), shell injection (`$(...)`), and JSON-breaking characters.
- **Reserved name check**: Must NOT be `.`, `..`, `__proto__`, `constructor`, `prototype`
  - Why: `.` and `..` are directory traversal risks. `__proto__`/`constructor`/`prototype` cause JavaScript prototype pollution — setting `index['__proto__']` corrupts the object's prototype chain rather than creating an own property, which silently breaks `Object.keys()` and `JSON.stringify()`.
- **Length check**: ≤ 128 characters
  - Why: Prevents abuse and keeps the index file readable.
- **On failure**: Output error message explaining the rules, then stop.

### 2. Read the Index

- File: `.qwen/chat-index.json` (project root, NOT `~/.qwen/`)
- If the file doesn't exist (ENOENT): treat as empty object `{}`
- If the file exists but contains malformed JSON: output `"chat-index.json is malformed. Fix it manually before saving."` and **stop**. Do NOT fall back to `{}`, as this would silently overwrite existing saved names.
- Why: This is the first write for many projects; we create the file only when needed. However, a corrupt index must not be silently replaced — existing mappings would be lost.
- **Important**: The index is stored in the **current project's root directory**, NOT the user's home directory. This keeps session names project-scoped.

### 3. Check for Overwrite

- If `{{name}}` is already a key in the index:
  - Ask the user: `'Session "{{name}}" already exists. Overwrite? (yes/no)'`
  - If the response is NOT exactly `"yes"`: stop and confirm cancellation.
- Why: Prevents accidental overwrites. Users may have saved important work under that name.

### 4. Find the Current Session ID

- **Method**: Find the most recently modified `.jsonl` file in `<runtimeBase>/projects/<sanitizeCwd>/chats/`. The filename (without `.jsonl` extension) IS the session UUID.
  - `<sanitizeCwd>` = `sanitizeCwd(projectRoot)`, which replaces all non-alphanumeric characters with `-`. On Windows, also lowercase the path first. E.g., `D:\code\qwen-code` → `d--code-qwen-code`
  - **runtimeBase resolution** (in priority order):
    - `$QWEN_RUNTIME_DIR` (if set)
    - `~/.qwen` (default fallback)
  - **Note**: If user has configured `advanced.runtimeOutputDir` in settings.json, sessions are stored under that path. /chat commands cannot read settings.json (credential leak risk) and will not find those sessions.
- ⚠️ **IMPORTANT**: If you think the wrong session might be saved, **resume the target session first**, then run `/chat -s`. This ensures you save the intended conversation.
- If no `.jsonl` file is found: output `"No session found. Start a conversation first."` and stop.
- **Why this method?**: File-based custom commands cannot access the active chat UUID directly. Using mtime is the only available approach. The explicit warning helps users correct mistakes.

### 5. Verify Session Belongs to Current Project

- **Read the first line** of the selected `.jsonl` file
- If JSON has no `cwd` field → skip verification (legacy session, allow save)
- Apply `sanitizeCwd(<cwd>)` and compare with current project's `<sanitizeCwd>`
- If they don't match → output `"Error: Selected session belongs to another project. Aborted. Please resume the session from its original project first."` and stop
- Why: Without this check, when sanitizeCwd collides across different project paths, chat-save could store a session ID from a different project. Then chat-resume would reject it with "Session belongs to another project."

### 6. Write to Index

- Add or update the entry: `{"{{name}}": "<uuid>"}`
- Write back to `.qwen/chat-index.json` with 2-space indent formatting.
- Ensure the `.qwen/` directory exists first (create if needed) **in the project root**.
- Why: 2-space indent makes the file human-readable for manual inspection.

### 6. Confirm

- New entry: Output `Saved: {{name}} → <uuid>`
- Overwritten: Output `Overwritten: {{name}} → <uuid>`
