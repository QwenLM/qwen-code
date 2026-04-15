# chat-save.md — Save Current Session

1. Validate `{{name}}`: `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`. Invalid → error, stop.
2. Read `.qwen/chat-index.json` (project root, NOT `~/.qwen/`). Missing → `{}`.
3. If `{{name}}` in index → ask "Overwrite? (yes/no)". ≠ yes → stop.
4. Session ID = newest `.jsonl` filename (without extension) in `~/.qwen/projects/<hash>/chats/`. None → "No active session.", stop.
5. Add or update `{{name}}` key in existing index object. Write back (2-space indent, ensure `.qwen/` exists).
6. Output: `Saved: {{name}} → <id>` (or `Overwritten: ...`)
