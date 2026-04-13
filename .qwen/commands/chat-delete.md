1. Validate `{{name}}` (Common rules).
2. Look up ID in index (`.qwen/chat-index.json` in project root, NOT `~/.qwen/`). Missing → show list, stop.
3. Ask for **confirmation**: "Delete session '{{name}}'? (yes/no)". ≠ yes → stop.
4. Remove `{{name}}` from index, write back.
5. Output: `Session "{{name}}" removed from index.` + note: "Session file NOT deleted."

**Important**: The index is stored in the **current project's root directory**, NOT the user's home directory.
