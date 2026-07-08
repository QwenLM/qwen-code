# chat-list.md — List All Saved Sessions

**Note**: Direct invocation (`/chat-list`) bypasses the router's argument parsing, locale detection, and name validation. Use `/chat -l` instead.

1. Read `.qwen/chat-index.json` (project root, NOT runtime base). File not found → "No saved sessions." **JSON parse error → output `"chat-index.json is malformed. Fix it manually before listing."` and stop. Do NOT treat as empty.**
2. Display sorted alphabetically: `• <name> (ID: <first8>...)`

**Validation inherited from common rules**: `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`.

**Important**: The index is stored in the **current project's root directory**, NOT the user's home directory or runtime base.
