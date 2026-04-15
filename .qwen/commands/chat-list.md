# chat-list.md — List All Saved Sessions

1. Read `.qwen/chat-index.json` (project root, NOT `~/.qwen/`). Missing/empty → "No saved sessions."
2. Display sorted alphabetically: `• <name> (ID: <first8>...)`

**Validation inherited from common rules**: `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`.

**Important**: The index is stored in the **current project's root directory**, NOT the user's home directory.
