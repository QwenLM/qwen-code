# chat-save.md — Save Current Session

**Note**: Direct invocation (`/chat-save name`) bypasses the router's argument parsing, locale detection, and name validation. Use `/chat -s name` instead.

1. Validate `{{name}}`: `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`. Invalid → error, stop.
2. Read `.qwen/chat-index.json` (project root, NOT runtime base). File not found → `{}`. **JSON parse error → output `"chat-index.json is malformed. Fix it manually before saving."` and stop. Do NOT overwrite.**
3. If `{{name}}` in index → ask "Overwrite? (yes/no)". ≠ yes → stop.
4. Session ID = **newest `.jsonl` file by modification time** in `<runtimeBase>/projects/<sanitizeCwd>/chats/`. The filename (without `.jsonl`) IS the session UUID. ⚠️ **IMPORTANT**: If wrong session is saved, resume the target session first, then run `/chat -s`. No .jsonl found → "No session found. Start a conversation first.", stop.
5. **Verify session belongs to current project**: Read the first line of the selected `.jsonl` file.
   - If JSON has no `cwd` field → skip verification (legacy session, allow save).
   - First line not valid JSON → skip verification (corrupt session, allow save with warning "Warning: session file corrupt, skipping project verification.").
   - Apply `sanitizeCwd(<cwd>)` and compare with current project's `<sanitizeCwd>`. If they don't match → "Error: Selected session belongs to another project. Aborted. Please resume the session from its original project first.", stop.
6. Add or update `{{name}}` key in existing index object. **Write atomically**: write to `.qwen/.chat-index.json.tmp` first, then rename/move to `.qwen/chat-index.json`. Do NOT write directly to the index file.
7. Output: `Saved: {{name}} → <id>` (or `Overwritten: ...`)

**Runtime Base Resolution** and **sanitizeCwd** details: (See chat.md Common Rules.)
