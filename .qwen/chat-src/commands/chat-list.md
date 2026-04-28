# chat-list.md — List All Saved Sessions

## What this command does

Reads `.qwen/chat-index.json` and displays each name→ID mapping in a readable format.

## Why this exists

Users need to see what sessions they've saved before deciding which to resume or delete.

## Steps

### 1. Read index

- `.qwen/chat-index.json`. Missing/empty → `"No saved sessions."`

### 2. Display

- One line per session, sorted alphabetically: `• <name> (ID: <first8>...)`
- Why truncated ID: UUIDs are 36 chars. First 8 are enough for visual identification.

## Note

- **Validation inherited from common rules**: `^[a-zA-Z0-9_.-]+$`, ≤128, reserved names (`.`, `..`, `__proto__`, `constructor`, `prototype`)
