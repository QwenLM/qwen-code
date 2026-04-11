---
description: Resume a saved session by name. Usage: /chat-resume <name>
---

Please resume the session named "{{args}}".

Follow these steps:

1. Validate the session name "{{args}}":
   - Must match: `^[a-zA-Z0-9_.-]+$`
   - Must NOT be: `.`, `..`, `__proto__`, `constructor`, `prototype`
   - If invalid, output an error message and stop.

2. Look up the session ID:
   - Read `.qwen/chat-index.json` from the project root
   - Find the session ID mapped to "{{args}}"
   - If not found, tell the user: 'Session "{{args}}" not found. Use /chat-list to see available sessions.'

3. Verify the session file exists:
   - Check that the session data file exists in `.qwen/projects/` or wherever sessions are stored
   - If the file is missing, tell the user the session data may have been deleted

4. Resume the session:
   - If everything checks out, tell the user: 'Resuming session "{{args}}" (ID: <sessionId>)'
   - The application should then load the session history and continue from where it left off
