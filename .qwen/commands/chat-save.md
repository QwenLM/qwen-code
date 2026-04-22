# chat-save.md — Save Current Session

1. Validate `{{name}}`: `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`. Invalid → error, stop.
2. Read `.qwen/chat-index.json` (project root, NOT `~/.qwen/`). File not found → `{}`. **JSON parse error → output `"chat-index.json is malformed. Fix it manually before saving."` and stop. Do NOT overwrite.**
3. If `{{name}}` in index → ask "Overwrite? (yes/no)". ≠ yes → stop.
4. Session ID = the **currently active** session ID from the runtime context (e.g., the session this `/chat` command is running in). Do NOT use filesystem mtime to guess. If unavailable from context, fall back to the newest `.jsonl` in `~/.qwen/projects/<hash>/chats/` and warn: `"Warning: Using most recent session by file time. If this is wrong, resume the target session first."`. None → "No active session.", stop.
5. Add or update `{{name}}` key in existing index object. Write back (2-space indent, ensure `.qwen/` exists).
6. Output: `Saved: {{name}} → <id>` (or `Overwritten: ...`)
