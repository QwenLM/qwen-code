Maps a user-chosen name (e.g., `auth-refactor`) to the current session's UUID (e.g., `2ea864df-...`) in the project's session index file.
Session IDs are long UUIDs that are hard to remember. This command lets users tag sessions with meaningful names for easy later retrieval via `/chat -r <name>`.

- **Regex check**: `^[a-zA-Z0-9_.-]+$`
  - Why: Prevents path traversal (`../`), shell injection (`$(...)`), and JSON-breaking characters.
- **Reserved name check**: Must NOT be `.`, `..`, `__proto__`, `constructor`, `prototype`
  - Why: `.` and `..` are directory traversal risks. `__proto__`/`constructor`/`prototype` cause JavaScript prototype pollution — setting `index['__proto__']` corrupts the object's prototype chain rather than creating an own property, which silently breaks `Object.keys()` and `JSON.stringify()`.
- **Length check**: ≤ 128 characters
  - Why: Prevents abuse and keeps the index file readable.
- **On failure**: Output error message explaining the rules, then stop.
- File: `.qwen/chat-index.json` (project root)
- If the file doesn't exist: treat as empty object `{}`
- If `{{name}}` is already a key in the index:
  - Ask the user: `'Session "{{name}}" already exists. Overwrite? (yes/no)'`
  - If the response is NOT exactly `"yes"`: stop and confirm cancellation.
- Directory: `~/.qwen/projects/<hash>/chats/`
  - `<hash>` = current working directory's full path, with all `\` and `/` replaced by `-`, converted to lowercase.
  - Example: `D:\code\qwen-code` → `d--code-qwen-code`
- Look for the most recently modified `.jsonl` file.
- The filename (without `.jsonl` extension) IS the session UUID.
- If no `.jsonl` file is found: output `"No active session found. Please start a conversation first."` and stop.
- Add or update the entry: `{"{{name}}": "<uuid>"}`
- Write back to `.qwen/chat-index.json` with 2-space indent formatting.
- Ensure the `.qwen/` directory exists first (create if needed).
- New entry: Output `Saved: {{name}} → <uuid>`
- Overwritten: Output `Overwritten: {{name}} → <uuid>`
