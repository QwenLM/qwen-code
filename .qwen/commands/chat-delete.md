# chat-delete.md — Remove a Session Name from Index
## Step 0: MUST Ask for Confirmation (DO NOT SKIP)
**⚠️ CRITICAL: Before ANY deletion, you MUST:**
1. Use the `confirm_action` built-in command to get user confirmation
2. Only proceed if user confirms with "yes"
3. If user cancels or responds with anything else, stop and show: `❌ Deletion cancelled`

## Step 1: Validate Name
1. Validate `{{name}}`: `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`. Invalid → error, stop.

## Step 2: Read Index & Delete
1. Read `.qwen/chat-index.json` (project root).
2. If `{{name}}` NOT found in index: show `❌ Session "{{name}}" not found`, stop.
3. Remove `{{name}}` entry from index.
4. Delete file `sessions/{{name}}.jsonl` (if exists).
5. Write `.qwen/chat-index.json`.
6. Done. Show: `✅ Session "{{name}}" deleted`.
