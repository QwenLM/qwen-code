# chat-delete.md — Remove a Session Name from the Index

## What this command does

Removes the mapping between a human-readable name and a session UUID from `.qwen/chat-index.json`.

## What this does NOT do

It does **NOT** delete the actual session file (`~/.qwen/projects/<hash>/chats/<sessionId>.jsonl`). The session data remains on disk — only the name reference is removed.

## Why this design?

- **Safety**: Accidental deletion of session data is irreversible. Removing a name reference is low-risk and can be undone by re-saving.
- **Shared references**: Multiple names can point to the same session UUID. Deleting one name should not destroy data that another name still references.
- **Future cleanup**: A separate "purge orphaned sessions" command could be added later to safely delete unreferenced session files.

## Steps

### 1. Validate `{{name}}`

Same rules as `chat-save.md` and `chat-resume.md`.

### 2. Look Up Session ID

- Read `.qwen/chat-index.json`
- If `{{name}}` not found: display saved sessions list + usage hint, then stop.
- Why: Users often typo session names; showing available sessions helps them correct the mistake.

### 3. Ask for Confirmation

- Prompt: `"Delete session '{{name}}'? (yes/no)"`
- If response ≠ `"yes"`: stop.
- Why: Name deletion is immediate and has no undo. Confirmation prevents accidental removal from typos.

### 4. Remove from Index

- Delete the key `{{name}}` from the index object.
- Write updated JSON back to `.qwen/chat-index.json`.

### 5. Confirm

- Output: `Session "{{name}}" removed from saved sessions index.`
- Add note: `This only removes the saved name reference. The actual session history file is NOT deleted.`

## Validation Rules

- **Regex**: `^[a-zA-Z0-9_.-]+$`
- **Reserved**: `.`, `..`, `__proto__`, `constructor`, `prototype`
- **Max length**: ≤ 128 characters
