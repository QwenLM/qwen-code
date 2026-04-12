1. Validate `{{name}}`: regex `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`. Invalid → error, stop.
2. Read `.qwen/chat-index.json`. Missing → `{}`.
3. If `{{name}}` in index → ask "Overwrite? (yes/no)". ≠ yes → stop.
4. Session ID = newest `.jsonl` filename in `~/.qwen/projects/<hash>/chats/`. None → error "No active session.", stop.
5. Write `{"{{name}}":"<id>"}` to index (2-space indent, ensure `.qwen/` exists).
6. Output: `Saved: {{name}} → <id>` (or `Overwritten: ...`)
