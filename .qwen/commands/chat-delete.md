---
description: Delete a saved session by name. Usage: /chat-delete <name>
---

Please delete the session named "{{args}}".

Follow these steps:

1. Validate the session name "{{args}}":
   - Must match: `^[a-zA-Z0-9_.-]+$`
   - Must NOT be: `.`, `..`, `__proto__`, `constructor`, `prototype`
   - If invalid, output an error message and stop.

2. Look up the session ID:
   - Read `.qwen/chat-index.json` from the project root
   - Find the session ID mapped to "{{args}}"
   - If not found, tell the user: 'Session "{{args}}" not found.' and stop.

3. Check for shared references:
   - Count how many other names in the index point to the same session ID
   - If other names reference this session, warn the user but continue (only this name will be removed from the index, the session file will be kept)

4. Ask for confirmation:
   - Tell the user: 'Are you sure you want to delete session "{{args}}"? This action cannot be undone.'
   - **Do NOT proceed without explicit user confirmation.**

5. After confirmation, perform deletion:
   - Remove "{{args}}" from the index
   - Write the updated index back to `.qwen/chat-index.json`
   - If NO other names reference this session ID, also delete the session data file
   - If other names still reference it, only remove from the index (keep the file)

6. Confirm:
   - If the session file was also deleted: 'Session "{{args}}" deleted (including data file).'
   - If only the name was removed: 'Session "{{args}}" removed from index. Session file kept (referenced by other names).'
