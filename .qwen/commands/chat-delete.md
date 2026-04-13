Removes the mapping between a human-readable name and a session UUID from `.qwen/chat-index.json`.
It does **NOT** delete the actual session file (`~/.qwen/projects/<hash>/chats/<sessionId>.jsonl`). The session data remains on disk — only the name reference is removed.

- **Safety**: Accidental deletion of session data is irreversible. Removing a name reference is low-risk and can be undone by re-saving.
- **Shared references**: Multiple names can point to the same session UUID. Deleting one name should not destroy data that another name still references.
- **Future cleanup**: A separate "purge orphaned sessions" command could be added later to safely delete unreferenced session files.
  Same rules as `chat-save.md` and `chat-resume.md`.
- Read `.qwen/chat-index.json`
- If `{{name}}` not found: display saved sessions list + usage hint, then stop.
- Prompt: `"Delete session '{{name}}'? (yes/no)"`
- If response ≠ `"yes"`: stop.
- Delete the key `{{name}}` from the index object.
- Write updated JSON back to `.qwen/chat-index.json`.
- Output: `Session "{{name}}" removed from index.`
- Add note: `Session file NOT deleted.`
