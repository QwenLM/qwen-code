# chat-list.md — List All Saved Sessions

## What this command does

Reads `.qwen/chat-index.json` and displays each name→ID mapping in a readable format.

## Why this exists

Users need to see what sessions they've saved before deciding which to resume or delete.

## Steps

### 1. Read index

- `.qwen/chat-index.json` (project root, NOT runtime base). Missing/empty → `"No saved sessions."`
- **Malformed JSON handling**: If the file contains invalid JSON (e.g., truncated, corrupted), output `"chat-index.json is malformed. Fix it manually before listing."` and **stop**. Do NOT treat as empty.
- Why: Same protection as save command — corrupt index must not be silently replaced or misread.

### 2. Display

- One line per session, sorted alphabetically: `• <name> (ID: <first8>...)`
- Why truncated ID: UUIDs are 36 chars. First 8 are enough for visual identification.

## Note

- **Validation inherited from common rules**: `^[a-zA-Z0-9_.-]+$`, ≤128, reserved names (`.`, `..`, `__proto__`, `constructor`, `prototype`)
