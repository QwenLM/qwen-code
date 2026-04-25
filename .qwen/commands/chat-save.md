# chat-save.md — Save Current Session
1. Validate `{{name}}`: `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`. Invalid → error, stop.
2. Read `.qwen/chat-index.json` (project root).
3. If `{{name}}` exists in index: load old session messages, append new messages from current conversation, save back to `sessions/{{name}}.jsonl`.
4. Else: create new index entry `{{name}}` → `sessions/{{name}}.jsonl` (the session UUID is derived from this filename).
5. Write `.qwen/chat-index.json`.
6. Save current conversation to `sessions/{{name}}.jsonl`.
7. Done. Show: `✅ Session saved as "{{name}}"`.
