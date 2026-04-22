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

- **Preferred method**: Use the session ID from the **current runtime context** (the session this `/chat` command is running in). This is reliable and always refers to the conversation the user is actually using.
- Directory: `~/.qwen/projects/<hash>/chats/`
  - `<hash>` = SHA-256 of the full project root path (normalized to lowercase on Windows).
- **Fallback method**: If the runtime context does not expose a session ID, find the most recently modified `.jsonl` file in the chats directory. In this case, **output a warning**: `"Warning: Using most recent session by file time. If this is wrong, resume the target session first."`
- The filename (without `.jsonl` extension) IS the session UUID.
- If no `.jsonl` file is found: output `"No active session found. Please start a conversation first."` and stop.
- Why: Using `newest .jsonl` by mtime is unreliable when multiple sessions exist — it may bind the name to a different conversation than the one the user intends. Runtime context is authoritative; filesystem mtime is a last resort with an explicit warning.

### 5. Write to Index

- Add or update the entry: `{"{{name}}": "<uuid>"}`
- Write back to `.qwen/chat-index.json` with 2-space indent formatting.
- Ensure the `.qwen/` directory exists first (create if needed) **in the project root**.
- Why: 2-space indent makes the file human-readable for manual inspection.

### 6. Confirm

- New entry: Output `Saved: {{name}} → <uuid>`
- Overwritten: Output `Overwritten: {{name}} → <uuid>`
