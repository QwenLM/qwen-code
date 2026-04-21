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
- If the file doesn't exist: treat as empty object `{}`
- Why: This is the first write for many projects; we create the file only when needed.
- **Important**: The index is stored in the **current project's root directory**, NOT the user's home directory. This keeps session names project-scoped.

### 3. Check for Overwrite

- If `{{name}}` is already a key in the index:
  - Ask the user: `'Session "{{name}}" already exists. Overwrite? (yes/no)'`
  - If the response is NOT exactly `"yes"`: stop and confirm cancellation.
- Why: Prevents accidental overwrites. Users may have saved important work under that name.

### 4. Find the Current Session ID

- Directory: `~/.qwen/projects/<hash>/chats/`
  - `<hash>` = SHA-256 of the full project root path (normalized to lowercase on Windows).
- Look for the most recently modified `.jsonl` file.
- The filename (without `.jsonl` extension) IS the session UUID.
- If no `.jsonl` file is found: output `"No active session found. Please start a conversation first."` and stop.
- Why: The session storage format is JSONL (line-delimited JSON). Each session is a file named by its UUID. We find the active session by scanning for the newest file in the project's chats directory.

### 5. Write to Index

- Add or update the entry: `{"{{name}}": "<uuid>"}`
- Write back to `.qwen/chat-index.json` with 2-space indent formatting.
- Ensure the `.qwen/` directory exists first (create if needed) **in the project root**.
- Why: 2-space indent makes the file human-readable for manual inspection.

### 6. Confirm

- New entry: Output `Saved: {{name}} → <uuid>`
- Overwritten: Output `Overwritten: {{name}} → <uuid>`
